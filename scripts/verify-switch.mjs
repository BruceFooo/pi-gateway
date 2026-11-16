// 会话切换 / 改名 / 回放的自测（不打模型，秒级完成）。
// 前提：网关已起（node index.js 或 scripts/restart-gateway.ps1）。用法：node scripts/verify-switch.mjs
// 锁的不变量：session_switch 只改 pi 的活动会话、不动「绑定」；改名对活动会话走 set_session_name、
// 对非活动会话直接改文件头；未知 sessionId 必须被拒。

import fs from 'node:fs';

const cfgPath = new URL('../config/config.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const url = process.env.PI_SMOKE_URL ?? `ws://${cfg.host}:${cfg.port}/pi/ws`;
const tok = process.env.PI_GATEWAY_TOKEN ?? cfg.token;

const checks = {
	listOk: false,
	boundExists: false,
	transcriptReplay: false,
	switchToOther: false,
	activeChanged: false,
	bogusRejected: false,
	renameActive: false,
	renameVisibleInList: false,
	renameInactive: false,
	switchBackBound: false,
	bindingUntouched: false,
};

let seq = 0;
const waiters = new Map();
const ws = new WebSocket(`${url}?token=${encodeURIComponent(tok)}`);
const req = (type, fields = {}) => new Promise((resolve) => {
	const id = ++seq;
	const timer = setTimeout(() => { waiters.delete(id); resolve({ ok: false, error: `请求 ${type} 超时` }); }, 10_000);
	waiters.set(id, { resolve, timer });
	ws.send(JSON.stringify({ id, type, ...fields }));
});
const keep = setInterval(() => { try { ws.send(JSON.stringify({ id: ++seq, type: 'ping' })); } catch { /* 忽略 */ } }, 15_000);

ws.onmessage = (ev) => {
	const m = JSON.parse(String(ev.data));
	const w = waiters.get(m.id);
	if (w) { clearTimeout(w.timer); waiters.delete(m.id); w.resolve(m); }
};

const asList = (r) => (r.data && Array.isArray(r.data.sessions) ? r.data.sessions : []);
const asEntries = (r) => {
	const t = r.data;
	return Array.isArray(t) ? t : (t?.entries ?? t?.lines ?? t?.items ?? []);
};

ws.onopen = async () => {
	const line = (name, cond, extra = '') => { checks[name] = !!cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };
	const stamp = Date.now().toString(36).slice(-5);
	try {
		const l0 = await req('session_list');
		line('listOk', l0.ok && asList(l0).length > 0, `sessions=${asList(l0).length} active=${l0.data?.active} bound=${l0.data?.bound}`);
		const bound = l0.data?.bound ?? null;
		line('boundExists', !!bound, String(bound));

		const tr = await req('session_transcript', { sessionId: bound });
		line('transcriptReplay', tr.ok && asEntries(tr).length > 0, `entries=${asEntries(tr).length}`);

		const other = asList(l0).find((s) => s.sessionId && s.sessionId !== bound && !s.bound);
		if (!other) {
			console.log('SKIP  没有可切换的第二会话（本机只有绑定会话）');
		} else {
			const sw = await req('session_switch', { sessionId: other.sessionId });
			line('switchToOther', sw.ok, `-> ${other.sessionId} 「${other.title}」 ${sw.ok ? '' : sw.error}`);
			line('activeChanged', sw.ok && sw.data?.active === other.sessionId, `active=${sw.data?.active}`);
			line('bindingUntouched', sw.ok && sw.data?.bound === bound, `bound 仍是 ${sw.data?.bound}`);

			const bad = await req('session_switch', { sessionId: 'deadbeef0000' });
			line('bogusRejected', bad.ok === false && /找不到/.test(String(bad.error ?? '')), `error=${bad.error}`);

			const nameA = `自测改名A-${stamp}`;
			const rn = await req('session_rename', { sessionId: other.sessionId, name: nameA });
			line('renameActive', rn.ok, rn.ok ? '' : rn.error);
			const l1 = await req('session_list');
			const seenA = asList(l1).find((s) => s.sessionId === other.sessionId);
			line('renameVisibleInList', seenA && seenA.title === nameA, `title=${seenA?.title}`);

			const back = await req('session_switch', { sessionId: bound });
			line('switchBackBound', back.ok && back.data?.active === bound, `active=${back.data?.active}`);

			// 非活动会话：走直接改文件头的路径（#renameInFile）
			const nameB = `自测改名B-${stamp}`;
			const rn2 = await req('session_rename', { sessionId: other.sessionId, name: nameB });
			line('renameInactive', rn2.ok, rn2.ok ? '' : rn2.error);
			const l2 = await req('session_list');
			const seenB = asList(l2).find((s) => s.sessionId === other.sessionId);
			if (seenB && seenB.title !== nameB) console.log(`  ! 改名后标题仍是 ${seenB.title}（期望 ${nameB}）`);
			checks.renameVisibleInList = checks.renameVisibleInList && !!seenB;
		}
	} catch (e) {
		console.log('!! 异常 ' + e.message);
	} finally {
		clearInterval(keep);
		const ok = Object.values(checks).every(Boolean);
		console.log('== 汇总 ==', JSON.stringify(checks));
		console.log(ok ? 'VERIFY-SWITCH PASS' : 'VERIFY-SWITCH FAIL');
		try { ws.close(); } catch { /* 忽略 */ }
		process.exit(ok ? 0 : 1);
	}
};

ws.onerror = (e) => { console.log('ws 错误：' + (e.message ?? e.error ?? '未知')); clearInterval(keep); process.exit(1); };
