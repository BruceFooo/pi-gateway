// steer / follow-up / abort 专项验证：用一次可控的长工具调用（bash sleep）制造「运行中」窗口。
// 用法：node scripts/verify-steer.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/config.json'), 'utf8'));
const URL = `ws://127.0.0.1:${cfg.port}/pi/ws?token=${encodeURIComponent(cfg.token)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, d = '') => { results.push([ok ? 'PASS' : 'FAIL', n, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  :: ' + d : ''}`); };

const ws = new WebSocket(URL);
let rid = 0;
const pending = new Map();
const events = [];
const seq = () => `v${++rid}`;
const send = (o) => ws.send(JSON.stringify(o));
const req = (type, extra = {}) => new Promise((resolve) => {
	const id = seq();
	pending.set(id, resolve);
	send({ ...extra, type, id });
	setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ ok: false, error: type + ' 超时' }); } }, 60000);
});
ws.addEventListener('message', (ev) => {
	const m = JSON.parse(String(ev.data));
	if (m.type === 'response' || m.type === 'ready') { const cb = pending.get(m.id); if (cb) { pending.delete(m.id); cb(m); } return; }
	events.push(m);
});
const evs = (t) => events.filter((e) => (e.event ?? e.type) === t);
const waitEvent = async (t, ms = 120000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const e = evs(t).at(-1); if (e) return e; await sleep(300); } return null; };

await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('连不上')), { once: true }); });
await sleep(1500);

console.log('--- 起一个可控的长工具轮（bash sleep 40） ---');
const r1 = await req('chat_send', { text: '现在请调用 bash 工具执行命令：sleep 40 && echo SLEPT 。不要做别的事，不要读文件。执行完回我一句「睡完了」。' });
check('chat_send 排队', r1.ok === true, JSON.stringify(r1.data ?? r1.error));
const toolStart = await waitEvent('tool_start', 180000);
check('工具确实起来了（才有运行中窗口）', !!toolStart, toolStart ? `${toolStart.toolName} ${JSON.stringify(toolStart.args ?? {}).slice(0, 60)}` : '没等到 tool_start');
const id1 = r1.data?.id;
console.log('  queue:', JSON.stringify((await req('queue_list')).data?.queue));

console.log('\n--- 运行中发 steer ---');
const st = await req('chat_steer', { text: '别睡 40 秒了，直接执行 echo STEERED 就好。' });
check('chat_steer 被接受', st.ok === true && st.data?.steered === true, JSON.stringify(st.data ?? st.error));
const st2 = await req('chat_steer', { text: '再补一条：结束时告诉我你有没有收到 steer。' });
check('连续第二条 steer 也在运行中被接受（多请求串行处理）', st2.ok === true, JSON.stringify(st2.data ?? st2.error));

console.log('\n--- 运行中发 follow-up（应排在 steer 之后、本轮结束后才生效） ---');
const fu = await req('chat_followup', { text: '这一轮结束后，请只回复两个字：收尾。' });
check('chat_followup 被接受', fu.ok === true && fu.data?.followed === true, JSON.stringify(fu.data ?? fu.error));

console.log('\n--- 等本轮结束（最多 300s） ---');
const settled1 = await waitEvent('agent_settled', 300000);
check('本轮结束', !!settled1, settled1 ? 'agent_settled' : '超时');
const tools = evs('tool_start').map((e) => JSON.stringify(e.args ?? {}).slice(0, 50));
console.log('  工具调用参数：', JSON.stringify(tools));
check('steer 生效：命令里没有 sleep 40', !tools.some((t) => t.includes('sleep 40')), JSON.stringify(tools));

console.log('\n--- follow-up 应自动触发第二轮（我只发了三次消息，没再排队新任务） ---');
const settled2 = await waitEvent('agent_settled', 240000);
check('follow-up 自动接上第二轮', !!settled2 && evs('agent_settled').length >= 2, `settled=${evs('agent_settled').length}`);
check('队列里没有我自己的排队项（follow-up 不落我的队列）', (await req('queue_list')).data?.running == null);

console.log('\n--- abort：起一轮然后中止 ---');
const before = evs('agent_settled').length;
const r2 = await req('chat_send', { text: '请调用 bash 工具执行 sleep 45 && echo DONE45 ，然后回我一句「好了」。不要做别的事。' });
const ts2 = await waitEvent('tool_start', 180000);
check('第二轮工具起来了', !!ts2, ts2 ? ts2.toolName : '没等到');
const ab = await req('abort', {});
check('abort 被接受', ab.ok === true, JSON.stringify(ab.data ?? ab.error));
const st3 = await waitEvent('state', 30000);
let idle = null;
for (let i = 0; i < 40 && !idle; i++) { const s = (await req('state')).data; if (s && !s.isStreaming && s.runState === 'idle') idle = s; else await sleep(1500); }
check('中止后 runState 回 idle、isStreaming=false（不会卡死单并发）', !!idle, JSON.stringify(idle ?? (await req('state')).data));
const q = (await req('queue_list')).data;
check('中止后队列放行（running 为空）', q?.running == null, JSON.stringify(q));

const fails = results.filter((r) => r[0] === 'FAIL');
console.log(`\n合计 ${results.length} 检查，FAIL ${fails.length}`);
for (const f of fails) console.log('  FAIL ' + f[1] + (f[2] ? ' :: ' + f[2] : ''));
try { ws.close(); } catch { /* noop */ }
process.exit(fails.length ? 1 : 0);
