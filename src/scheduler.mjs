// 单跑队列 + 定时任务。同一时刻只允许一个 run，其它一律排队。
// 队列与 cron 定义都落盘在 state/queue.json，重启后不丢。

import fs from 'node:fs';
import path from 'node:path';

const CRON_CHARS = /^[0-9*,\-/]+$/;
const CRON_TZ_RE = /^[A-Za-z_]+(?:\/[A-Za-z_0-9+.-]+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2}$/;

export class RunQueue {
	/**
	 * @param {{path:string, log?:Function, isBusy:()=>boolean, startTask:(item:any)=>Promise<any>,
	 *   onStarted?:(item:any,res:any)=>void, onCompleted?:(item:any,info:any)=>void, onFailed?:(item:any,err:any)=>void,
	 *   settings?:{tickMs?:number,minRunMs?:number,hardTimeoutMs?:number}}} opts
	 */
	constructor(opts) {
		this.path = opts.path;
		this.log = opts.log ?? (() => {});
		this.isBusy = opts.isBusy ?? (() => false);
		this.startTask = opts.startTask ?? (async () => ({ success: false, error: '未提供 startTask' }));
		this.onStarted = opts.onStarted ?? (() => {});
		this.onCompleted = opts.onCompleted ?? (() => {});
		this.onFailed = opts.onFailed ?? (() => {});
		this.settings = { tickMs: 2000, minRunMs: 3000, hardTimeoutMs: 2 * 60 * 60_000, ...(opts.settings ?? {}) };
		this.items = [];
		this.crons = [];
		this.running = null; // {item, startedAt}
		this.seq = 0;
		this.timer = null;
		this.stopped = true;
		this.listeners = new Set();
		this.load();
	}

	on(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	#emit(evt) {
		for (const l of [...this.listeners]) {
			try {
				l(evt);
			} catch (err) {
				this.log(`[queue] 监听器异常：${err?.message}`);
			}
		}
	}

	// ---- 持久化 ----

	load() {
		try {
			const raw = JSON.parse(fs.readFileSync(this.path, 'utf8'));
			if (Array.isArray(raw.items)) this.items = raw.items.filter((i) => i && typeof i.text === 'string');
			if (Array.isArray(raw.crons)) this.crons = raw.crons.filter((c) => c && (c.kind === 'cron' || c.kind === 'once'));
			this.seq = Number(raw.seq ?? 0);
			// 一次性任务里已过期的绝对时间：保留（用户可能重启补跑），由 tick 判断
			this.log(`[queue] 载入 ${this.items.length} 条队列 / ${this.crons.length} 条定时`);
		} catch (err) {
			if (err?.code !== 'ENOENT') this.log(`[queue] 载入失败：${err?.message}`);
		}
	}

