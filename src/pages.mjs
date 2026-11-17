// 页面发布：把本机 skill 生成的 HTML 单页（例如 answer-me-with-html 的解释页）发到手机上。
//
// 为什么要有这一层：手机只能访问你那一个 HTTPS 域名（pi 在我本机，手机够不到我），
// 所以 HTML 必须先由网关从本机文件读出来、放到网关自己的 pages/ 下，再同源发出去。
// 页面是「本机自己生成的」，不是抓来的第三方页面 —— 同源执行脚本，第三方 HTML 不能放进来。
//
// 触发方式：模型在回复最后一行单独输出 [[PI_PAGE:<html 绝对路径>|标题]]
// （规则与 PI_CONFIRM / PI_SESSION 一样：必须独占一行、不能在代码里，见 markers.mjs）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PAGE_NAME = /^[A-Za-z0-9._-]+\.html$/; // 对外只认这个形状，杜绝 ../ 与任意文件名
const TITLE_MAX = 80;

/**
 * 把整页压成「内联预览版」：去掉会执行的东西，只留标记与样式。
 * 回答里嵌的 iframe 走这一份（服务器还会加 CSP: script-src 'none' 兜底），
 * 因为解释页的阅读模式本来就是纯 HTML+CSS，那 40KB 视频播放器 JS 在手机上用不上。
 * 为什么非要把脚本剔干：iframe 的 src 带令牌，同源页内脚本能拿 URL 里的令牌去连网关 WS；
 * 脚本干掉了，这一路就只剩「显示」。
 * @param {string} html
 * @returns {{html: string, scripts: number, links: number}}
 */
export function stripForInline(html) {
	let scripts = 0;
	let links = 0;
	let out = String(html ?? '');
	// 块级 script（带 src 的也算）：与浏览器一致，遇到第一个 </script> 就结束。
	out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, () => {
		scripts += 1;
		return '';
	});
	out = out.replace(/<script\b[^>]*\/>/gi, () => {
		scripts += 1;
		return '';
	});
	// 外部样式表与字体预推：手机浏览器直连不到那个域名，留着只会在页里拉一堆 404。
	out = out.replace(/<link\b[^>]*>/gi, (tag) => (/stylesheet|preload|prefetch|modulepreload/i.test(tag) ? (links += 1, '') : tag));
	// meta refresh：能触发跳转，剔掉。
	out = out.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, '');
	// on* 内联事件：只在**标签内**剔（先匹配整个标签再洗属性），不然正文里「上面 on=1 行」这类文本会被误删。
	out = out.replace(/<[a-zA-Z][^>]*>/g, (tag) => tag.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, ''));
	return { html: out, scripts, links };
}

export class PageStore {
	/**
	 * @param {{dir: string, log: Function, maxPageBytes?: number}} opts
	 */
	constructor({ dir, log, maxPageBytes = 2 * 1024 * 1024 }) {
		this.dir = path.resolve(dir);
		this.log = log ?? (() => {});
		this.maxPageBytes = maxPageBytes;
		fs.mkdirSync(this.dir, { recursive: true });
		// index.json 记「这一页是谁发布的、标题叫什么、什么时候发的」。文件名本身是从源路径摘要来的，
		// 重启后仍可按名字对上；标题也能从页面 <title> 回落，所以索引丢了不影响使用。
		this.indexFile = path.join(this.dir, 'index.json');
		this.index = this.#loadIndex();
	}

