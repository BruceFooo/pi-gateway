// 改名闭环验证：session_rename → 再读 session_list 的 title（pi RPC set_session_name 会往会话
// 文件追加 session_info，网关 #readMeta 必须按时间戳取最新，否则改完名列表里还是旧名）。
// 用法：node scripts/verify-rename.mjs [新名字]

import fs from 'node:fs';

const cfgPath = new URL('../config/config.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const url = process.env.PI_SMOKE_URL ?? `ws://${cfg.host}:${cfg.port}/pi/ws`;
const tok = process.env.PI_GATEWAY_TOKEN ?? cfg.token;
const newName = process.argv[2] ?? '手机控制台';

const ws = new WebSocket(`${url}?token=${encodeURIComponent(tok)}`);
const pending = new Map();
let seq = 0;

function req(type, params = {}) {
	return new Promise((resolve, reject) => {
		const id = `r${++seq}`;
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, type, ...params }));
		setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error('超时 ' + type))), 15_000);
	});
}

ws.addEventListener('message', (ev) => {
		const m = JSON.parse(String(ev.data));
	if (m.type !== 'response' || !m.id) return;
	const p = pending.get(m.id);
	if (!p) return;
	pending.delete(m.id);
	m.ok ? p.resolve(m.data) : p.reject(new Error(m.error ?? '失败'));
});

const hard = setTimeout(() => { console.log('RENAME FAIL: 超时'); process.exit(1); }, 60_000);

ws.addEventListener('open', async () => {
	try {
		const before = await req('session_list');
		const boundId = before.bound ?? before.active;
		const titleBefore = before.sessions.find((s) => s.sessionId === boundId)?.title ?? '(无名)';
		await req('session_rename', { sessionId: boundId, name: newName });
		await new Promise((r) => setTimeout(r, 1200));
		const after = await req('session_list');
		const titleAfter = after.sessions.find((s) => s.sessionId === boundId)?.title ?? '(无名)';
		console.log(`bound=${boundId} 改名前=${JSON.stringify(titleBefore)} 改名后=${JSON.stringify(titleAfter)}`);
		if (titleAfter !== newName) { console.log('RENAME FAIL: 列表里还是旧名'); process.exit(1); }
		console.log('RENAME PASS');
		clearTimeout(hard);
		process.exit(0);
	} catch (e) {
		console.log('RENAME FAIL: ' + e.message);
		process.exit(1);
	}
});
ws.addEventListener('error', () => { console.log('RENAME FAIL: 连不上 ' + url); process.exit(1); });