	save() {
		try {
			fs.mkdirSync(path.dirname(this.path), { recursive: true });
			fs.writeFileSync(this.path, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), seq: this.seq, items: this.items, crons: this.crons }, null, 2));
		} catch (err) {
			this.log(`[queue] 保存失败：${err?.message}`);
		}
	}

	// ---- 队列 ----

	enqueue(item) {
		const entry = {
			id: `q${Date.now().toString(36)}${(++this.seq).toString(36)}`,
			kind: item.kind ?? 'user',
			text: String(item.text ?? ''),
			images: Array.isArray(item.images) ? item.images : [],
			title: item.title ?? (String(item.text ?? '').slice(0, 40) || '(空)'),
			source: item.source ?? null,
			createdAt: new Date().toISOString(),
		};
		this.items.push(entry);
		this.save();
		this.#emit({ type: 'queue_changed', items: this.list(), running: this.runningItem() });
		return entry;
	}

	list() {
		return this.items.map((i) => ({ ...i }));
	}

	runningItem() {
		return this.running ? { ...this.running.item, startedAt: new Date(this.running.startedAt).toISOString() } : null;
	}

	remove(id) {
		const before = this.items.length;
		this.items = this.items.filter((i) => i.id !== id);
		if (this.items.length !== before) {
			this.save();
			this.#emit({ type: 'queue_changed', items: this.list(), running: this.runningItem() });
			return true;
		}
		return false;
	}

	clear() {
		this.items = [];
		this.save();
		this.#emit({ type: 'queue_changed', items: [], running: this.runningItem() });
	}

	status() {
		return { running: this.runningItem(), items: this.list(), crons: this.cronList() };
	}

	// ---- 定时任务 ----

	cronList() {
		return this.crons.map((c) => ({ ...c, nextAt: this.#nextCronAt(c, Date.now()) }));
	}

	cronAdd(spec) {
		const base = {
			id: `c${Date.now().toString(36)}${(++this.seq).toString(36)}`,
			prompt: String(spec.prompt ?? ''),
			title: spec.title ?? (String(spec.prompt ?? '').slice(0, 40) || '(定时任务)'),
			createdAt: new Date().toISOString(),
			lastFiredAt: null,
		};
		if (!base.prompt.trim()) return { error: 'prompt 不能为空' };
		if (spec.kind === 'once') {
			const at = this.#parseAt(spec.at, spec.tz ?? 'Asia/Shanghai');
			if (!at) return { error: 'once 需要绝对时间 at（例 2026-11-17T09:00 或 07:00 或 2026-11-20）' };
			this.crons.push({ ...base, kind: 'once', at, tz: spec.tz ?? 'Asia/Shanghai', repeat: !!spec.repeat });
		} else {
			const check = this.#validateCron(spec.expr);
			if (check.error) return check;
			this.crons.push({ ...base, kind: 'cron', expr: String(spec.expr).trim(), tz: this.#validTz(spec.tz) ? spec.tz : 'Asia/Shanghai' });
		}
		this.save();
		this.#emit({ type: 'queue_changed', items: this.list(), running: this.runningItem(), crons: this.cronList() });
		return { ok: true, cron: base };
	}

	cronRemove(id) {
		const before = this.crons.length;
		this.crons = this.crons.filter((c) => c.id !== id);
		if (this.crons.length !== before) {
			this.save();
			this.#emit({ type: 'queue_changed', items: this.list(), running: this.runningItem(), crons: this.cronList() });
			return true;
		}
		return false;
	}

	/**
	 * 手机端改定时任务：prompt / title / enabled / repeat / tz / expr / at / remove。
	 * 校验全部在这里做完再落盘，避免前端传个半值把 state/queue.json 写坏。
	 */
	cronPatch(id, patch = {}) {
		const cron = this.crons.find((c) => c.id === id);
		if (!cron) return { error: '没有这个定时任务' };
		if (patch.remove === true) {
			this.crons = this.crons.filter((c) => c.id !== id);
			this.save();
			this.#emit({ type: 'queue_changed', items: this.list(), running: this.runningItem(), crons: this.cronList() });
			return { ok: true, removed: true };
		}
		if ('tz' in patch && !this.#validTz(patch.tz)) return { error: '无效时区' };
		if ('prompt' in patch && !String(patch.prompt ?? '').trim()) return { error: 'prompt 不能为空' };
		if ('expr' in patch) {
			if (cron.kind !== 'cron') return { error: '一次性任务不能改 cron 表达式' };
			const check = this.#validateCron(patch.expr);
			if (check.error) return check;
		}
		let nextAt = null;
		if ('at' in patch) {
			const at = this.#parseAt(patch.at, patch.tz ?? cron.tz ?? 'Asia/Shanghai');
			if (!at) return { error: 'at 无法解析（例 2026-11-17T09:00 / 07:00 / 2026-11-20 / 毫秒时间戳）' };
			cron.at = at;
			cron.kind = 'once';
			cron.expr = null;
			nextAt = at.at ?? null;
		}
		if ('expr' in patch) cron.expr = String(patch.expr).trim();
		for (const key of ['prompt', 'title', 'enabled', 'repeat', 'tz']) {
			if (key in patch) cron[key] = patch[key];
		}
		this.save();
		this.#emit({ type: 'queue_changed', items: this.list(), running: this.runningItem(), crons: this.cronList() });
		return { ok: true, cron: { ...cron, nextAt: nextAt ?? this.#nextCronAt(cron, Date.now()) } };
	}

	#validTz(tz) {
		if (typeof tz !== 'string' || !CRON_TZ_RE.test(tz)) return false;
		try {
			new Intl.DateTimeFormat('en-US', { timeZone: tz });
			return true;
		} catch {
			return false;
		}
	}

	#validateCron(expr) {
		if (typeof expr !== 'string' || !expr.trim()) return { error: 'expr 不能为空（5 字段：分 时 日 月 周）' };
		const fields = expr.trim().split(/\s+/);
		if (fields.length !== 5) return { error: `表达式需要 5 个字段，实到 ${fields.length} 个：${expr}` };
		const limits = [
			[0, 59],
			[0, 23],
			[1, 31],
			[1, 12],
			[0, 7],
		];
		for (let i = 0; i < 5; i++) {
			const f = fields[i];
			if (!CRON_CHARS.test(f)) return { error: `第 ${i + 1} 个字段含非法字符：${f}` };
			for (const part of f.split(',')) {
				const [rangePart, stepPart] = part.split('/');
				if (stepPart !== undefined && !/^\d+$/.test(stepPart)) return { error: `步长非法：${part}` };
				if (rangePart !== '*') {
					const bounds = rangePart.split('-');
					for (const b of bounds) {
						if (!/^\d+$/.test(b)) return { error: `数值非法：${part}` };
						const n = Number(b);
						if (n < limits[i][0] || n > limits[i][1]) return { error: `超出范围 ${limits[i][0]}-${limits[i][1]}：${part}` };
					}
					if (bounds.length === 2 && Number(bounds[0]) > Number(bounds[1])) return { error: `区间反向：${part}` };
				}
			}
		}
		return { ok: true };
	}

	#parseAt(at, tz) {
		// 纯数字（毫秒或秒级时间戳）直接当绝对时刻：Date.parse("1763...") 是 NaN，
		// 所以必须在回落 Date.parse 之前先认数字（前端时间控件也可能直接传 epoch）。
		const numeric = typeof at === 'number' ? at : (/^\d{10}$|^\d{13}$/.test(String(at ?? '').trim()) ? Number(String(at).trim()) : NaN);
		if (Number.isFinite(numeric)) {
			const ms = numeric < 1e11 ? numeric * 1000 : numeric;
			return { mode: 'epoch', at: new Date(ms).toISOString(), tz };
		}
		const value = String(at ?? '').trim();
		if (!value) return null;
		if (TIME_RE.test(value)) return { mode: 'daily', time: value, tz };
		if (DATE_RE.test(value)) return { mode: 'date', date: value, time: '09:00', tz };
		const m = value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::\d{2})?(Z|[+-]\d{2}:?\d{2})?$/);
		if (m) return { mode: 'abs', date: m[1], time: `${m[2].padStart(2, '0')}:${m[3]}`, offset: m[4] ?? null, tz };
		const parsed = Date.parse(value);
		if (!Number.isNaN(parsed)) return { mode: 'epoch', at: new Date(parsed).toISOString(), tz };
		return null;
	}

	/** 某条 cron 的下一次触发时间（ISO），算不出返回 null。 */
	#nextCronAt(cron, fromMs) {
		const tz = this.#validTz(cron.tz) ? cron.tz : 'Asia/Shanghai';
		if (cron.kind === 'once') {
			const at = cron.at ?? {};
			if (at.mode === 'epoch') return at.at;
			if (at.mode === 'abs' && at.date) return this.#zonedToIso(at.date, at.time, tz);
			if (at.mode === 'daily') {
				const today = this.#zonedParts(fromMs, tz);
				let iso = this.#zonedToIso(today.date, at.time, tz);
				if (iso && Date.parse(iso) <= fromMs) iso = this.#zonedToIso(this.#shiftDate(today.date, 1), at.time, tz);
				return iso;
			}
			if (at.mode === 'date') {
				const iso = this.#zonedToIso(at.date, at.time, tz);
				return iso && Date.parse(iso) > fromMs ? iso : null;
			}
			return null;
		}
		const parts = String(cron.expr).trim().split(/\s+/);
		const sets = parts.map((f, i) => this.#expandField(f, i));
		const start = this.#zonedParts(fromMs + 60_000, tz);
		let cursor = this.#shiftDate(start.date, 0);
		let minute = start.minute;
		let hour = start.hour;
		for (let guard = 0; guard < 8000; guard++) {
			if (sets[2].has(cursor.day) && sets[3].has(cursor.month) && sets[4].has(this.#weekdayOf(cursor.date))) {
				if (sets[1].has(hour) && sets[0].has(minute)) {
					return this.#zonedToIso(cursor.date, `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, tz);
				}
			}
			minute++;
			if (minute > 59) {
				minute = 0;
				hour++;
				if (hour > 23) {
					hour = 0;
					cursor = this.#shiftDate(cursor.date, 1);
				}
			}
		}
		return null;
	}

	#expandField(field, index) {
		const [lo, hi] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]][index];
		const out = new Set();
		for (const part of field.split(',')) {
			const [rangePart, stepPart] = part.split('/');
			const step = stepPart ? Number(stepPart) : 1;
			let a = lo;
			let b = hi;
			if (rangePart !== '*') {
				const bounds = rangePart.split('-').map(Number);
				a = bounds[0];
				b = bounds.length > 1 ? bounds[1] : (step > 1 ? hi : bounds[0]);
			}
			if (index === 4 && b === 7) b = 6; // 7 == 0 == 周日
			for (let v = a; v <= b; v += step) out.add(index === 4 ? v % 7 : v);
		}
		return out;
	}

	#zonedParts(ms, tz) {
		const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
		const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
		return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.minute), hour: Number(parts.hour) % 24 };
	}

	#shiftDate(date, days) {
		const [y, m, d] = date.split('-').map(Number);
		const dt = new Date(Date.UTC(y, m - 1, d + days));
		return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
	}

	#weekdayOf(date) {
		const [y, m, d] = date.split('-').map(Number);
		return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
	}

	/** 把时区里的挂钟时间换算成绝对时刻（含 DST）。 */
	#zonedToIso(date, time, tz) {
		if (!date || !time) return null;
		const [y, mo, d] = date.split('-').map(Number);
		const [hh, mm] = time.split(':').map(Number);
		if ([y, mo, d, hh, mm].some((n) => !Number.isFinite(n))) return null;
		let guess = Date.UTC(y, mo - 1, d, hh, mm);
		for (let i = 0; i < 3; i++) {
			const p = this.#zonedParts(guess, tz);
			const [py, pm, pd] = p.date.split('-').map(Number);
			const asUtc = Date.UTC(py, pm - 1, pd, p.hour, p.minute);
			const drift = Date.UTC(y, mo - 1, d, hh, mm) - asUtc;
			if (drift === 0) return new Date(guess).toISOString();
			guess += drift;
		}
		return new Date(guess).toISOString();
	}

	// ---- 调度循环 ----

	start() {
		if (this.timer) return;
		this.stopped = false;
		this.timer = setInterval(() => this.tick(), this.settings.tickMs);
		this.log('[queue] 调度循环已启动');
		this.tick();
	}

	stop() {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		clearTimeout(this.idleRetry);
		this.idleRetry = null;
	}

	tick() {
		if (this.stopped) return;
		try {
			this.#fireDueCrons();
			if (this.running) {
				if (Date.now() - this.running.startedAt > this.settings.hardTimeoutMs) {
					this.log(`[queue] 运行超过 ${Math.round(this.settings.hardTimeoutMs / 60000)} 分钟，强制收尾`);
					this.#finish(this.running.item, { reason: 'timeout' });
					this.running = null;
				}
				return;
			}
			if (!this.items.length) return;
			if (this.isBusy()) return;
			const item = this.items.shift();
			this.running = { item, startedAt: Date.now(), sawAgentStart: false };
			this.save();
			this.#emit({ type: 'queue_changed', items: this.list(), running: this.runningItem(), crons: this.cronList() });
			void this.#launch(item);
		} catch (err) {
			this.log(`[queue] tick 异常：${err?.message}`);
			this.running = null;
		}
	}

	async #launch(item) {
		try {
			const res = await this.startTask(item);
			this.onStarted(item, res);
			if (res?.disposition === 'handled') {
				this.#finish(item, { reason: 'handled' });
				this.running = null;
			}
		} catch (err) {
			this.log(`[queue] 启动失败：${err?.message}`);
			this.onFailed(item, err);
			this.#finish(item, { reason: 'error', error: err?.message });
			this.running = null;
		}
	}

	markAgentStart() {
		if (this.running) this.running.sawAgentStart = true;
	}

	/** 由 gateway 在收到 agent_settled 且 pi 空闲后调用。 */
	markIdle() {
		if (!this.running) return;
		if (!this.running.sawAgentStart) return; // 还没真正开始，别误判完成
		const wait = this.settings.minRunMs - (Date.now() - this.running.startedAt);
		if (wait > 0) {
			// minRunMs 是为了不让上一轮的 settle 误结束刚启动的这一轮；
			// 但一轮本身可能比 minRunMs 还短（定时任务几秒就答完），
			// 直接 return 会让 running 永远占位、整条队到饿死到 hardTimeoutMs。
			// 隔同样长的时间再判一次。
			clearTimeout(this.idleRetry);
			this.idleRetry = setTimeout(() => this.markIdle(), wait);
			return;
		}
		const item = this.running.item;
		this.running = null;
		this.#finish(item, { reason: 'done' });
		this.tick();
	}

	failRunning(error) {
		if (!this.running) return;
		const item = this.running.item;
		this.running = null;
		this.#finish(item, { reason: 'error', error });
		this.tick();
	}

	#finish(item, info) {
		this.save();
		this.#emit({ type: 'queue_changed', items: this.list(), running: this.runningItem(), crons: this.cronList() });
		this.onCompleted(item, info);
	}

	#fireDueCrons() {
		const now = Date.now();
		for (const cron of this.crons) {
			const next = this.#nextCronAt(cron, (cron.lastFiredAt ? Date.parse(cron.lastFiredAt) : now - 1) );
			if (!next) continue;
			if (Date.parse(next) > now) continue;
			cron.lastFiredAt = new Date(now).toISOString();
			this.save();
			this.enqueue({
				kind: 'cron',
				text: cron.prompt,
				title: cron.title,
				source: { cronId: cron.id, expr: cron.expr ?? cron.at ?? null },
			});
			this.log(`[queue] 定时任务触发：${cron.title}`);
			if (cron.kind === 'once' && !cron.repeat && cron.at?.mode !== 'daily') {
				this.crons = this.crons.filter((c) => c.id !== cron.id);
				this.save();
			}
		}
	}
}
