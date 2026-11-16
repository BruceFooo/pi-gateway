// 会话列表 / 历史 transcript / 入口会话指针。
// pi 的会话是磁盘上的 JSONL 入口树：~/.pi/agent/sessions/<cwd 转写>/<ISO时间>_<sessionId>.jsonl
// 第 1 行是 header，其余是条目（type:message 里带 message.role）。pi 没有 list_sessions RPC，所以自己扫。

import fs from 'node:fs';
import path from 'node:path';

const HEADER_READ_BYTES = 4096;
const TAIL_READ_BYTES = 8192;
const TITLE_READ_BYTES = 32 * 1024;
const LIST_TTL_MS = 5_000;

export class SessionStore {
	/**
	 * @param {{dir:string, log?:(...a:any[])=>void}} opts
	 */
	constructor(opts) {
		this.dir = opts.dir;
		this.log = opts.log ?? (() => {});
		this.cache = null; // {at, items}
	}

	/** 递归找所有 .jsonl，按文件名（即创建时间）倒序。 */
	list() {
		if (this.cache && Date.now() - this.cache.at < LIST_TTL_MS) return this.cache.items;
		const items = [];
		try {
			for (const dirEntry of fs.readdirSync(this.dir, { withFileTypes: true })) {
				if (!dirEntry.isDirectory()) continue;
				const dirPath = path.join(this.dir, dirEntry.name);
				for (const name of fs.readdirSync(dirPath)) {
					if (!name.endsWith('.jsonl')) continue;
					const full = path.join(dirPath, name);
					const meta = this.#readMeta(full, name);
					if (meta) items.push(meta);
				}
			}
		} catch (err) {
			this.log(`[sessions] 读取会话目录失败：${err?.message}`);
		}
		items.sort((a, b) => (a.file < b.file ? 1 : -1));
		this.cache = { at: Date.now(), items };
		return items;
	}

	findById(sessionId) {
		if (!sessionId) return null;
		const key = String(sessionId);
		// 兼容前端可能拿到的几种标识：session UUID / 文件名 / 文件名去掉 .jsonl
		return this.list().find((s) => s.sessionId === key || s.path === key || path.basename(s.path) === key || path.basename(s.path, '.jsonl') === key) ?? null;
	}

	// 列表缓存 5s；改名/新建/fork 后要让下一次 list() 重读磁盘
	invalidate() {
		this.cache = null;
	}

	findByPath(full) {
		if (!full) return null;
		try {
			if (!fs.existsSync(full)) return null;
			return this.#readMeta(full, path.basename(full));
		} catch {
			return null;
		}
	}

	pathOf(sessionId) {
		return this.findById(sessionId)?.path ?? null;
	}

