// 网关自己启动时给手机发一条通知。
// 为什么需要：通知是**出站**的（src/notify.mjs -> center /ui/api/pi/notify），
// 而「网关进程被外部杀掉 / 崩溃 / 服务被 WinSW 拉起」这类情况下，能发通知的进程正是那个已经死了的进程。
// 计划内重启由 scripts/restart-service.ps1 自己发前/后通知，所以这里要**认出**计划内重启并闭嘴，
// 否则手机会被同一次重启通知两遍。

import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './paths.mjs';

const BOOT_FILE = 'boot.json'; // 本次运行的心跳：clean=false 且没被 markCleanExit 改写过 => 上次没正常退出
const PLANNED_FILE = 'planned-restart.json'; // 计划内重启的记号，由 restart-service.ps1 写
const PLANNED_FRESH_MS = 10 * 60_000; // 记号只在这个窗口内有效（超过就当作没发生过）
const LOOP_WINDOW_MS = 10 * 60_000; // 连续重启的统计窗口
const LOOP_MAX_SEND = 3; // 窗口内最多通知 3 次，再多只写日志（崩溃循环不该刷屏手机）

function file(dir, name) {
	return path.join(dir, name);
}

function readJson(dir, name) {
	try {
		const raw = fs.readFileSync(file(dir, name), 'utf8');
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? parsed : null;
	} catch {
		return null;
	}
}

function writeJson(dir, name, value) {
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(file(dir, name), JSON.stringify(value));
		return true;
	} catch (err) {
		return false;
	}
}

/** 计划内重启的记号：restart-service.ps1 在 sc.exe stop 之前调用。 */
export function markPlannedRestart({ stateDir = STATE_DIR, reason = '', now = Date.now() } = {}) {
	return writeJson(stateDir, PLANNED_FILE, { at: now, reason: String(reason || 'planned') });
}

/** 正常退出（收到 SIGINT/SIGTERM）时改写心跳，好让下次启动能区分「崩溃」和「被停掉」。 */
export function markCleanExit({ stateDir = STATE_DIR, now = Date.now() } = {}) {
	const prev = readJson(stateDir, BOOT_FILE) ?? {};
	return writeJson(stateDir, BOOT_FILE, { ...prev, at: prev.at ?? now, clean: true, cleanAt: now });
}

function humanDur(ms) {
	if (!Number.isFinite(ms) || ms <= 0) return '未知时长';
	const s = Math.round(ms / 1000);
	if (s < 90) return `${s} 秒`;
	const m = Math.round(s / 60);
	if (m < 120) return `${m} 分钟`;
	return `${(m / 60).toFixed(1)} 小时`;
}

/**
 * 启动时通知手机。返回 { sent, skipped?, title?, body?, why? }
 * @param {{notifier:{send:(m:any)=>Promise<any>}, stateDir?:string, log?:(...a:any[])=>void,
 *          now?:number, enabled?:boolean, pid?:number, port?:number}} opts
 */
export async function announceBoot({ notifier, stateDir = STATE_DIR, log = () => {}, now = Date.now(), enabled = true, pid = process.pid, port = null } = {}) {
	if (!enabled) {
		log('[boot] 已关闭启动通知（config.notify.bootNotice=false）');
		return { sent: false, skipped: 'disabled' };
	}
	if (!notifier || typeof notifier.send !== 'function') {
		log('[boot] 没有 notifier，跳过启动通知');
		return { sent: false, skipped: 'no_notifier' };
	}

	const prev = readJson(stateDir, BOOT_FILE);
	const planned = readJson(stateDir, PLANNED_FILE);
	const plannedFresh = !!planned && now - Number(planned.at ?? 0) < PLANNED_FRESH_MS;
	const gap = prev?.at ? now - Number(prev.at) : null;
	const count = !plannedFresh && gap != null && gap < LOOP_WINDOW_MS ? Number(prev.count ?? 1) + 1 : 1;

	// 先把这次的心跳写下去：哪怕通知发失败，下次也能看出「上次没正常退出」。
	// 计划内重启把计数重置为 1（它是人安排的，不算崩溃循环；记号只会被消费一次，所以之后的崩溃仍会正常计数）。
	writeJson(stateDir, BOOT_FILE, { at: now, pid, clean: false, count });

	if (plannedFresh) {
		// 计划内重启：restart-service.ps1 已经发过「即将重启」和「重启完成」，这里再发就是重复。
		try {
			fs.unlinkSync(file(stateDir, PLANNED_FILE));
		} catch {
			/* 删不掉就算了，反正只在窗口内有效 */
		}
		log(`[boot] 计划内重启（记号 ${planned.reason ?? ''}），不发启动通知`);
		return { sent: false, skipped: 'planned', reason: planned.reason ?? null };
	}

	if (count > LOOP_MAX_SEND) {
		log(`[boot] ${humanDur(gap)} 内已连续第 ${count} 次启动，只写日志不再通知手机`);
		return { sent: false, skipped: 'loop', count };
	}

	// 过期的计划记号不清掉就会让后面某次真崩溃被误判成计划内重启
	if (planned && !plannedFresh) {
		try {
			fs.unlinkSync(file(stateDir, PLANNED_FILE));
		} catch { /* ignore */ }
	}

	let why;
	if (!prev) why = '没有上次运行的记录（首次启动，或 state/ 被清理过）';
	else if (prev.clean === true) why = `上次正常退出（收到停止信号），距今 ${humanDur(gap)}`;
	else why = `上次运行没有正常退出的记录（可能崩溃或被强杀），距今 ${humanDur(gap)}`;

	const title = count > 1 ? `pi 网关已启动（10 分钟内第 ${count} 次）` : 'pi 网关已启动';
	const lines = [
		`${why}。`,
		`进程 pid=${pid}${port != null ? `，监听 ${port}` : ''}，时间 ${new Date(now).toISOString()}`,
	];
	if (count > 1) lines.push('连续重启通常意味着服务在崩溃循环：看 logs/gateway.log 的最后一行异常。');
	const body = lines.join('\n');

	let res;
	try {
		res = await notifier.send({ title, body, kind: 'gateway_boot', throttleMs: 0 });
	} catch (err) {
		// center 挂了 / DNS 失败 / 网络报错都不能把启动带崩：心跳已经写下去了，下次还能认出这次没正常退出。
		log(`[boot] 通知未发出（发送出错）：${err?.message ?? err}`);
		res = { ok: false, error: String(err?.message ?? err) };
	}
	if (res?.ok) log(`[boot] 已通知手机：${title}`);
	else log(`[boot] 通知未发出：${res?.skipped ?? res?.error ?? '未知'}`);
	return { sent: !!res?.ok, title, body, why, count };
}