	#loadIndex() {
		try {
			const raw = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
			return raw && typeof raw === 'object' ? raw : {};
		} catch {
			return {};
		}
	}

	#saveIndex() {
		try {
			fs.writeFileSync(this.indexFile, JSON.stringify(this.index, null, 1));
		} catch (err) {
			this.log(`[pages] 索引写入失败：${err?.message}`);
		}
	}

	/**
	 * 发布一个本机 HTML 文件：校验 → 复制成安全文件名 → 返回可访问的信息。
	 * 同一个源文件重复发布会覆盖（同名），不会堆积。
	 * @param {string} srcPath 本机绝对路径
	 * @param {string} title 标题（可空，空则用文件名）
	 * @returns {{name: string, url: string, title: string, bytes: number, at: string, source: string}}
	 */
	publish(srcPath, title) {
		const src = path.resolve(String(srcPath ?? '').trim());
		if (!/\.html?$/i.test(src)) throw new Error('只允许发布 .html / .htm 文件');
		if (!fs.existsSync(src)) throw new Error(`文件不存在：${src}`);
		const st = fs.statSync(src);
		if (!st.isFile()) throw new Error('不是一个普通文件');
		if (st.size > this.maxPageBytes) {
			throw new Error(`页面太大：${(st.size / 1024).toFixed(1)}KB > ${(this.maxPageBytes / 1024).toFixed(1)}KB`);
		}
		// 名字 = 源文件名的可读部分 + 源绝对路径的短摘要：同一个文件重复发布就覆盖，
		// 不同目录下的同名文件也不会互相顶替；名字里不带原始路径（URL 不能泄露本机目录结构）。
		const slug = path.basename(src).replace(/\.html?$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 48) || 'page';
		const hash = crypto.createHash('sha1').update(src.toLowerCase()).digest('hex').slice(0, 8);
		const name = `${slug}-${hash}.html`;
		const full = path.join(this.dir, name);
		// 复制而不是软链：pages/ 是网关自己的目录，源文件之后被删也不影响已发布的页面。
		fs.copyFileSync(src, full);
		// 标题优先级：标记里写的 > 页面自己的 <title>（解释页都写了 title）> 文件名。
		const t = String(title ?? '').trim() || this.#readTitle(src) || path.basename(src, path.extname(src));
		const at = new Date().toISOString();
		this.index[name] = { title: t.slice(0, TITLE_MAX), source: src, at, bytes: st.size };
		this.#saveIndex();
		return { name, url: `/pi/pages/${name}`, title: this.index[name].title, bytes: st.size, at, source: src };
	}

	/** 已发布页面列表，按修改时间倒序（前端「页面」面板用）。 */
	list() {
		let names = [];
		try {
			names = fs.readdirSync(this.dir);
		} catch {
			return [];
		}
		const out = [];
		for (const name of names) {
			if (!PAGE_NAME.test(name)) continue;
			try {
				const st = fs.statSync(path.join(this.dir, name));
				if (!st.isFile()) continue;
				const meta = this.index[name];
				out.push({
					name,
					url: `/pi/pages/${name}`,
					bytes: st.size,
					at: meta?.at ?? new Date(st.mtimeMs).toISOString(),
					title: meta?.title ?? this.#readTitle(path.join(this.dir, name)) ?? name.replace(/\.html$/i, ''),
					// 源绝对路径给前端用来把历史消息里的标记同到具体页（历史消息只有路径，没有 name）。
					source: meta?.source ?? null,
				});
			} catch {
				/* 刚被删掉之类，跳过 */
			}
		}
		out.sort((a, b) => (a.at < b.at ? 1 : -1));
		return out;
	}

	/**
	 * 读「内联预览版」：已发布页去脚本后的 HTML 文本。不存在返回 null。
	 * 不落盘额外的 .frag 文件：剔脚本是一次正则的活，每次请求重算比多存一份文件好管。
	 */
	readInline(name) {
		const full = this.resolve(name);
		if (!full) return null;
		try {
			return stripForInline(fs.readFileSync(full, 'utf8')).html;
		} catch (err) {
			this.log(`[pages] 内联版读取失败：${err?.message}`);
			return null;
		}
	}

	/** 把请求路径解析成本地文件（防穿越）。返回 null 表示不存在或不合法。 */
	resolve(name) {
		if (!PAGE_NAME.test(String(name ?? ''))) return null;
		const full = path.join(this.dir, String(name));
		if (!full.startsWith(this.dir + path.sep)) return null;
		try {
			return fs.statSync(full).isFile() ? full : null;
		} catch {
			return null;
		}
	}

	/** 删掉早于 hours 小时的页面（与 media 的保留策略同一思路）。 */
	pruneOlderThan(hours, log = this.log) {
		if (!(Number(hours) > 0)) return 0;
		const cutoff = Date.now() - Number(hours) * 3600_000;
		let removed = 0;
		let names = [];
		try {
			names = fs.readdirSync(this.dir);
		} catch {
			return 0;
		}
		for (const name of names) {
			if (!PAGE_NAME.test(name)) continue;
			const full = path.join(this.dir, name);
			try {
				if (fs.statSync(full).mtimeMs < cutoff) {
					fs.rmSync(full, { force: true });
					delete this.index[name];
					removed += 1;
				}
			} catch {
				/* 忽略 */
			}
		}
		if (removed) {
			this.#saveIndex();
			log(`[pages] 清理了 ${removed} 个过期页面`);
		}
		return removed;
	}

	// 标题取 <title>，取不到返回 null（调用方回落文件名）。只读前 4KB，避免整页读进来。
	#readTitle(full) {
		try {
			const fd = fs.openSync(full, 'r');
			const buf = Buffer.alloc(4096);
			const n = fs.readSync(fd, buf, 0, 4096, 0);
			fs.closeSync(fd);
			const m = buf.slice(0, n).toString('utf8').match(/<title[^>]*>([^<]{1,200})/i);
			return m ? m[1].trim().slice(0, TITLE_MAX) : null;
		} catch {
			return null;
		}
	}
}
