// 网关核心：手机端 WS ↔ 单个 pi RPC 会话。
// 规则：同一时刻只允许一个 run（其余排队），会话绑定在「手机控制台」这一个固定会话上。

import fs from 'node:fs';
import path from 'node:path';
import { PiRpc } from './pi-rpc.mjs';
import { RunQueue } from './scheduler.mjs';
import { RingBuffer, PROTOCOL_VERSION, CLIENT_MSG, SERVER_MSG, GW_EVENT, parseJson } from './protocol.mjs';
import { findConfirmMarker, findSessionMarker, findPageMarker, ignoredMarkerHint } from './markers.mjs';
import { STATE_DIR } from './paths.mjs';

const ENTRY_SESSION_NAME = '手机控制台';
const ENTRY_BRIEF = [
	'【手机控制台固定会话说明】',
	'这里是从手机网页接入 pi 的统一入口，所有手机指令都会排进同一个队列，一次只跑一个任务。',
	'规则：',
	'1. 手机发来的每条指令都是一个任务。默认就在本会话里执行；需要项目上下文时直接读取/修改相应仓库的文件。',
	'2. 若你判断某个任务更适合在另一个已有会话里继续（或该任务会长期污染本会话），在回复最后一行单独输出标记：',
	'   [[PI_SESSION:new]] 表示建议新开会话执行；[[PI_SESSION:<sessionId>]] 表示建议切到某个已有会话。',
	'   网关会在本次运行结束后按标记切换，你不需要自己调用会话命令。',
	'3. 需要用户确认（危险操作、缺信息、二选一）时，不要自己猜答案，也不要调用任何交互工具（手机端没有原生交互工具）。',
	'   在回复最后一行单独输出标记：[[PI_CONFIRM:问题|选项A|选项B]]（给 2-4 个选项，用 | 分隔；不给选项就是自由输入）。',
	'   网关会弹卡片 + 推企业微信；用户回答后会自动排一轮新任务把答案告诉你，所以你这一轮输出完标记就收尾。',
	'4. 长任务请阶段性汇报进度，方便手机端与微信通知展示。',
	'5. 本机生成或修改了 HTML 页面（例如 answer-me-with-html 生成的解释页）、需要手机打开时，在回复最后一行单独输出标记：',
	'   [[PI_PAGE:<html 文件绝对路径>|页面标题]]。网关会把那个文件发到手机上（手机页面会出现「打开」按钮），你不需要自己架 HTTP 服务。',
	'   只能发布本机自己生成的 HTML；第三方的 HTML 不要发布（同源执行脚本）。',
	'6. 讲解/记录这套标记协议时（写文档、教程、给用户的说明），绝不要原样写出标记本身——网关会把它当成真请求执行。',
	'   要举例就换成非触发的写法（例如「PI_CONFIRM(问题|选项)」），或者放在代码块里：只有独占一行、且不在代码块/行内代码里的标记才会生效。',
].join('\n');

export class Gateway {
	constructor({ config, log, sessions, notifier, mediaDir, pages, saveImage }) {
		this.config = config;
		this.log = log;
		this.sessions = sessions;
		this.notifier = notifier;
		this.mediaDir = mediaDir;
		this.pages = pages;
		this.saveImage = saveImage;

		this.clients = new Set();
		this.listeners = new Set();
		this.ring = new RingBuffer(config.ringLimit ?? 4000);

		this.pi = null;
		this.piStarting = null;
		this.piInfo = { connected: false, startedAt: null, lastError: null, restarts: 0 };
		this.currentRunId = null;
		this.runState = 'idle'; // idle | running | waiting_approval
		this.activeSession = null; // {id,file,name}
		this.boundSessionFile = null;
		this.bindingFile = path.join(STATE_DIR, 'binding.json');
		this.queueFile = path.join(STATE_DIR, 'queue.json');

		this.approvals = new Map(); // id -> {id, method, title, options, runId, requestedAt, timer}
		this.responseTargets = new Map(); // 请求 id -> {conn, at}，异步回复时只发给发起者
		// 模型自己发的确认（[[PI_CONFIRM:...]] 标记）：不进 approvals、不阻塞队列、也不回给 pi 扩展 UI。
		this.modelConfirms = new Map();
		this.modelConfirmSeq = 0;
		this.runText = ''; // 本轮累积的 assistant 正文，用于扫 [[PI_CONFIRM:]] 标记
		this.textBuf = new Map(); // key -> {messageId, contentIndex, text, dirty}
		this.flushTimer = null;
		this.progress = { startedAt: 0, lastNotifyAt: 0, items: 0 };
		this.approvalTimeoutMs = config.approvalTimeoutMs ?? 15 * 60_000;
		this.longRunNotifyMs = config.longRunNotifyMs ?? 10 * 60_000;

		this.queue = new RunQueue({
			path: this.queueFile,
			log: this.log,
			isBusy: () => this.isBusy(),
			startTask: (item) => this.#startTask(item),
			onStarted: (item) => this.#onRunStarted(item),
			onCompleted: (item, info) => void this.#onRunCompleted(item, info),
			onFailed: (item, err) => void this.#notify('任务启动失败', `${item.title}\n${err?.message ?? err}`),
		});

		this.#loadBinding();
	}

	// ---------- 对外接口（server.mjs 依赖） ----------

	get clientCount() {
		return this.clients.size;
	}