	#readMeta(full, name) {
		let fd;
		try {
			fd = fs.openSync(full, 'r');
			const stat = fs.statSync(full);
			const size = stat.size;
			const buf = Buffer.alloc(HEADER_READ_BYTES);
			const bytes = fs.readSync(fd, buf, 0, HEADER_READ_BYTES, 0);
			const firstLine = buf.toString('utf8', 0, bytes).split('\n')[0];
			const header = JSON.parse(firstLine);
			if (header?.type !== 'session') return null;
			const sessionId = header.id ?? name.replace(/\.jsonl$/, '').split('_').pop();
			// 改名有两个写入点：pi 的 RPC set_session_name 会**追加**一条 session_info（可能在头部附近，
			// 多数在文件末尾），网关自己的 #renameInFile 只改首行 header.name。
			// 固定「头优先」或「尾优先」都会读到旧名字，所以按时间戳取最新的那一次改名。
			const headText = buf.toString('utf8', 0, bytes);
			let title = null;
			let bestAt = null;
			const consider = (name, at) => {
				if (!name) return;
				const key = String(at ?? '');
				if (bestAt === null || key >= bestAt) {
					bestAt = key;
					title = name;
				}
			};
			// 网关改文件时会留 renamedAt，比 header.timestamp（会话创建时间）新
			consider(header.name, header.renamedAt ?? header.timestamp);
			for (const info of this.#sessionInfoEntries(headText)) consider(info.name, info.timestamp);
			if (size > HEADER_READ_BYTES * 2) {
				const tailLen = Math.min(TAIL_READ_BYTES, size);
				const tail = Buffer.alloc(tailLen);
				const got = fs.readSync(fd, tail, 0, tailLen, size - tailLen);
				for (const info of this.#sessionInfoEntries(tail.toString('utf8', 0, got))) consider(info.name, info.timestamp);
			}
			title = title || this.#firstUserText(fd, bytes);
			return {
				sessionId,
				path: full,
				file: name,
				cwd: header.cwd ?? '',
				createdAt: header.timestamp ?? name.split('_')[0],
				lastActiveAt: stat.mtime ? stat.mtime.toISOString() : null,
				title: title || '(无标题)',
				parentSession: header.parentSession ?? null,
			};
		} catch (err) {
			this.log(`[sessions] 跳过 ${name}：${err?.message}`);
			return null;
		} finally {
			if (fd !== undefined) {
				try {
					fs.closeSync(fd);
				} catch {
					/* ignore */
				}
			}
		}
	}

	/** 从一段 JSONL 文本里挑出所有带名字的 session_info 条目（读窗口首尾行可能被截断）。 */
	#sessionInfoEntries(text) {
		const out = [];
		for (const line of text.split('\n')) {
			if (!line.startsWith('{"type":"session_info"')) continue;
			try {
				const entry = JSON.parse(line);
				if (entry?.name) out.push({ name: entry.name, timestamp: entry.timestamp });
			} catch {
				// 读窗口最后一行可能被截断，忽略
			}
		}
		return out;
	}

	#firstUserText(fd, alreadyRead) {
		try {
			const size = Math.min(TITLE_READ_BYTES, 32 * 1024);
			const buf = Buffer.alloc(size);
			const bytes = fs.readSync(fd, buf, 0, size, alreadyRead);
			const text = buf.toString('utf8', 0, bytes);
			for (const line of text.split('\n')) {
				if (!line.trim()) continue;
				let entry;
				try {
					entry = JSON.parse(line);
				} catch {
					continue; // 最后一行可能被截断
				}
				if (entry?.type !== 'message') continue;
				const message = entry.message;
				if (message?.role !== 'user') continue;
				const parts = Array.isArray(message.content) ? message.content : [{ type: 'text', text: String(message.content ?? '') }];
				const attached = parts.filter((p) => p?.type === 'image').length;
				const found = parts.find((p) => p?.type === 'text' && String(p.text ?? '').trim());
				if (found) {
					const raw = String(found.text).trim().replace(/^(#[^\n]*\n)+/, '').replace(/\s+/g, ' ');
					const label = raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;
					return attached ? `${label} [${attached} 图]` : label;
				}
				if (attached) return `[${attached} 图]`;
			}
			return '';
		} catch {
			return '';
		}
	}

	/**
	 * 把会话文件渲染成前端用的 transcript 行。
	 * @returns {{session:object|null, truncatedBefore:number, lines:Array<object>}}
	 */
	transcript(sessionId, opts = {}) {
		const maxBytes = opts.maxBytes ?? 512 * 1024;
		const session = this.findById(sessionId);
		if (!session) return { session: null, truncatedBefore: 0, lines: [] };
		const text = (() => {
			try {
				const stat = fs.statSync(session.path);
				if (stat.size > maxBytes) {
					const fd = fs.openSync(session.path, 'r');
					try {
						const buf = Buffer.alloc(maxBytes);
						const bytes = fs.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
						// 从第一条完整行开始，避免半行
						const chunk = buf.toString('utf8', 0, bytes);
						const cut = chunk.indexOf('\n');
						return { text: cut >= 0 ? chunk.slice(cut + 1) : chunk, skippedHead: true };
					} finally {
						fs.closeSync(fd);
					}
				}
				return { text: fs.readFileSync(session.path, 'utf8'), skippedHead: false };
			} catch (err) {
				this.log(`[sessions] 读取 transcript 失败：${err?.message}`);
				return { text: '', skippedHead: false };
			}
		})();

		let lines = [];
		let truncatedBefore = 0;
		let imageSeq = 0;
		let firstKeptEntryId = null;
		for (const line of text.text.split('\n')) {
			if (!line.trim()) continue;
			let entry;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry.type === 'compaction' && entry.firstKeptEntryId) {
				firstKeptEntryId = entry.firstKeptEntryId;
				lines.push({ kind: 'notice', text: '—— 更早的内容已压缩为摘要 ——', time: entry.timestamp ?? null });
				continue;
			}
			if (entry.type !== 'message') continue;
			const rendered = this.#renderMessage(entry, () => `[图片 #${++imageSeq}]`);
			if (!rendered) continue;
			if (Array.isArray(rendered)) lines.push(...rendered);
			else lines.push(rendered);
		}
		if (text.skippedHead) {
			truncatedBefore = Math.max(1, Math.floor(session.path ? countLinesApprox(session.path, maxBytes) : 1));
			lines.unshift({ kind: 'notice', text: `（更早的 ${truncatedBefore} 条未显示）`, time: null });
		}
		if (firstKeptEntryId) {
			// 保留 fork/branch 需要的锚点，前端不必显示
		}
		return { session, truncatedBefore, lines };
	}

