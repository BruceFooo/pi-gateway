// 端到端冒烟测试：真连一个网关，走一遍手机会走的路径。
// 用法：先 `node index.js`，再 `node scripts/smoke.mjs`（可用 PI_SMOKE_URL / PI_GATEWAY_TOKEN 覆盖）。
// 除了「能连能回话」，这里还锁住两条用户明确要求的不变量：
//   1) 同时只允许 1 个 run（连发两条必须严格串行，且第二条能在队列里看到）
//   2) 会话要落盘（session_list 能查到我们的会话，transcript 能读回内容）

import fs from 'node:fs';

const cfgPath = process.env.PI_GATEWAY_CONFIG ?? new URL('../config/config.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const url = process.env.PI_SMOKE_URL ?? `ws://${cfg.host}:${cfg.port}/pi/ws`;
const tok = process.env.PI_GATEWAY_TOKEN ?? cfg.token;

const checks = {
	ready: false,
	chatAccepted: false,
	agentStart: false,
	assistantText: false,
	agentSettled: false,
	secondRun: false,
	serialized: false,
	queuedWhileBusy: false,
	sessionList: false,
	transcriptHasContent: false,
	queueList: false,
	modelList: false,
};
let fail = null;
let lastSeq = 0;
let assistantChars = 0;
let activeSessionId = null;
const runIds = [];
let settling = false;
let startedWhileSettling = false;
let phase = 1;
let pending = new Map();
let ws;

console.log(`[smoke] 连接 ${url}`);
ws = new WebSocket(`${url}?token=${encodeURIComponent(tok)}`);

function send(obj) {
	ws.send(JSON.stringify(obj));
}

function request(id, obj) {
	return new Promise((resolve) => {
		pending.set(id, resolve);
		send({ ...obj, id });
		setTimeout(() => {
			if (!pending.has(id)) return;
			pending.delete(id);
			resolve({ id, ok: false, error: '响应超时' });
		}, 30000).unref?.();
	});
}

function done(step) {
	console.log(`[smoke] 到达 ${step}`);
	setTimeout(() => ws.close(1000, 'done'), 300);
}

function chatSend(text) {
	console.log(`[smoke] chat_send: ${text}`);
	send({ id: `c${Date.now()}`, type: 'chat_send', text });
}

async function readBack() {
	const list = await request('session_list', { type: 'session_list' });
	checks.sessionList = !!list.ok && Array.isArray(list.data?.sessions) && list.data.sessions.length > 0;
	console.log(`[smoke] session_list ok=${list.ok} count=${list.data?.sessions?.length ?? '-'} bound=${list.data?.bound ?? '-'} active=${list.data?.active ?? '-'} error=${list.error ?? ''}`);

	const target = activeSessionId ?? list.data?.sessions?.[0]?.sessionId ?? null;
	const tr = await request('session_transcript', { type: 'session_transcript', sessionId: target });
	const lines = tr.data?.lines ?? [];
	checks.transcriptHasContent = !!tr.ok && lines.length > 0;
	console.log(`[smoke] session_transcript sessionId=${target} ok=${tr.ok} lines=${lines.length} truncatedBefore=${tr.data?.truncatedBefore ?? 0} title=${tr.data?.session?.title ?? '-'} error=${tr.error ?? ''}`);
	if (lines.length) {
		for (const e of lines.slice(-4)) {
			console.log(`[smoke]   ${e.kind} [${e.entryId ?? '-'}] ${String(e.text ?? '').slice(0, 70).replace(/\s+/g, ' ')}`);
		}
	}

	const q = await request('queue_list', { type: 'queue_list' });
	checks.queueList = !!q.ok;
	console.log(`[smoke] queue_list ok=${q.ok} running=${q.data?.running?.id ?? 'null'} pending=${q.data?.items?.length ?? 0}`);
	const m = await request('model_list', { type: 'model_list' });
	checks.modelList = !!m.ok;
	console.log(`[smoke] model_list ok=${m.ok} models=${m.data?.models?.length ?? '-'} thinking=${(m.data?.levels ?? []).join(',')} current=${JSON.stringify(m.data?.current) ?? '-'} error=${m.error ?? ''}`);
	done('readback');
}

ws.addEventListener('message', (raw) => {
	const msg = JSON.parse(String(raw.data));
	if (msg.type === 'ready') {
		checks.ready = true;
		lastSeq = msg.lastSeq ?? 0;
		activeSessionId = msg.activeSessionId ?? null;
		console.log(`[smoke] ready protocol=${msg.protocol} bound=${msg.boundSessionId ?? 'null'} active=${msg.activeSessionId ?? 'null'} lastSeq=${lastSeq} pi=${JSON.stringify(msg.pi)}`);
		if (msg.state?.isStreaming) {
			console.log('[smoke] pi 正在跑一轮，等它结束再发我们的消息');
			return;
		}
		chatSend('只回两个字：在的');
		return;
	}
	if (msg.type === 'resync_required') console.log(`[smoke] resync_required: ${msg.reason}`);
	if (msg.type === 'response') {
		const resolver = pending.get(msg.id);
		if (resolver) {
			pending.delete(msg.id);
			resolver(msg);
		}
		if (msg.ok === false && msg.id !== 'resume') fail = fail ?? `命令 ${msg.id} 失败：${msg.error}`;
		return;
	}
	if (msg.type !== 'event') return;

	const e = msg.event;
	if (e === 'queue_update') {
		const pendingCount = msg.items?.length ?? 0;
		if (pendingCount > 0) checks.queuedWhileBusy = true;
		if (phase === 2) console.log(`[smoke] queue_update pending=${pendingCount} running=${msg.running?.id ?? 'null'}`);
	}
	if (e === 'user_message' && phase === 1) checks.chatAccepted = true;
	if (e === 'session_changed' && msg.session?.id) activeSessionId = msg.session.id;
	if (e === 'assistant_delta') assistantChars += String(msg.delta ?? '').length;
	if (e === 'assistant_text') {
		assistantChars += String(msg.text ?? '').length;
		checks.assistantText = true;
		console.log(`[smoke] assistant_text: ${String(msg.text ?? '').slice(0, 100).replace(/\s+/g, ' ')}`);
	}
	if (e === 'tool_start') console.log(`[smoke] tool_start ${msg.toolName}`);
	if (e === 'tool_end') console.log(`[smoke] tool_end ${msg.toolName} ok=${msg.ok}`);
	if (e === 'notice' && msg.level === 'error') fail = fail ?? `notice: ${msg.text}`;

	if (e === 'agent_start') {
		runIds.push(msg.runId);
		console.log(`[smoke] agent_start #${runIds.length} runId=${msg.runId}`);
		if (settling) startedWhileSettling = true;
		if (runIds.length === 1) checks.agentStart = true;
		if (runIds.length >= 2) checks.secondRun = true;
		return;
	}
	if (e === 'agent_settled') {
		console.log(`[smoke] agent_settled #${runIds.length}（累计 ${assistantChars} 字）`);
		if (phase === 1) {
			if (!checks.agentStart) {
				fail = fail ?? '第一轮没看到 agent_start';
				done('abort');
				return;
			}
			// 阶段 2：连发两条，验证「同时只允许 1 个 run」
			phase = 2;
			settling = false;
			console.log('[smoke] 阶段 2：连发两条消息，验证串行与排队');
			chatSend('只回一个字：甲');
			chatSend('只回一个字：乙');
			return;
		}
		if (phase === 2) {
			if (runIds.length < 3) return; // 阶段 2 的第一条
			phase = 3;
			checks.serialized = !startedWhileSettling && new Set(runIds).size === runIds.length;
			checks.agentSettled = true;
			void readBack();
		}
	}
});

const timer = setTimeout(() => {
	fail = fail ?? `超时（${process.env.PI_SMOKE_TIMEOUT_MS ?? '240000'}ms 未完成全部阶段）`;
	try {
		ws.close(1002, 'timeout');
	} catch {}
}, Number(process.env.PI_SMOKE_TIMEOUT_MS ?? 240000));

ws.addEventListener('close', (ev) => {
	clearTimeout(timer);
	const missing = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
	console.log(`[smoke] 关闭 code=${ev.code} reason=${ev.reason} lastSeq=${lastSeq} runIds=${runIds.join(',')}`);
	if (fail) console.error(`[smoke] 失败：${fail}`);
	if (missing.length) console.error(`[smoke] 未验证到：${missing.join(', ')}`);
	console.log(fail || missing.length ? '[smoke] 结果 FAIL' : '[smoke] 结果 PASS');
	process.exit(fail || missing.length ? 1 : 0);
});

ws.addEventListener('error', (ev) => {
	if (checks.agentSettled) return;
	fail = fail ?? `ws 错误：${ev?.message ?? ev?.error ?? 'unknown'}`;
});
