// 离线验证启动通知的状态机：不启动网关、不发真通知，只喂假 notifier + 固定时钟。
//   node scripts/verify-boot-notify.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { announceBoot, markCleanExit, markPlannedRestart } from '../src/boot-notify.mjs';

const fails = [];
function check(name, cond, detail = '') {
	if (cond) console.log(`  ok   ${name}`);
	else {
		fails.push(name);
		console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
	}
}

class FakeNotifier {
	constructor(fail = false) {
		this.sends = [];
		this.fail = fail;
	}
	async send(msg) {
		this.sends.push(msg);
		if (this.fail) throw new Error('center 连不上');
		return { ok: true };
	}
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-notify-'));
const t0 = Date.UTC(2026, 10, 17, 0, 0, 0);
const MIN = 60_000;
const n = new FakeNotifier();
const logs = [];
const log = (...a) => logs.push(a.join(' '));
const boot = (opts) => announceBoot({ notifier: n, stateDir: dir, log, now: t0, ...opts });

console.log('[1] 首次启动');
let r = await boot({ port: 33336 });
check('首次启动会发通知', r.sent === true, JSON.stringify(r));
check('正文说没有上次记录', /没有上次运行的记录/.test(r.body ?? ''), r.body);
check('kind=gateway_boot 且不节流', n.sends.at(-1)?.kind === 'gateway_boot' && n.sends.at(-1)?.throttleMs === 0, JSON.stringify(n.sends.at(-1)));
check('正文带 pid 与端口', /pid=\d+/.test(r.body) && /监听 33336/.test(r.body), r.body);
check('写了心跳', fs.existsSync(path.join(dir, 'boot.json')));

console.log('[2] 崩溃后重启（10 分钟内第 2 次）');
r = await boot({ now: t0 + MIN });
check('第 2 次带计数', r.sent === true && /10 分钟内第 2 次/.test(r.title ?? ''), r.title);
check('正文点明没正常退出', /没有正常退出的记录（可能崩溃或被强杀）/.test(r.body ?? ''), r.body);
check('正文带崩溃循环提示', /崩溃循环/.test(r.body ?? ''), r.body);

console.log('[3] 崩溃循环：窗口内第 3 次仍发，第 4 次起只写日志');
r = await boot({ now: t0 + 2 * MIN });
check('第 3 次仍发', r.sent === true && /第 3 次/.test(r.title ?? ''), r.title);
const sentAfter3 = n.sends.length;
for (let i = 4; i <= 6; i++) r = await boot({ now: t0 + (i - 1) * MIN });
check('第 4 次起 skipped=loop', r.sent === false && r.skipped === 'loop' && r.count >= 4, JSON.stringify(r));
check('循环期间不再发通知', n.sends.length === sentAfter3, `${sentAfter3} -> ${n.sends.length}`);
check('循环期间写了日志', logs.some((l) => /只写日志不再通知手机/.test(l)), logs.slice(-2).join(' | '));

console.log('[4] 正常退出后再启动（措辞不同、计数重置）');
markCleanExit({ stateDir: dir, now: t0 + 40 * MIN });
r = await boot({ now: t0 + 41 * MIN });
check('正文说上次正常退出', r.sent === true && /上次正常退出（收到停止信号）/.test(r.body ?? ''), r.body);
check('计数已重置（标题无次数）', r.title === 'pi 网关已启动', r.title);

console.log('[5] 计划内重启不发通知（记号被消费）');
markPlannedRestart({ stateDir: dir, reason: 'restart-service.ps1', now: t0 + 42 * MIN });
const beforePlanned = n.sends.length;
r = await boot({ now: t0 + 42 * MIN + 5_000 });
check('skipped=planned', r.sent === false && r.skipped === 'planned', JSON.stringify(r));
check('没有多发通知', n.sends.length === beforePlanned);
check('记号被消费掉', !fs.existsSync(path.join(dir, 'planned-restart.json')));
check('计划内重启也写心跳', JSON.parse(fs.readFileSync(path.join(dir, 'boot.json'), 'utf8')).clean === false);

console.log('[6] 过期的计划记号不能静音真重启');
fs.writeFileSync(path.join(dir, 'planned-restart.json'), JSON.stringify({ at: t0 + 42 * MIN, reason: 'stale' }));
r = await boot({ now: t0 + 42 * MIN + 11 * MIN });
check('过期记号仍会通知', r.sent === true && r.skipped === undefined, JSON.stringify(r));
check('过期记号被清掉', !fs.existsSync(path.join(dir, 'planned-restart.json')));

console.log('[7] config.notify.bootNotice=false 时静默');
r = await boot({ now: t0 + 90 * MIN, enabled: false });
check('skipped=disabled', r.sent === false && r.skipped === 'disabled', JSON.stringify(r));

console.log('[8] center 挂了也不能把启动带崩');
const bad = new FakeNotifier(true);
let threw = null;
try {
	r = await announceBoot({ notifier: bad, stateDir: dir, log, now: t0 + 200 * MIN, port: 33336 });
} catch (err) {
	threw = err;
}
check('announceBoot 不抛异常', threw === null, String(threw?.message));
check('返回 sent=false 且记了日志', r?.sent === false && logs.some((l) => /通知未发出/.test(l)), JSON.stringify(r));
check('发失败也留下心跳（下次能认出没正常退出）', JSON.parse(fs.readFileSync(path.join(dir, 'boot.json'), 'utf8')).clean === false);

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails.length ? `VERIFY FAIL (${fails.length}): ${fails.join('; ')}` : 'VERIFY OK');
process.exitCode = fails.length ? 1 : 0;
