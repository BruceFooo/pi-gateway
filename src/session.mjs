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
	 * 把会话文件渲染成前端用的 transcript 行，按字节游标分页。
	 * 不带 before = 最新一页（文件尾部 maxBytes）；带 before = 上一页返回的 cursor（那一页首行的字节偏移），再往前翻一页。
	 * 页边界只落在 JSONL 行边界上，而一个条目（entry.id）渲染出的所有行都来自同一行
	 * ⇒ 条目不会被拆散、页与页不重叠、翻到文件头自然停。
	 * @returns {{session:object|null, truncatedBefore:number, lines:Array<object>, cursor:number|null, hasMore:boolean}}
	 */
	transcript(sessionId, opts = {}) {
		const maxBytes = opts.maxBytes ?? 512 * 1024;
		const before = Number.isFinite(opts.before) && opts.before > 0 ? Math.floor(opts.before) : null;
		const session = this.findById(sessionId);
		if (!session) return { session: null, truncatedBefore: 0, lines: [], cursor: null, hasMore: false };
		let size = 0;
		try {
			size = fs.statSync(session.path).size;
		} catch (err) {
			this.log(`[sessions] 读取 transcript 失败：${err?.message}`);
			return { session, truncatedBefore: 0, lines: [], cursor: null, hasMore: false };
		}
		// before 只能是上一页的 cursor 或 size，都在行边界上 ⇒ 本页末行必完整；开头若是半行由 #readPageBackwards 丢掉
		let endByte = before == null ? size : Math.max(0, before);
		if (endByte > size) {
			// 游标落在文件外：会话文件被 pi/bili 重写或缩小过（也可是前端拿着旧游标重试）。
			// 退回末尾继续翻：可能重复几条，但不能卡死、也不能报错给前端。一定要写日志，不然这类事永远看不见。
			this.log(`[sessions] 游标 ${before} 已超出当前文件 ${size} 字节（会话文件被重写/缩小），已退回文件末尾继续翻页`);
			endByte = size;
		}
		const page = this.#readPageBackwards(session.path, Math.max(0, endByte - maxBytes), endByte);

		let lines = [];
		let truncatedBefore = 0;
		let imageSeq = 0;
		let firstKeptEntryId = null;
		for (const line of page.text.split('\n')) {
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
		if (page.startByte > 0) {
			// 只是给前端一个「还有多少」的量级，不是精确条数：按平均行长估
			const avg = Math.max(200, size / 200);
			truncatedBefore = Math.max(1, Math.round(page.startByte / avg));
		}
		if (firstKeptEntryId) {
			// 保留 fork/branch 需要的锚点，前端不必显示
		}
		const hasMore = page.startByte > 0;
		// 每页留一行日志：分页上线后只能靠 gateway.log 判断它跑得好不好（前端只能看到“又多了几条”）
		this.log(`[sessions] transcript ${String(session.id ?? sessionId)} ${before == null ? "末页" : `游标 ${before}`} 读 ${endByte - Math.max(0, endByte - maxBytes)} 字节 → ${lines.length} 行，本页起点 ${page.startByte}，hasMore=${hasMore}`);
		return { session, truncatedBefore, lines, cursor: hasMore ? page.startByte : null, hasMore };
	}

	/**
	 * 读 [startByte, endByte) 这一页文本。startByte>0 时开头大概率是半行：丢掉它，并返回丢掉之后真实的起始偏移，
	 * 下一页就从这里接着往前读。若整窗都没有换行（单条条目比窗口还长，例如巨大的 toolResult），
	 * 就整窗向前翻倍再试（最多 4 次，故单页最多读 16×maxBytes），仍找不到行头才放弃这一条并记录。
	 * @returns {{text:string, startByte:number}}
	 */
	#readPageBackwards(path, startByte, endByte) {
		if (endByte - startByte <= 0) return { text: '', startByte: endByte };
		try {
			const fd = fs.openSync(path, 'r');
			try {
				let from = startByte;
				for (let attempt = 0; ; attempt++) {
					const len = endByte - from;
					const buf = Buffer.alloc(len);
					const bytes = fs.readSync(fd, buf, 0, len, from);
					if (from === 0) return { text: buf.toString('utf8', 0, bytes), startByte: 0 };
					// 在字节里找换行：会话里大多是多字节中文，字节数 ≠ 字符数，用字符串下标当字节偏移会错
					// 而且得是“行中间”的换行：cut+1 === bytes 意味着窗口里最后一个字节正好是上一个半行的结尾，
					// 那一行在本页里仍然不完整（不查这一点就会返回空页 + 游标不前进，死循环）
					const cut = buf.indexOf(0x0a, 0, bytes);
					if (cut >= 0 && cut + 1 < bytes) return { text: buf.toString('utf8', cut + 1, bytes), startByte: from + cut + 1 };
					if (attempt >= 4) {
						this.log(`[sessions] transcript 单行超过 ${endByte - startByte} 字节且翻不动，跳过这一条`);
						// 游标往前推，保证下一页换地方，不原地循环
						return { text: '', startByte };
					}
					from = Math.max(0, from - len);
				}
			} finally {
				fs.closeSync(fd);
			}
		} catch (err) {
			this.log(`[sessions] 读取 transcript 失败：${err?.message}`);
			return { text: '', startByte: 0 };
		}
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
