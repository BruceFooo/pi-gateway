// 通知触发路径验证（配合 scripts/notify-stub.mjs）：确认网关确实在「完成」和「需要确认」时发出通知，
// 且带对了 token 头、收件人、标题、正文与深链。不依赖服务器上的 center。
// 用法：先 node scripts/notify-stub.mjs，再 node scripts/verify-notify.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/config.json'), 'utf8'));
const URL = `ws://127.0.0.1:${cfg.port}/pi/ws?token=${encodeURIComponent(cfg.token)}`;
// 本地自测时两边都要指到 stub：网关用 PI_NOTIFY_CENTER_URL（重启时传），脚本用同名环境变量。
const STUB = (process.env.PI_NOTIFY_CENTER_URL ?? cfg.notify?.centerUrl ?? 'http://127.0.0.1:33399').replace(/\/+$/, '') + '/hits';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, d = '') => { results.push([ok ? 'PASS' : 'FAIL', n, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  :: ' + d : ''}`); };

const ws = new WebSocket(URL);
let rid = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (ev) => {
	const m = JSON.parse(String(ev.data));
	if (m.type === 'response' || m.type === 'ready') { const cb = pending.get(m.id); if (cb) { pending.delete(m.id); cb(m); } return; }
	events.push(m);
});
const req = (type, extra = {}) => new Promise((resolve) => {
	const id = `n${++rid}`;
	pending.set(id, resolve);
	ws.send(JSON.stringify({ ...extra, type, id }));
	setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ ok: false, error: type + ' 超时' }); } }, 30000);
});
const evs = (t) => events.filter((e) => (e.event ?? e.type) === t);
const waitEvent = async (t, ms = 240000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const e = evs(t).at(-1); if (e) return e; await sleep(400); } return null; };
const hits = async () => { try { return (await (await fetch(STUB)).json()).hits ?? []; } catch (e) { return []; } };
const token = cfg.token;

await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('连不上网关')), { once: true }); });
await sleep(1500);

console.log('=== 1) 一轮短任务，完成时应发「任务完成」通知 ===');
const base = (await hits()).length;
const r1 = await req('chat_send', { text: '只回复两个字：好。不要调用任何工具，不要读文件。' });
check('chat_send 排队', r1.ok === true, JSON.stringify(r1.data ?? r1.error));
const settled = await waitEvent('agent_settled', 300000);
check('本轮结束', !!settled, settled ? 'agent_settled' : '超时');
await sleep(1500);
let list = await hits();
check('完成后 stub 收到新通知', list.length > base, `base=${base} now=${list.length}`);
const done = list.slice(base).find((h) => (JSON.parse(h.body || '{}').title ?? '').includes('任务'));
check('通知走的是 POST /ui/api/pi/notify', done?.method === 'POST' && done?.path?.includes('/ui/api/pi/notify'), `${done?.method} ${done?.path}`);
const pd = (() => { try { return JSON.parse(done?.body ?? '{}'); } catch { return {}; } })();
check('带对了 token 头', !!done?.token && done.token === token, done?.token ? done.token.slice(0, 8) + '…' : '无');
check('收件人是 opsUser', pd.to === (cfg.notify?.toUser ?? 'opsUser'), `to=${pd.to}`);
check('标题形如 任务完成：xxx', /^任务(完成|结束)：/.test(pd.title ?? ''), pd.title);
check('正文含摘要与深链', !!pd.body && !!pd.url, `url=${pd.url}`);
console.log(`  title=${JSON.stringify(pd.title)}\n  body=${JSON.stringify((pd.body ?? '').slice(0, 120))}\n  kind=${pd.kind}`);

console.log('\n=== 2) 请求执行命令 → 需要确认 → 应发「任务需要你确认」通知 ===');
const base2 = (await hits()).length;
const victim = '<用户主目录>/pi-gw-approval-test.txt';
fs.writeFileSync(victim, 'must-survive');
const r2 = await req('chat_send', { text: '请调用 bash 工具执行这条命令：rm -f <用户主目录>/pi-gw-approval-test.txt 。只做这一件事，不要做其它事。' });
check('chat_send 排队', r2.ok === true, JSON.stringify(r2.data ?? r2.error));
const ap = await waitEvent('approval_requested', 180000);
const appr = ap?.approval ?? null;
check('出现审批请求（说明权限确认会走到网关）', !!appr, appr ? `${appr.method} ${appr.title} options=${JSON.stringify(appr.options)}` : '没等到 approval_requested');
await sleep(1500);
list = await hits();
const apHit = list.slice(base2).find((h) => (JSON.parse(h.body || '{}').title ?? '').includes('确认'));
check('审批通知已发出', !!apHit, `新增 ${list.length - base2} 条`);
const pa = (() => { try { return JSON.parse(apHit?.body ?? '{}'); } catch { return {}; } })();
check('审批通知标题正确', (pa.title ?? '').includes('任务需要你确认'), pa.title);
check('审批通知正文带上了要确认的内容', !!pa.body && pa.body.length > 10, JSON.stringify((pa.body ?? '').slice(0, 140)));
check('审批通知 kind=approval', pa.kind === 'approval', pa.kind);

// 拒绝执行，别真跑命令（网关会把 'deny' 映射成 pi 的选项原文，比如 "Block"）
const resolved = await req('approval_resolve', { id: appr?.id, value: 'deny' });
check('approval_resolve(deny) 生效', resolved.ok === true && resolved.data?.rpcSuccess !== false, JSON.stringify(resolved.data ?? resolved.error));
const settled2 = await waitEvent('agent_settled', 240000);
check('拒绝后本轮仍能收口（不会卡死单并发）', !!settled2, settled2 ? 'agent_settled' : '超时');
const q = (await req('queue_list')).data;
check('队列放行', q?.running == null, JSON.stringify(q));
const survived = fs.existsSync(victim);
check('拒绝后 rm 确实没执行（文件还在，说明审批是硬门禁）', survived, `文件存在=${survived}`);
try { fs.unlinkSync(victim); } catch { /* noop */ }

console.log('\n=== 收到的全部通知 ===');
for (const h of await hits()) {
	let b = {};
	try { b = JSON.parse(h.body); } catch { /* noop */ }
	console.log(`  ${h.at} ${h.method} ${h.path} token=${h.token ? '✔' : '✘'} [${b.kind}] ${b.to} 《${b.title}》`);
}

const fails = results.filter((r) => r[0] === 'FAIL');
console.log(`\n合计 ${results.length} 检查，FAIL ${fails.length}`);
for (const f of fails) console.log('  FAIL ' + f[1] + (f[2] ? ' :: ' + f[2] : ''));
try { ws.close(); } catch { /* noop */ }
process.exit(fails.length ? 1 : 0);
