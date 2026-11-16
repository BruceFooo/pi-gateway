#!/usr/bin/env node
/**
 * 人在环路的端到端验证：让 pi 主动「问用户一个问题」（扩展的 select 对话框），
 * 网关应变成 waiting_approval、发微信通知、手机端作答、pi 收到答案后继续。
 * 用法：node scripts/verify-ask.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/config.json'), 'utf8'));
const URL = 'ws://127.0.0.1:33336/pi/ws';
const ws = new WebSocket(`${URL}?token=${encodeURIComponent(cfg.token)}`);

const pending = new Map();
const approvalEvents = [];
let seq = 0, ready = null;
const events = [];
let settled = null, approvalNotified = null;
let n = 0;
const check = (ok, label, extra = '') => { n++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  :: ' + extra : ''}`); if (!ok) process.exitCode = 1; };
const waitEvent = (match, ms = 60000) => new Promise((res, rej) => {
	const timer = setTimeout(() => rej(new Error('等不到事件')), ms);
	const iv = setInterval(() => {
		const hit = events.find(match);
		if (hit) { clearInterval(iv); clearTimeout(timer); res(hit); }
	}, 150);
});

ws.addEventListener('message', (ev) => {
	const m = JSON.parse(String(ev.data));
	if (m.type === 'event') {
		seq = m.seq ?? seq;
		events.push(m);
		if (m.event === 'approval_requested') approvalEvents.push(m);
		if (m.event === 'agent_settled') settled = m;
		return;
	}
	if (m.type === 'ready') { ready = m; return; }
	const p = pending.get(m.id);
	if (p) { pending.delete(m.id); p(m); }
});
function req(type, extra = {}, ms = 60000) {
	const id = 'a' + Math.random().toString(36).slice(2, 10);
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => { pending.delete(id); reject(new Error(type + ' 超时')); }, ms);
		pending.set(id, (m) => { clearTimeout(t); resolve(m); });
		ws.send(JSON.stringify({ ...extra, type, id }));
	});
}
const hits = async () => {
	const r = await fetch('http://127.0.0.1:33399/hits').catch(() => null);
	return r?.ok ? (await r.json()).hits ?? [] : [];
};

await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('连不上')), { once: true }); });
await new Promise((res) => setTimeout(res, 800));
const base = (await hits()).length;

console.log('=== 让 pi 用手机端提问（扩展 select 对话框）===');
const r = await req('chat_send', { text: '请用 question 工具问我一个选择题：今天选哪个颜色？选项必须是「红色」和「蓝色」两个。等我回答之后，把你的结论用一句话复述出来。' });
check(!!r.ok, 'chat_send 排队', JSON.stringify(r.data ?? r.error));

let ap = null;
try { ap = await waitEvent((e) => e.event === 'approval_requested', 90000); } catch { /* 见断言 */ }
check(!!ap, 'pi 的问题到达网关（approval_requested）', ap ? `${ap.approval?.method} options=${JSON.stringify(ap.approval?.options)}` : '没等到');
if (ap) {
	const st = (await req('state')).data;
	check('网关状态变为 waiting_approval', st?.runState === 'waiting_approval', `runState=${st?.runState} waiting=${st?.waitingApproval}`);
	const apv = (await req('approval_list')).data?.approvals ?? [];
	check('approval_list 能看到这个问题', apv.length >= 1, JSON.stringify(apv.map((x) => ({ id: x.id, method: x.method, title: (x.title ?? '').slice(0, 40), options: x.options?.map((o) => o.label ?? o) }))).slice(0, 300));
	// 选项 label/value 必须与 pi 的 options 字符串一致（前端要回传原值）
	const opts = ap.approval?.options ?? [];
	const blue = opts.find((o) => String(o.label ?? o).includes('蓝'));
	check('选项里有「蓝色」可点', !!blue, JSON.stringify(opts).slice(0, 200));

	const st2 = (await req('state')).data;
	// 问题这一轮不应该被算作 run 结束
	check('提问时队列仍是这一项在跑', (await req('queue_list')).data?.running != null, JSON.stringify((await req('queue_list')).data?.running?.title ?? null));
	void st2;

	// 手机端作答
	const value = blue ? (blue.value ?? blue.label) : '蓝色';
	const res = await req('approval_resolve', { id: ap.approval?.id, value });
	check('作答被接受', !!res.ok, JSON.stringify(res.data ?? res.error));
}

try { settled = await waitEvent((e) => e.event === 'agent_settled', 180000); } catch { /* 见断言 */ }
check('pi 收到答案后把这一轮跑完', !!settled, settled ? `aborted=${settled.aborted}` : '没等到 agent_settled');
const q = (await req('queue_list')).data;
check('队列放行', q?.running == null, JSON.stringify(q));

const tr = (await req('session_transcript', { sessionId: ready.bound })).data;
const texts = (tr?.lines ?? []).filter((l) => l.kind === 'assistant').map((l) => l.text);
const last = texts.at(-1) ?? '';
check('pi 的回答体现了我选的颜色', /蓝/.test(last), JSON.stringify(last).slice(0, 200));

const now = await hits();
const apHit = now.slice(base).find((h) => (h.body?.title ?? '').includes('确认') || (h.body?.title ?? '').includes('问'));
check('提问时发过微信通知', !!apHit, apHit ? `《${apHit.body?.title}》` : `新增 ${now.length - base} 条：${JSON.stringify(now.slice(base).map((h) => h.body?.title))}`);
ws.close();