	onEvent(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	addClient(conn) {
		this.clients.add(conn);
		conn.subscribed = true;
		this.#send(conn, { type: SERVER_MSG.Ready, protocol: PROTOCOL_VERSION, serverTime: new Date().toISOString(), boundSessionId: this.boundSessionId(), activeSessionId: this.activeSession?.id ?? null, state: this.clientState(), lastSeq: this.ring.lastSeq, pi: this.piStatus() });
	}

	removeClient(conn) {
		this.clients.delete(conn);
		for (const [k, v] of this.responseTargets) if (v.conn === conn) this.responseTargets.delete(k);
	}

	piStatus() {
		return { connected: this.pi?.connected ?? false, startedAt: this.piInfo.startedAt, lastError: this.piInfo.lastError, restarts: this.piInfo.restarts, exit: this.pi?.exitInfo ?? null };
	}

	isBusy() {
		const st = this.pi?.state ?? {};
		// busy 只看 pi 的真实信号（isStreaming / isCompacting / 待确认）；
		// 自己维护的 runState 只是 UI 提示，不能拿来门控队列——它一旦停在 running
			// 就会把后续任务永久卡在队列里（曾经就是这样）。
		return !!st.isStreaming || !!st.isCompacting || this.approvals.size > 0 || this.runState === 'waiting_approval';
	}

	async ensurePi() {
		if (this.pi?.connected) return this.pi;
		if (this.piStarting) return this.piStarting;
		this.piStarting = (async () => {
			const pi = new PiRpc({ command: this.config.piCommand ?? 'pi', args: this.config.piArgs ?? ['--mode', 'rpc'], cwd: this.config.cwd, log: this.log });
			pi.onEvent((rec) => this.#onPiEvent(rec));
			this.pi = pi;
			try {
				pi.start();
				const state = await pi.waitReady(this.config.piReadyTimeoutMs ?? 30_000);
				this.piInfo = { ...this.piInfo, connected: true, startedAt: state?.sessionFile ? Date.now() : Date.now(), lastError: null };
				this.activeSession = { id: state?.sessionId ?? null, file: state?.sessionFile ?? null, name: state?.sessionName ?? null };
				this.#emit(GW_EVENT.RpcState, { rpc: this.piStatus() });
				await this.#bindEntrySession(state);
				this.queue.start();
				this.#emit(GW_EVENT.State, { state: this.clientState() });
			} catch (err) {
				this.piInfo = { ...this.piInfo, connected: false, lastError: err?.message ?? String(err) };
				this.#emit(GW_EVENT.RpcState, { rpc: this.piStatus() });
				this.#emit(GW_EVENT.Notice, { level: 'error', text: `pi 启动失败：${err?.message ?? err}` });
				void this.#notify('pi 网关异常', `pi 启动失败：${err?.message ?? err}`);
			} finally {
				this.piStarting = null;
			}
			return this.pi;
		})();
		return this.piStarting;
	}

	async stop() {
		this.queue.stop();
		for (const timer of this.approvalTimers?.values?.() ?? []) clearTimeout(timer);
		if (this.flushTimer) clearInterval(this.flushTimer);
		if (this.pi) await this.pi.stop();
	}

	boundSessionId() {
		if (!this.boundSessionFile) return null;
		// 必须回真 sessionId：文件名带时间戳前缀，前端拿它去 session_transcript 会认不出来
		const meta = this.sessions.findByPath(this.boundSessionFile);
		return meta?.sessionId ?? path.basename(this.boundSessionFile).replace(/\.jsonl$/, "").split("_").pop();
	}

	// 给前端的统一会话视图（wire 上用 title，不暴露内部的 name）
	#sessionView() {
		const id = this.activeSession?.id ?? null;
		if (!id) return null;
		const meta = this.sessions.findById(id);
		const file = meta?.path ?? this.activeSession?.file ?? null;
		return { id, title: this.activeSession?.name ?? meta?.title ?? null, path: file, bound: file === this.boundSessionFile };
	}

	// ---------- 手机端消息 ----------

	async handleMessage(conn, text) {
		const msg = parseJson(text);
		if (!msg || typeof msg !== 'object') return this.#respond(conn, null, false, null, '不是合法 JSON');
		// id 可以是字符串也可以是数字，原样回显；客户端不传 id 就是“发完不等回音”
		const id = msg.id === undefined || msg.id === null
			? null
			: (typeof msg.id === 'number' && Number.isFinite(msg.id) ? msg.id : String(msg.id));
		if (id !== null) this.#rememberTarget(id, conn);
		try {
			switch (msg.type) {
				case CLIENT_MSG.Resume:
					return this.#resume(conn, msg);
				case CLIENT_MSG.Ping:
					return this.#send(conn, { type: SERVER_MSG.Pong, at: new Date().toISOString() });
				case CLIENT_MSG.ChatSend:
					return this.#chatSend(conn, id, msg);
				case CLIENT_MSG.Abort:
					return this.#abort(id);
				case CLIENT_MSG.QueueList:
					return this.#respond(conn, id, true, this.queue.status());
				case CLIENT_MSG.QueueRemove: {
					// 目标 id 一律用专用字段：msg.id 是请求配对的 id（客户端总会带），
					// 以前直接拿 msg.id 当队列项 id ⇒ 手机端点「删除」永远报「队列里没有这一项」。
					const entryId = String(msg.entryId ?? msg.id ?? '');
					return this.#respond(conn, id, this.queue.remove(entryId), null, '队列里没有这一项');
				}
				case CLIENT_MSG.CronList:
					return this.#respond(conn, id, true, { crons: this.queue.cronList() });
				case CLIENT_MSG.CronAdd:
					return this.#cronAdd(id, msg);
				case CLIENT_MSG.CronUpdate:
					return this.#cronUpdate(id, msg);
				case CLIENT_MSG.CronRunNow:
					return this.#cronRunNow(id, msg);
				case CLIENT_MSG.SkillList:
					return this.#skillList(id);
				case CLIENT_MSG.SkillRun:
					return this.#skillRun(id, msg);
				case CLIENT_MSG.PageList:
					return this.#respond(conn, id, true, { pages: this.pages.list() });
				case CLIENT_MSG.SessionList:
					return this.#respond(conn, id, true, { bound: this.boundSessionId(), active: this.activeSession?.id ?? null, sessions: this.sessions.list().map((s) => ({ sessionId: s.sessionId, title: s.title, cwd: s.cwd, createdAt: s.createdAt, lastActiveAt: s.lastActiveAt ?? null, active: s.path === this.activeSession?.file, bound: s.path === this.boundSessionFile, parentSession: s.parentSession ?? null })) });
				case CLIENT_MSG.SessionTranscript: {
					// before = 上一页返回的 cursor（字节偏移），带上它就往前翻一页；不传 = 最新一页
					const before = Number(msg.before);
					return this.#respond(conn, id, true, this.sessions.transcript(String(msg.sessionId ?? ''), {
						before: Number.isFinite(before) && before > 0 ? before : undefined,
					}));
				}
				case CLIENT_MSG.SessionSwitch:
					return this.#sessionSwitch(id, msg);
				case CLIENT_MSG.SessionNew:
					return this.#sessionNew(id);
				case CLIENT_MSG.SessionRename:
					return this.#sessionRename(id, msg);
				case CLIENT_MSG.SessionFork:
					return this.#sessionFork(id, msg);
				case CLIENT_MSG.ModelList:
					return this.#modelList(id);
				case CLIENT_MSG.ModelSet:
					return this.#modelSet(id, msg);
				case CLIENT_MSG.ThinkingSet:
					return this.#thinkingSet(id, msg);
				case CLIENT_MSG.ApprovalList:
					return this.#respond(conn, id, true, { approvals: [...this.approvals.values(), ...this.modelConfirms.values()].map(({ timer, ...rest }) => rest) });
				case CLIENT_MSG.ApprovalResolve:
					return this.#approvalResolve(id, msg);
				default:
					return this.#respond(conn, id, false, null, `未知指令：${msg.type}`);
			}
		} catch (err) {
			return this.#respond(conn, id, false, null, err?.message ?? String(err));
		}
	}

	#resume(conn, msg) {
		const lastSeq = Number(msg.lastSeq ?? -1);
		const replay = this.ring.replay(lastSeq);
		if (replay === null) {
			this.#send(conn, { type: SERVER_MSG.ResyncRequired, reason: 'buffer_gap' });
		} else {
			for (const ev of replay) this.#send(conn, { type: SERVER_MSG.Event, ...ev });
		}
		return this.#respond(conn, msg.id ?? null, true, { resumed: true, lastSeq: this.ring.lastSeq, state: this.clientState() });
	}

	async #chatSend(conn, id, msg) {
		const text = String(msg.text ?? '').trim();
		const rawImages = Array.isArray(msg.images) ? msg.images : [];
		if (!text && !rawImages.length) return this.#respond(conn, id, false, null, 'text 或 images 至少给一个');
		const pi = await this.ensurePi();
		if (!pi?.connected) return this.#respond(conn, id, false, null, 'pi 未运行');

		const images = [];
		const attachments = [];
		const rejected = [];
		for (const img of rawImages) {
			const mime = String(img?.mimeType ?? '');
			const b64 = String(img?.data ?? '');
			if (!b64 || !/^(image\/(png|jpe?g|gif|webp))$/i.test(mime)) {
				rejected.push(`${img?.name ?? '图片'}：不支持的类型 ${mime || '(空)'}`);
				continue;
			}
			const saved = this.saveImage(mime, b64);
			// MediaStore.save 失败时返回 {error}（真值），只判 !saved 会漏掉整类错误
			if (!saved || saved.error) {
				rejected.push(`${img?.name ?? '图片'}：${saved?.error ?? '保存失败'}`);
				continue;
			}
			images.push({ type: 'image', data: b64, mimeType: mime });
			attachments.push({ name: img?.name ?? saved.id, url: saved.url, bytes: saved.bytes });
		}
		// 图片存不下来就明确报错，不能只把文字排进队列：
		// 否则手机以为自己发了图片，实际发出去的是纯文本（用户看到的回答会和图片无关）。
		if (rejected.length) return this.#respond(conn, id, false, null, `图片未上传：${rejected.join('；')}`);

		const finalText = text || '（见图片）';
		this.#emit(GW_EVENT.UserMessage, { text: finalText, attachments, at: new Date().toISOString() });
		const entry = this.queue.enqueue({ kind: 'user', text: finalText, images, title: this.#titleOf(text) || '(图片)', source: { from: conn?.peer ?? 'mobile' } });
		this.#respond(conn, id, true, { queued: true, id: entry.id, position: this.queue.list().length, running: !!this.queue.runningItem() });
	}

	#titleOf(text) {
		// 任务标题取正文首行，剥掉标记协议输出（[[PI_CONFIRM:…]] / [[PI_SESSION:…]]）：
		// 直接用 text.slice(0,60) 会把标记文本带进微信通知标题里。
		return String(text ?? '')
			.replace(/\[\[PI_CONFIRM:[\s\S]*?\]\]/g, '')
			.replace(/\[\[PI_SESSION:[^\]]*\]\]/g, '')
			.split('\n')
			.map((s) => s.trim())
			.filter(Boolean)[0]
			.slice(0, 60);
	}

	async #abort() {
		const pi = this.pi;
		if (!pi?.connected) return { ok: false, error: 'pi 未运行' };
		const res = await pi.abort();
		this.queue.failRunning('用户在手机端停止');
		this.#emit(GW_EVENT.Notice, { level: 'info', text: '已请求停止当前任务' });
		return res;
	}

	#cronAdd(id, msg) {
		const res = this.queue.cronAdd({
			kind: msg.at ? 'once' : 'cron',
			expr: msg.cron ?? msg.expr,
			at: msg.at,
			tz: msg.timezone ?? 'Asia/Shanghai',
			prompt: msg.prompt,
			title: msg.title,
			repeat: !!msg.repeat,
		});
		if (res.error) return this.#respondById(id, false, null, res.error);
		return this.#respondById(id, true, { cron: res.cron, nextAt: res.cron.nextAt ?? this.queue.cronList().find((c) => c.id === res.cron.id)?.nextAt });
	}

	#cronUpdate(id, msg) {
		const targetId = String(msg.cronId ?? msg.id ?? '');
		const patch = msg.patch && typeof msg.patch === 'object' ? msg.patch : {};
		// 校验与落盘全部交给 Queue.cronPatch（那里带 remove / at 解析 / cron 表达式校验）。
		// 以前网关自己拷字段：既不认 remove（手机端「删除定时任务」无效），
		// 也不解析 at（直接把 '2026-11-17 09:00' 这种字符串写进 state/queue.json）。
		const res = this.queue.cronPatch(targetId, patch);
		if (res?.error) return this.#respondById(id, false, null, res.error);
		return this.#respondById(id, true, { cron: res.cron ?? null, removed: res.removed === true, crons: this.queue.cronList() });
	}

	#cronRunNow(id, msg) {
		const targetId = String(msg.cronId ?? msg.id ?? '');
		const cron = this.queue.crons.find((c) => c.id === targetId);
		if (!cron) return this.#respondById(id, false, null, '没有这个定时任务');
		const entry = this.queue.enqueue({ kind: 'cron', text: cron.prompt, title: cron.title, source: { cronId: cron.id } });
		return this.#respondById(id, true, { queued: entry.id });
	}

	async #skillList(id) {
		const pi = await this.ensurePi();
		const res = await pi.getCommands();
		if (!res.success) return this.#respondById(id, false, null, res.error);
		const list = (res.data?.commands ?? []).filter((c) => String(c.name).startsWith('skill:') || c.source === 'skill' || c.kind === 'skill');
		return this.#respondById(id, true, { commands: res.data?.commands ?? [], skills: list });
	}

	async #skillRun(id, msg) {
		const name = String(msg.name ?? '').trim();
		if (!name) return this.#respondById(id, false, null, 'name 不能为空');
		const args = String(msg.args ?? '').trim();
		const entry = this.queue.enqueue({ kind: 'user', text: `/skill:${name}${args ? ` ${args}` : ''}`, title: `技能 ${name}` });
		return this.#respondById(id, true, { queued: entry.id });
	}

	async #modelList(id) {
		const pi = await this.ensurePi();
		const res = await pi.getAvailableModels();
		if (!res.success) return this.#respondById(id, false, null, res.error);
		const state = await pi.getState();
		return this.#respondById(id, true, { models: res.data?.models ?? [], current: state?.data?.model ?? this.pi?.state?.model ?? null, thinkingLevel: state?.data?.thinkingLevel ?? null, levels: state?.data?.thinkingLevels ?? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] });
	}

	async #modelSet(id, msg) {
		const pi = this.pi;
		if (!pi?.connected) return this.#respondById(id, false, null, 'pi 未运行');
		const res = await pi.setModel(String(msg.provider ?? ''), String(msg.modelId ?? ''));
		if (!res.success) return this.#respondById(id, false, null, res.error);
		this.pi.state = { ...(this.pi.state ?? {}), model: res.data };
		this.#emit(GW_EVENT.ModelChanged, { model: res.data });
		return this.#respondById(id, true, { model: res.data });
	}

	async #thinkingSet(id, msg) {
		const pi = this.pi;
		if (!pi?.connected) return this.#respondById(id, false, null, 'pi 未运行');
		const res = await pi.setThinkingLevel(String(msg.level ?? ''));
		if (!res.success) return this.#respondById(id, false, null, res.error);
		this.#emit(GW_EVENT.State, { state: this.clientState() });
		return this.#respondById(id, true, { thinkingLevel: msg.level });
	}

	async #sessionSwitch(id, msg) {
		const pi = this.pi;
		if (!pi?.connected) return this.#respondById(id, false, null, 'pi 未运行');
		if (msg.sessionId === null) {
			if (this.boundSessionFile) {
				const res = await pi.switchSession(this.boundSessionFile);
				if (!res.success) return this.#respondById(id, false, null, res.error);
				await this.#refreshActive();
			}
			return this.#respondById(id, true, { session: this.#sessionView(), bound: this.boundSessionId(), active: this.activeSession?.id ?? null });
		}
		const found = this.sessions.findById(String(msg.sessionId));
		if (!found) return this.#respondById(id, false, null, '找不到该会话');
		const res = await pi.switchSession(found.path);
		if (!res.success) return this.#respondById(id, false, null, res.error);
		await this.#refreshActive();
		return this.#respondById(id, true, { session: this.#sessionView(), bound: this.boundSessionId(), active: this.activeSession?.id ?? null });
	}

	async #sessionNew(id) {
		const pi = this.pi;
		if (!pi?.connected) return this.#respondById(id, false, null, 'pi 未运行');
		const res = await pi.newSession();
		if (!res.success) return this.#respondById(id, false, null, res.error);
		await this.#refreshActive();
		return this.#respondById(id, true, { session: this.#sessionView(), bound: this.boundSessionId(), active: this.activeSession?.id ?? null });
	}

	async #sessionRename(id, msg) {
		const sessionId = String(msg.sessionId ?? '');
		const name = msg.name === null || msg.name === undefined ? null : String(msg.name).slice(0, 120);
		const found = this.sessions.findById(sessionId);
		if (!found) return this.#respondById(id, false, null, '找不到该会话');
		if (this.activeSession?.id === sessionId) {
			const res = await this.pi.setSessionName(name ?? '');
			if (!res.success) return this.#respondById(id, false, null, res.error);
			this.activeSession = { ...this.activeSession, name };
		} else {
			this.#renameInFile(found.path, name);
		}
		this.sessions.invalidate?.();
		return this.#respondById(id, true, { name, session: this.#sessionView() });
	}

	async #sessionFork(id, msg) {
		const pi = this.pi;
		if (!pi?.connected) return this.#respondById(id, false, null, 'pi 未运行');
		const res = msg.entryId ? await pi.fork(String(msg.entryId)) : await pi.clone();
		if (!res.success) return this.#respondById(id, false, null, res.error);
		await this.#refreshActive();
		return this.#respondById(id, true, { session: this.#sessionView(), bound: this.boundSessionId(), active: this.activeSession?.id ?? null });
	}

	#approvalResolve(id, msg) {
		// 同上：目标 id 用 approvalId（旧客户端只带 msg.id 时兼容回退）
		const approvalId = String(msg.approvalId ?? msg.approval ?? msg.id ?? '');
		// 模型确认（标记协议）走单独路径：不是 pi 扩展 UI 请求，答案靠排一轮新任务送回去。
		const modelConfirm = this.modelConfirms.get(approvalId);
		if (modelConfirm) return this.#resolveModelConfirm(id, modelConfirm, msg);
		const approval = this.approvals.get(approvalId);
		if (!approval) return this.#respondById(id, false, null, '这个确认请求已经过期或不存在');
		const method = approval.method;
		// pi 的 extension_ui_response 形状（docs/rpc-extension-ui.md）：select/input/editor 都是 {value:<字符串>}，
		// confirm 是 {confirmed:bool}，取消是 {cancelled:true}。之前 input 发的是 {text:...}、select 发的是数组，
		// pi 认不出来 => 审批永远只能等 15 分钟超时。
		let value;
		if (msg.cancelled === true) {
			value = { cancelled: true };
		} else if (method === 'confirm') {
			// 注意读 msg.value：这里是 `value = value === ...`（读自己、永远 undefined），
			// 会导致手机点“同意”也被当成拒绝。
			const raw = msg.value ?? msg.answer;
			value = raw === true || raw === 'true' || raw === 'accept' || raw === 'yes' || raw === '确认' || raw === '同意' || raw === '是'
				? { confirmed: true }
				: raw === false || raw === 'false' || raw === 'reject' || raw === 'cancel' || raw === 'deny' || raw === '取消' || raw === '拒绍' || raw === '否'
					? { confirmed: false }
					: { confirmed: Boolean(raw) };
		} else if (method === 'select') {
			const raw = Array.isArray(msg.value) ? msg.value[0] : msg.value;
			const want = String(raw ?? '').trim();
			const opts = (approval.options ?? []).map((o) => String(o.value ?? ''));
			if (opts.length && !opts.includes(want) && /^(cancel|deny|no|reject|取消|拒绝|否)$/i.test(want)) {
				// 手机端只会发“取消/拒绝”这种意图，pi 要的是选项原文（例如 "Block"），这里做个映射。
				const hit = opts.find((o) => /cancel|deny|block|no|reject|取消|拒绝|否/i.test(o));
				value = hit ? { value: hit } : { cancelled: true };
			} else if (approval.multi && Array.isArray(msg.value)) {
				value = { value: msg.value.map(String) };
			} else {
				value = { value: want };
			}
		} else {
			value = { value: typeof msg.value === 'string' ? msg.value : String(msg.value?.text ?? '') };
		}
		const res = this.pi?.resolveExtensionUi(approvalId, value);
		this.#clearApproval(approvalId, value);
		return this.#respondById(id, true, { resolved: true, rpcSuccess: res?.success ?? false, error: res?.error ?? null });
	}

	// ---------- pi 事件 -> 前端事件 ----------

	#onPiEvent(rec) {
		if (!rec || typeof rec !== 'object') return;
		// extension_error 只打事件名等于没日志：pi 的载荷是 {extensionPath, event, error}
		// （pi-coding-agent/dist/modes/rpc/rpc-mode.js:267），少了它们就永远无法定性“是哪个插件、在哪个钩子上抛的”。
		if (rec.type !== 'message_update') {
			const extra = rec.type === 'extension_error'
				? ` ext=${String(rec.extensionPath ?? '?')} event=${String(rec.event ?? '?')} err=${String(rec?.error?.message ?? rec?.error ?? '').replace(/\s+/g, ' ').slice(0, 300)}`
				: '';
			this.log(`[pi:event] ${rec.type}${rec.aborted !== undefined ? ` aborted=${rec.aborted}` : ''}${extra}`);
		}
		switch (rec.type) {
			case 'agent_start':
				this.runState = 'running';
				this.runText = '';
				this.queue.markAgentStart();
				this.progress = { startedAt: Date.now(), lastNotifyAt: Date.now(), items: 0 };
				this.#emit(GW_EVENT.AgentStart, { runId: this.currentRunId, state: this.clientState() });
				this.#emit(GW_EVENT.State, { state: this.clientState() });
				break;
			case 'message_update': {
				const am = rec.assistantMessageEvent ?? {};
				if (am.type === 'text_delta' && am.delta) this.#bufferText(rec.messageId ?? rec.message?.id, am.contentIndex ?? 0, am.delta);
				if (am.type === 'thinking_delta' && am.delta) this.#emit(GW_EVENT.ThinkingDelta, { messageId: rec.messageId, contentIndex: am.contentIndex, delta: am.delta.slice(0, 2000) });
				break;
			}
			case 'message_end': {
				const m = rec.message ?? {};
				if (m.role === 'assistant') this.#flushText(m.id, true);
				break;
			}
			case 'tool_execution_start': {
				const toolName = String(rec.toolName ?? '');
				// 上下文压缩这类内部工具不值得在手机时间线上占一张卡片（实测过 compress 失败也挂了一张卡）
				if (/^(compress|decompress|search_context|acp_status|acp_cache|acp_read_original_image)$/i.test(toolName)) break;
				this.progress.items++;
				this.#emit(GW_EVENT.ToolStart, { toolCallId: rec.toolCallId, toolName, args: this.#previewArgs(rec.args) });
				this.#maybeLongRunNotify();
				break;
			}
			case 'tool_execution_end': {
				const toolName = String(rec.toolName ?? '');
				if (/^(compress|decompress|search_context|acp_status|acp_cache|acp_read_original_image)$/i.test(toolName)) break;
				this.#emit(GW_EVENT.ToolEnd, { toolCallId: rec.toolCallId, toolName, ok: !rec.isError, text: this.#toolText(rec.result), durationMs: rec.durationMs });
				break;
			}
			case 'queue_update':
				this.#emit(GW_EVENT.QueueUpdate, { items: this.queue.list(), running: this.queue.runningItem(), steering: rec.steering ?? [], followUp: rec.followUp ?? [] });
				break;
			case 'compaction_start':
				this.#emit(GW_EVENT.Notice, { level: 'info', text: '上下文正在压缩…' });
				this.#emit(GW_EVENT.State, { state: this.clientState() });
				break;
			case 'auto_retry_start':
				this.#emit(GW_EVENT.Notice, { level: 'warning', text: `第 ${rec.attempt}/${rec.maxAttempts} 次重试：${String(rec.errorMessage ?? '').slice(0, 200)}` });
				break;
			case 'extension_ui_request':
				this.#onExtensionUi(rec);
				break;
			case 'entry_appended':
				break;
			case 'thinking_level_changed':
				this.pi.state = { ...(this.pi.state ?? {}), thinkingLevel: rec.level ?? null };
				this.#emit(GW_EVENT.State, { state: this.clientState() });
				break;
			case 'session_info_changed':
				this.activeSession = { ...this.activeSession, name: rec.name ?? null };
				this.#emit(GW_EVENT.SessionChanged, { session: this.#sessionView(), bound: this.boundSessionId() });
				break;
			case 'agent_settled':
				this.#flushText(null, true);
				this.#scanPageMarker();
				this.#scanConfirmMarker();
				this.runState = this.approvals.size ? 'waiting_approval' : 'idle';
				this.#emit(GW_EVENT.AgentSettled, { aborted: !!rec.aborted, state: this.clientState() });
				this.#emit(GW_EVENT.State, { state: this.clientState() });
				this.queue.markIdle();
				void this.#ensureBound();
				break;
			case 'process_closed':
				this.#onPiClosed(rec);
				break;
			default:
				break;
		}
	}

	#onExtensionUi(rec) {
		const method = rec.method ?? rec.kind ?? '';
		if (method === 'notify' || method === 'setStatus' || method === 'setWidget' || method === 'setTitle' || method === 'set_editor_text') return;
		if (!['select', 'confirm', 'input', 'editor'].includes(method)) return;
		const title = String(rec.title ?? rec.message ?? rec.question ?? '需要你确认');
		const approval = {
			id: String(rec.id),
			method,
			title,
			options: Array.isArray(rec.options) ? rec.options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o)) : undefined,
			placeholder: rec.placeholder ?? undefined,
			multi: !!rec.multiSelect,
			runId: this.currentRunId,
			requestedAt: new Date().toISOString(),
		};
		this.approvals.set(approval.id, approval);
		this.runState = 'waiting_approval';
		this.#emit(GW_EVENT.ApprovalRequested, { approval });
		this.#emit(GW_EVENT.State, { state: this.clientState() });
		void this.#notify('任务需要你确认', `${title}\n（任务：${this.queue.runningItem()?.title ?? '当前任务'}）`, { kind: 'approval', throttleMs: 0 });
		const timer = setTimeout(() => {
			if (!this.approvals.has(approval.id)) return;
			this.log(`[approval] ${approval.id} 超时未回答，按取消处理`);
			this.pi?.resolveExtensionUi(approval.id, method === 'confirm' ? { confirmed: false } : { cancelled: true });
			this.#clearApproval(approval.id, { cancelled: true });
			this.#emit(GW_EVENT.Notice, { level: 'warning', text: '确认请求超时（15 分钟），已按“取消”处理' });
			void this.#notify('确认已超时', `${title}\n15 分钟内没有回答，已按取消处理。`, { kind: 'approval_timeout', throttleMs: 0 });
		}, this.approvalTimeoutMs);
		timer.unref?.();
		approval.timer = timer;
	}

	// ---------- 模型主动发起的确认（[[PI_CONFIRM:问题|选项A|选项B]]）----------

	// 页面标记：模型写完一个本机 HTML 页后单独一行写 [[PI_PAGE:<绝对路径>|标题]]，
	// 网关把文件发进 pages/ 并推 page_ready，手机页面就出现「打开」按钮。
	// 必须在 #scanConfirmMarker() 之前调（那个会清空 runText）。
	#scanPageMarker() {
		const hit = findPageMarker(this.runText);
		if (!hit) return;
		if (!hit.path) {
			if (hit.ignoredInline) this.log('[pages] 检测到 PI_PAGE，但标记没有独占一行（或写在代码里），已忽略');
			return;
		}
		if (hit.truncated) this.log('[pages] 标记缺收尾 ]]，已按行尾自动闭合');
		let page;
		try {
			page = this.pages.publish(hit.path, hit.title);
		} catch (err) {
			this.log(`[pages] 发布失败：${err?.message}`);
			this.#emit(GW_EVENT.Notice, { level: 'warn', text: `页面发布失败：${err?.message}` });
			return;
		}
		this.log(`[pages] 已发布 ${page.name}（${(page.bytes / 1024).toFixed(0)}KB）<- ${page.source}`);
		this.#emit(GW_EVENT.PageReady, page);
	}

	#scanConfirmMarker() {
		const text = this.runText;
		this.runText = '';
		const hit = findConfirmMarker(text);
		if (!hit) {
			const hint = ignoredMarkerHint(text, 'PI_CONFIRM');
			if (hint) this.log(`[confirm] ${hint}`);
			return;
		}
		if (hit.ignoredInline) {
			this.log('[confirm] 检测到 PI_CONFIRM，但标记没有独占一行（或写在代码里），已忽略');
			return;
		}
		if (hit.truncated) this.log('[confirm] 标记缺收尾 ]]，已按行尾自动闭合');
		this.#openModelConfirm(hit.question, hit.options);
	}

	#openModelConfirm(question, options) {
		const id = `pi-confirm-${++this.modelConfirmSeq}`;
		const approval = {
			id,
			source: 'model',
			method: options.length ? 'select' : 'input',
			title: question,
			options: options.length ? options.map((o) => ({ value: o, label: o })) : undefined,
			placeholder: options.length ? undefined : '输入回答后任务会自动继续',
			runId: this.currentRunId,
			requestedAt: new Date().toISOString(),
		};
		this.modelConfirms.set(id, approval);
		this.log(`[confirm] 模型请求确认：${question}`);
		this.#emit(GW_EVENT.ApprovalRequested, { approval });
		this.#emit(GW_EVENT.State, { state: this.clientState() });
		const optionLine = options.length ? `\n可选：${options.join(' / ')}` : '';
		void this.#notify('任务需要你确认', `${question}${optionLine}\n（在手机 pi 页面点选项，或直接回答；回答后任务会自动继续）`, { kind: 'approval', throttleMs: 0 });
		const timer = setTimeout(() => {
			if (!this.modelConfirms.has(id)) return;
			this.modelConfirms.delete(id);
			this.#emit(GW_EVENT.ApprovalResolved, { id, value: { cancelled: true } });
			this.#emit(GW_EVENT.Notice, { level: 'warning', text: '确认超时（15 分钟），任务没有继续。' });
			void this.#notify('确认已超时', `${question}\n15 分钟内没有回答，任务未继续。`, { kind: 'approval_timeout', throttleMs: 0 });
		}, this.approvalTimeoutMs);
		timer.unref?.();
	}

	#resolveModelConfirm(respId, approval, msg) {
		this.modelConfirms.delete(approval.id);
		const answer = msg?.cancelled === true
			? '（用户取消了，不要继续）'
			: String(Array.isArray(msg?.value) ? msg.value[0] : (msg?.value ?? '')).trim() || '（空回答）';
		this.#emit(GW_EVENT.ApprovalResolved, { id: approval.id, value: { value: answer } });
		this.#emit(GW_EVENT.Notice, { level: 'info', text: `回答已排入队列：${answer}` });
		const entry = this.queue.enqueue({
			kind: 'user',
			text: `我对上一个任务的确认问题「${approval.title}」回答：「${answer}」。请据此继续，已完成的部分不要重做。`,
			title: `确认回答：${answer}`.slice(0, 60),
			source: { from: 'mobile-confirm' },
		});
		return this.#respondById(respId, true, { resolved: true, queued: entry?.id ?? null });
	}

	#clearApproval(id, value) {
		const approval = this.approvals.get(id);
		if (!approval) return;
		if (approval.timer) clearTimeout(approval.timer);
		this.approvals.delete(id);
		if (this.runState === 'waiting_approval' && !this.approvals.size) this.runState = this.pi?.state?.isStreaming ? 'running' : 'idle';
		this.#emit(GW_EVENT.ApprovalResolved, { id, value });
		this.#emit(GW_EVENT.State, { state: this.clientState() });
	}

	async #onPiClosed(rec) {
		this.runState = 'idle';
		this.queue.failRunning(`pi 进程退出（code=${rec.code ?? rec.signal}）`);
		this.piInfo = { ...this.piInfo, connected: false, lastError: `pi 退出 code=${rec.code ?? rec.signal}` };
		this.#emit(GW_EVENT.RpcState, { rpc: this.piStatus() });
		this.#emit(GW_EVENT.Notice, { level: 'error', text: `pi 进程退出（code=${rec.code ?? rec.signal}），正在重启…` });
		void this.#notify('pi 进程退出', `退出码 ${rec.code ?? rec.signal}，网关会尝试重启。`, { kind: 'pi_exit', throttleMs: 0 });
		if (this.config.autoRestart !== false) {
			this.piInfo.restarts++;
			this.pi = null;
			setTimeout(() => void this.ensurePi(), 3000).unref?.();
		}
	}

	// ---------- 队列与 run ----------

	async #startTask(item) {
		const pi = await this.ensurePi();
		if (!pi?.connected) throw new Error('pi 未运行');
		this.currentRunId = item.id;
		this.runState = 'running';
		const images = Array.isArray(item.images) ? item.images : [];
		// 上一发还没收尾时先等它（pi 会直接报 “Agent is already processing”），
		// 队列的本意就是串行，不能因此把这一项判为失败。
		for (let i = 0; i < 40 && pi.state?.isStreaming; i++) await new Promise((r) => setTimeout(r, 1500));
		let res = await pi.prompt(item.text, images);
		for (let i = 0; i < 40 && !res.success && /already processing/i.test(res.error ?? ''); i++) {
			this.log(`[queue] pi 仍在处理上一条，${(i + 1) * 2}s 后重试：${item.title}`);
			await new Promise((r) => setTimeout(r, 2000));
			res = await pi.prompt(item.text, images);
		}
		if (!res.success) throw new Error(res.error ?? 'prompt 失败');
		return { disposition: res.data?.disposition ?? 'started' };
	}

	#onRunStarted(item) {
		this.#emit(GW_EVENT.QueueUpdate, { items: this.queue.list(), running: this.queue.runningItem(), crons: this.queue.cronList() });
		this.#emit(GW_EVENT.Notice, { level: 'info', text: `开始执行：${item.title}` });
	}

	async #onRunCompleted(item, info) {
		this.runState = 'idle';
		this.currentRunId = null;
		this.#emit(GW_EVENT.QueueUpdate, { items: this.queue.list(), running: null, crons: this.queue.cronList() });
		this.#emit(GW_EVENT.State, { state: this.clientState() });
		const last = await this.pi?.getLastAssistantText?.();
		const answer = String(last?.data?.text ?? '').trim();
		if (!this.#applySessionMarker(answer)) this.#followActiveSession();
		const reasonText = info.reason === 'done' ? '完成' : info.reason === 'timeout' ? '超时被强制收尾' : info.reason === 'error' ? `失败：${info.error ?? ''}` : '已结束';
		const excerpt = answer ? answer.slice(0, 300) : '（无文本结论）';
		this.#emit(GW_EVENT.Notice, { level: info.reason === 'done' ? 'info' : 'warning', text: `${item.title} — ${reasonText}` });
		await this.#notify(`任务${reasonText.startsWith('完成') ? '完成' : '结束'}：${item.title}`, `${reasonText}\n${excerpt}`, { kind: 'run_done', throttleMs: 30_000, url: this.#deepLink(item) });
	}

	#deepLink() {
		const base = this.config.publicUrl ?? 'https://<UI域名>/admin/';
		return `${base}#/pi`;
	}

	/** agent 用 [[PI_SESSION:new]] / [[PI_SESSION:<id>]] 建议换会话，这里执行。 */
	/** 答案里有没有「换会话」标记。返回 true 表示这一轮已经按用户意图换过会话。 */
	#applySessionMarker(answer) {
		const target = findSessionMarker(answer);
		if (!target) {
			const hint = ignoredMarkerHint(answer, 'PI_SESSION');
			if (hint) this.log(`[session] ${hint}`);
			return false;
		}
		if (target.toLowerCase() === 'new') {
			void this.pi.newSession().then(async (res) => {
				if (!res.success) return;
				await this.#refreshActive();
				// 新会话就是往后的入口会话：不补名字它在手机会话列表里就是个无标题会话，
				// 绑定文件一旦丢了也按同名找不到它（2026-11-16 误触发事故就是这个形状）。
				await this.pi.setSessionName(ENTRY_SESSION_NAME);
				this.#followActiveSession();
				await this.#refreshActive();
				this.#emit(GW_EVENT.Notice, { level: 'info', text: '按 agent 建议新开了会话继续后续任务（已改名为入口会话）' });
			});
			return true;
		}
		const found = this.sessions.findById(target);
		if (!found) {
			this.#emit(GW_EVENT.Notice, { level: 'warning', text: `agent 建议切到会话 ${target}，但找不到该会话` });
			return true;
		}
		void this.pi.switchSession(found.path).then(async (res) => {
			if (res.success) {
				await this.#refreshActive();
				this.#followActiveSession();
				this.#emit(GW_EVENT.Notice, { level: 'info', text: `按 agent 建议切到会话「${found.title ?? found.sessionId}」` });
			}
		});
		return true;
	}

	/**
	 * 没有标记、但活跃会话已经不是入口会话（上下文压缩会 fork、扩展也可能自己换），就把绑定跟上去。
	 * 不这么做，下次重启会 switchSession 回旧文件，同一段对话被勈成两半。
	 */
	#followActiveSession() {
		const file = this.activeSession?.file;
		if (!file || !this.boundSessionFile) return;
		if (path.resolve(file) === path.resolve(this.boundSessionFile)) return;
		this.log(`[binding] 入口会话跟随活跃会话：${path.basename(this.boundSessionFile)} → ${path.basename(file)}`);
		this.boundSessionFile = file;
		this.#saveBinding();
		this.#emit(GW_EVENT.SessionChanged, { session: this.#sessionView(), bound: this.boundSessionId() });
	}

	// ---------- 入口会话绑定 ----------

	#loadBinding() {
		try {
			const raw = JSON.parse(fs.readFileSync(this.bindingFile, 'utf8'));
			if (raw?.sessionFile && fs.existsSync(raw.sessionFile)) this.boundSessionFile = raw.sessionFile;
		} catch {
			/* 首次运行没有绑定文件 */
		}
	}

	#saveBinding() {
		try {
			fs.mkdirSync(path.dirname(this.bindingFile), { recursive: true });
			fs.writeFileSync(this.bindingFile, JSON.stringify({ version: 1, sessionFile: this.boundSessionFile, boundAt: new Date().toISOString() }, null, 2));
		} catch (err) {
			this.log(`[binding] 保存失败：${err?.message}`);
		}
	}

	async #bindEntrySession(state) {
		// 已有绑定 -> 用它；否则找同名会话；再否则新建并命名。
		if (this.boundSessionFile && fs.existsSync(this.boundSessionFile)) {
			if (state?.sessionFile !== this.boundSessionFile) {
				const res = await this.pi.switchSession(this.boundSessionFile);
				if (!res.success) this.log(`[binding] 切回入口会话失败：${res.error}`);
			}
			await this.#refreshActive();
			if (!this.activeSession?.name && path.resolve(this.activeSession?.file ?? '') === path.resolve(this.boundSessionFile)) {
				// 入口会话丢了标题（新会话没改名、或旧版本带过来的），补一次；用户自己改过名则不动。
				await this.pi.setSessionName(ENTRY_SESSION_NAME);
				await this.#refreshActive();
				this.log('[binding] 入口会话无标题，已补命名为「手机控制台」');
			}
			return;
		}
		const named = this.sessions.list().find((s) => s.title === ENTRY_SESSION_NAME);
		if (named) {
			this.boundSessionFile = named.path;
			if (state?.sessionFile !== named.path) await this.pi.switchSession(named.path);
			this.#saveBinding();
			await this.#refreshActive();
			return;
		}
		const created = await this.pi.newSession();
		if (!created.success) {
			this.log(`[binding] 新建入口会话失败：${created.error}`);
			return;
		}
		await this.pi.setSessionName(ENTRY_SESSION_NAME);
		await this.#refreshActive();
		for (let i = 0; i < 12 && !this.activeSession?.file; i++) {
			await new Promise((r) => setTimeout(r, 500));
			await this.#refreshActive();
		}
		this.boundSessionFile = this.activeSession?.file ?? null;
		this.#saveBinding();
		// 引导语也走队列（而不是直接 prompt），保证只有一条下发路径，
		// 不会和重启时从磁盘恢复的队首项撞车。
		this.queue.enqueue({ kind: 'system', text: ENTRY_BRIEF, title: '入口引导', source: { bootstrap: true } });
		this.log(`[binding] 已建立入口会话 ${this.boundSessionFile ?? '(未知，稍后补绑)'}`);
	}

	/** 入口会话没绑上时的补绑（新建会话后 get_state 可能要等一等才有 sessionFile）。 */
	async #ensureBound() {
		if (this.boundSessionFile) return;
		try {
			await this.#refreshActive();
			if (this.activeSession?.file) {
				this.boundSessionFile = this.activeSession.file;
				this.#saveBinding();
				this.log(`[binding] 已补绑入口会话 ${this.boundSessionFile}`);
			}
		} catch (err) {
			this.log(`[binding] 补绑失败：${err?.message}`);
		}
	}

	async #refreshActive() {
		const res = await this.pi.getState();
		const st = res?.data ?? {};
		this.pi.state = st;
		this.activeSession = { id: st.sessionId ?? null, file: st.sessionFile ?? null, name: st.sessionName ?? null };
		if (this.boundSessionFile && this.activeSession.file === this.boundSessionFile) this.#saveBinding();
		this.sessions.invalidate?.();
		this.#emit(GW_EVENT.SessionChanged, { session: this.#sessionView(), bound: this.boundSessionId() });
		this.#emit(GW_EVENT.State, { state: this.clientState() });
	}

	#renameInFile(sessionFile, name) {
		try {
			const lines = fs.readFileSync(sessionFile, 'utf8').split('\n');
			const header = parseJson(lines[0] ?? '');
			if (!header || header.type !== 'session') throw new Error('会话首行不是 session 头');
			header.name = name ?? undefined;
			if (name === null || name === undefined) delete header.name;
			// 留一个改名时间：SessionStore 靠它和 session_info 的 timestamp 比新旧，否则读到的是更早那次改名
			if (name !== null && name !== undefined) header.renamedAt = new Date().toISOString();
			lines[0] = JSON.stringify(header);
			const tmp = `${sessionFile}.renaming`;
			fs.writeFileSync(tmp, lines.join('\n'));
			fs.renameSync(tmp, sessionFile);
		} catch (err) {
			this.log(`[session] 改名失败：${err?.message}`);
			throw err;
		}
	}

	// ---------- 工具函数 ----------

	clientState() {
		const st = this.pi?.state ?? {};
		return {
			runState: this.runState,
			isStreaming: !!st.isStreaming,
			isCompacting: !!st.isCompacting,
			model: this.#modelName(st.model),
			thinkingLevel: st.thinkingLevel ?? null,
			pendingMessageCount: st.pendingMessageCount ?? 0,
			messageCount: st.messageCount ?? 0,
			activeSessionId: this.activeSession?.id ?? null,
			boundSessionId: this.boundSessionId(),
			running: this.queue.runningItem(),
			queueLength: this.queue.list().length,
			pendingApprovals: this.approvals.size + this.modelConfirms.size,
		};
	}

	#bufferText(messageId, contentIndex, delta) {
		const key = `${messageId ?? 'cur'}:${contentIndex}`;
		const cur = this.textBuf.get(key) ?? { messageId, contentIndex, text: '', dirty: false };
		cur.text += delta;
		cur.dirty = true;
		this.textBuf.set(key, cur);
		if (!this.flushTimer) {
			this.flushTimer = setInterval(() => this.#flushText(null, false), 300);
			this.flushTimer.unref?.();
		}
		if (cur.text.length > 4000) this.#flushText(null, false, key);
	}

	#flushText(messageId, force, onlyKey) {
		for (const [key, buf] of [...this.textBuf]) {
			if (onlyKey && key !== onlyKey) continue;
			if (messageId && buf.messageId !== messageId) continue;
			if (!buf.dirty && !force) continue;
			if (!buf.text) {
				this.textBuf.delete(key);
				continue;
			}
			this.runText = (this.runText + buf.text).slice(-20_000);
			this.#emit(GW_EVENT.AssistantText, { messageId: buf.messageId, contentIndex: buf.contentIndex, text: buf.text });
			buf.text = '';
			buf.dirty = false;
			if (force) this.textBuf.delete(key);
		}
	}

	#maybeLongRunNotify() {
		const now = Date.now();
		if (!this.progress.startedAt) return;
		if (now - this.progress.startedAt < this.longRunNotifyMs) return;
		if (now - this.progress.lastNotifyAt < this.longRunNotifyMs) return;
		this.progress.lastNotifyAt = now;
		const run = this.queue.runningItem();
		void this.#notify('任务仍在进行', `「${run?.title ?? '当前任务'}」已运行 ${Math.round((now - this.progress.startedAt) / 60000)} 分钟，完成 ${this.progress.items} 个工具调用。`, { kind: 'long_run', throttleMs: 0 });
	}

	async #notify(title, body, opts = {}) {
		try {
			return await this.notifier.send({ title, body: String(body ?? '').slice(0, 1800), url: opts.url ?? this.#deepLink(), kind: opts.kind ?? 'info', throttleMs: opts.throttleMs ?? 60_000 });
		} catch (err) {
			this.log(`[notify] 失败：${err?.message}`);
			return { ok: false, error: err?.message };
		}
	}

	#modelName(model) {
		if (!model) return null;
		const id = String(model.id ?? model.name ?? '');
		const provider = String(model.provider ?? '');
		if (!id) return provider || null;
		return id.includes('/') || !provider || id.startsWith(`${provider}/`) ? id : `${provider}/${id}`;
	}

	#previewArgs(args) {
		try {
			const text = JSON.stringify(args ?? {});
			return text.length > 800 ? `${text.slice(0, 800)}…` : text;
		} catch {
			return String(args ?? '');
		}
	}

	#toolText(result) {
		const parts = Array.isArray(result?.content) ? result.content.filter((c) => c?.type === 'text').map((c) => c.text ?? '') : [];
		const text = parts.join('\n').trim();
		return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
	}

	#emit(event, payload = {}) {
		const wrapped = { type: SERVER_MSG.Event, event, ...payload };
		this.ring.push({ event, ...payload });
		for (const l of [...this.listeners]) {
			try {
				l(wrapped);
			} catch (err) {
				this.log(`[bus] 监听器异常：${err?.message}`);
			}
		}
	}

	#send(conn, obj) {
		try {
			conn.send(JSON.stringify(obj));
		} catch (err) {
			this.log(`[ws] 发送失败：${err?.message}`);
		}
	}

	#respond(conn, id, ok, data, error) {
		this.#send(conn, { type: SERVER_MSG.Response, id, ok, ...(data === undefined ? {} : { data }), ...(error ? { error } : {}) });
	}

	// 异步处理（cron / 模型 / 会话 / 技能…）拿不到 conn，所以先把 id -> conn 记下来，
	// 回复时只发给发起者；多设备同时操作时才不会互相误配。
	#rememberTarget(id, conn) {
		if (this.responseTargets.size > 500) this.#pruneTargets();
		this.responseTargets.set(String(id), { conn, at: Date.now() });
	}

	#pruneTargets() {
		const cutoff = Date.now() - 5 * 60_000;
		for (const [k, v] of this.responseTargets) if (!this.clients.has(v.conn) || v.at < cutoff) this.responseTargets.delete(k);
	}

	#respondById(id, ok, data, error) {
		const key = id === null || id === undefined ? null : String(id);
		const target = key === null ? undefined : this.responseTargets.get(key);
		if (target) {
			this.responseTargets.delete(key);
			this.#respond(target.conn, id, ok, data, error);
			return;
		}
		for (const conn of this.clients) this.#respond(conn, id, ok, data, error);
	}
}