	#renderMessage(entry, nextImageLabel) {
		const message = entry.message;
		if (!message) return null;
		const time = entry.timestamp ?? null;
		const id = entry.id ?? null;
		const role = message.role;
		if (role === 'system') return null;
		const parts = Array.isArray(message.content) ? message.content : [{ type: 'text', text: String(message.content ?? '') }];

		if (role === 'user') {
			const out = [];
			for (const part of parts) {
				if (part?.type === 'text' && String(part.text ?? '').trim()) {
					out.push({ kind: 'user', text: String(part.text), time, entryId: id });
				} else if (part?.type === 'image') {
					out.push({ kind: 'attachment', text: nextImageLabel(), time, entryId: id });
				}
			}
			return out.length ? out : null;
		}

		if (role === 'assistant') {
			const out = [];
			for (const part of parts) {
				if (!part) continue;
				if (part.type === 'text' && String(part.text ?? '').trim()) {
					out.push({ kind: 'assistant', text: String(part.text), time, entryId: id });
				} else if (part.type === 'thinking' && String(part.thinking ?? '').trim()) {
					out.push({ kind: 'thinking', text: String(part.thinking), time, entryId: id });
				} else if (part.type === 'toolCall' || part.type === 'toolcall' || part.type === 'tool_use') {
					const name = part.name ?? part.toolName ?? '?';
					out.push({ kind: 'tool', text: `${name} ${previewArgs(part)}`, time, entryId: id });
				}
			}
			return out.length ? out : null;
		}

		if (role === 'toolResult' || role === 'tool_result') {
			const text = parts
				.filter((p) => p?.type === 'text')
				.map((p) => String(p.text ?? ''))
				.join('\n')
				.replace(/\s+/g, ' ')
				.trim();
			return [{ kind: 'toolResult', text: text.length > 400 ? `${text.slice(0, 400)}…` : text, toolName: message.toolName ?? null, isError: !!message.isError, time, entryId: id }];
		}
		return null;
	}
}

function countLinesApprox(full, maxBytes) {
	try {
		const size = fs.statSync(full).size;
		if (size <= maxBytes) return 0;
		// 只需要一个粗略数字：按平均行长估算
		const avg = Math.max(200, size / 200);
		return Math.round((size - maxBytes) / avg);
	} catch {
		return 0;
	}
}

function previewArgs(part) {
	let args = part.arguments ?? part.input ?? part.args ?? null;
	if (args == null) return '';
	if (typeof args !== 'string') {
		try {
			args = JSON.stringify(args);
		} catch {
			args = String(args);
		}
	}
	args = args.replace(/\s+/g, ' ').trim();
	return args.length > 160 ? `${args.slice(0, 160)}…` : args;
}
