// 企业微信通知：走 distrisched task_center 的 /ui/api/pi/notify
// （只有服务器 IP 在企业微信可信企业 IP 里，本机直连 qyapi 会被拒）

const THROTTLE_MS_DEFAULT = 60_000;

export class Notifier {
	/**
	 * @param {{centerUrl:string, token:string, toUser:string, enabled?:boolean, log?:(...a:any[])=>void}} opts
	 */
	constructor(opts = {}) {
		this.centerUrl = String(opts.centerUrl ?? '').replace(/\/+$/, '');
		this.token = opts.token ?? '';
		this.toUser = opts.toUser || 'opsUser';
		this.enabled = opts.enabled !== false;
		this.log = opts.log ?? (() => {});
		this.lastSent = new Map(); // key -> timestamp
		this.stats = { sent: 0, failed: 0, throttled: 0, lastError: null, lastSentAt: null };
	}

	status() {
		const configured = !!(this.centerUrl && this.token);
		return {
			enabled: this.enabled,
			configured,
			label: !this.enabled ? '已禁用' : configured ? `已配置 -> ${this.toUser}` : '未配置（缺 centerUrl 或 token）',
			...this.stats,
	 };
	}

	/**
	 * @param {{title:string, body:string, to?:string, url?:string, kind?:string, throttleMs?:number}} msg
	 */
	async send(msg = {}) {
		const title = String(msg.title ?? '').trim();
		const body = String(msg.body ?? '').trim();
		if (!title || !body) return { ok: false, error: 'title/body 不能为空' };
		if (!this.enabled) return { ok: false, skipped: 'disabled' };
		if (!this.centerUrl || !this.token) {
			this.log('[notify] 未配置 centerUrl/token，跳过企业微信通知');
			return { ok: false, skipped: 'not_configured' };
		}
		const throttleMs = msg.throttleMs ?? THROTTLE_MS_DEFAULT;
		const key = `${msg.kind ?? 'notice'}|${title}`;
		if (throttleMs > 0) {
			const last = this.lastSent.get(key) ?? 0;
			if (Date.now() - last < throttleMs) {
				this.stats.throttled++;
				return { ok: false, skipped: 'throttled', until: last + throttleMs };
			}
		}
		const payload = {
			title: title.slice(0, 120),
			body: body.slice(0, 2000),
			to: msg.to || this.toUser,
			url: msg.url || '',
			// center 可以按 kind 不用的模板（run_done / approval / approval_timeout / long_run / pi_exit ...）
			kind: msg.kind ?? 'notice',
		};
		try {
			const res = await fetch(`${this.centerUrl}/ui/api/pi/notify`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-pi-token': this.token },
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(15_000),
			});
			const text = await res.text();
			if (!res.ok) {
				this.stats.failed++;
				this.stats.lastError = `HTTP ${res.status} ${text.slice(0, 200)}`;
				this.log(`[notify] 失败 HTTP ${res.status}: ${text.slice(0, 300)}`);
				return { ok: false, error: this.stats.lastError };
			}
			let parsed = null;
			try {
				parsed = JSON.parse(text);
			} catch {
				/* center 有时返回纯文本 */
			}
			if (parsed && parsed.status !== undefined && parsed.status !== 'ok' && parsed.status !== 200 && parsed.errcode !== 0 && parsed.success === false) {
				this.stats.failed++;
				this.stats.lastError = parsed.message ?? parsed.error ?? JSON.stringify(parsed).slice(0, 200);
				this.log(`[notify] center 返回异常：${this.stats.lastError}`);
				return { ok: false, error: this.stats.lastError, response: parsed };
			}
			this.lastSent.set(key, Date.now());
			this.stats.sent++;
			this.stats.lastSentAt = new Date().toISOString();
			this.log(`[notify] 已发送 -> ${payload.to}: ${title}`);
			return { ok: true, response: parsed };
		} catch (err) {
			this.stats.failed++;
			this.stats.lastError = err?.message ?? String(err);
			this.log(`[notify] 请求失败：${err?.message}`);
			return { ok: false, error: this.stats.lastError };
		}
	}
}
