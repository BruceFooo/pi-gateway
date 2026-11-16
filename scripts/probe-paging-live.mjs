// 在线分页探针：不依赖手机，直接从本机连网关的 WS，把「加载更早」那条链路走一遍。
// 为什么需要：手机上「加载更早」只有人真的点过才算验证；网关日志里只有「末页」记录时看不出翻页有没有坏。
// 用法：node scripts/probe-paging-live.mjs [maxPages]
// 断言：① 跨页条目 id 不重复（页边界不重叠）② cursor 严格递减（不会死循环）③ hasMore=true 时不给空页。
// 注意：被探测的会话文件可能正在被 pi 写（探针自己就跑在其中一个会话里），所以只允许「尾部变多」，不允许页间重叠。
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/server.mjs';

const config = loadConfig(
	process.env.PI_GATEWAY_CONFIG ?? path.join(import.meta.dirname, '..', 'config', 'config.json'),
	() => {}
);
const maxPages = Number(process.argv[2] ?? 8);
const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
const url = `ws://${host}:${config.port}/pi/ws?token=${encodeURIComponent(config.token)}`;

const pending = new Map();
const events = [];
const ws = new WebSocket(url);
const fails = [];
let opened = false;
let nextId = 1;

function send(type, extra = {}, timeoutMs = 15000) {
	const id = `probe-${nextId++}`;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`${type} 等响应超时 ${timeoutMs}ms`));
		}, timeoutMs);
		pending.set(id, { resolve: (v) => { clearTimeout(timer); pending.delete(id); resolve(v); }, reject });
		ws.send(JSON.stringify({ id, type, ...extra }));
	});
}

ws.addEventListener('message', (ev) => {
	let msg;
	try { msg = JSON.parse(String(ev.data)); } catch { return; }
	if (msg.type === 'response') {
		const p = pending.get(msg.id);
		if (!p) return;
		if (msg.ok) p.resolve(msg.data ?? {});
		else p.reject(new Error(`${msg.id} 失败：${msg.error ?? '未知错误'}`));
		return;
	}
	events.push(msg);
});

const done = (code) => { try { ws.close(); } catch {} process.exitCode = code; };

ws.addEventListener('error', () => { if (!opened) console.log('CONNECT_FAIL（网关没在监听，或令牌不对）'); done(1); });
ws.addEventListener('open', async () => {
	opened = true;
	try {
		const list = await send('session_list');
		const sessions = list.sessions ?? [];
		const target = sessions.sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''))[0];
		if (!target) throw new Error('网关没有可读的会话');
		console.log(`会话 ${target.sessionId}（标题 ${target.title ?? '无'}，最后活动 ${target.lastActiveAt ?? '?'}）`);

		const seenEntries = new Set();
		let cursor;
		let pages = 0;
		let total = 0;
		let prevCursor = Infinity;
		let sample = null;

		while (pages < maxPages) {
			const page = await send('session_transcript', cursor == null ? { sessionId: target.sessionId } : { sessionId: target.sessionId, before: cursor });
			pages++;
			const lines = page.lines ?? [];
			// 会话文件真实大小只有网关知道（文件名带时间戳前缀、在子目录里），从响应里拿路径去 stat。
			if (pages === 1 && page.session?.path && fs.existsSync(page.session.path)) {
				const size = fs.statSync(page.session.path).size;
				console.log(`会话文件 ${size} 字节 ⇒ 大约 ${Math.ceil(size / 524288)} 页（每页 512KB）`);
			}
			if (!sample && lines.length) sample = lines[lines.length - 1];
			if (!lines.length && page.hasMore) fails.push(`第 ${pages} 页空但 hasMore=true（游标 ${cursor}）`);
			// 一个会话条目可以渲染成多行（assistant 文本 + thinking、user 文本 + 附件），
			// 所以 entryId 在**同一页内**重复是正常的；跨页重复才是页边界重叠的 bug。
			const onPage = new Set();
			for (const l of lines) {
				const key = l.entryId;
				if (key == null) continue; // notice 行没有 entryId，不参与重叠判定
				if (seenEntries.has(key) && !onPage.has(key)) fails.push(`第 ${pages} 页与更新的页重叠：entryId=${key} kind=${l.kind}`);
				onPage.add(key);
			}
			for (const k of onPage) seenEntries.add(k);
			total += lines.length;
			console.log(`第 ${pages} 页：${lines.length} 行 / ${onPage.size} 个条目，起点字节 ${page.cursor}，truncatedBefore=${page.truncatedBefore}，hasMore=${page.hasMore}`);
			if (!page.hasMore) break;
			cursor = page.cursor;
			if (!(cursor < prevCursor)) fails.push(`游标没有严格递减：${prevCursor} → ${cursor}`);
			prevCursor = cursor;
		}
		console.log(`合计 ${total} 行 / ${pages} 页，涉及 ${seenEntries.size} 个会话条目；样例行字段 = ${Object.keys(sample ?? {}).join(',')}`);
		if (fails.length) { for (const f of fails) console.log('FAIL ' + f); console.log(`PROBE FAIL (${fails.length})`); done(1); }
		else { console.log(`PROBE OK（翻了 ${pages} 页，无重叠、游标递减、无空页）`); done(0); }
	} catch (err) {
		console.log('PROBE FAIL ' + (err?.message ?? err));
		done(1);
	}
});
