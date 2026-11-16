// 协议标记扫描：[[PI_CONFIRM:问题|选项A|选项B]] 与 [[PI_SESSION:new|<id>]]。
//
// 为什么要收窄：2026-11-16 一条「手机 pi 使用指南」的回复里，把这两个标记当文档示例写了出来
// （在行内代码 `[[PI_CONFIRM:问题|选项A|选项B]]` 里），旧实现用正则在整段正文里全文匹配，
// 结果示例被执行了：弹出了一张问题为「问题」、选项为「选项A/选项B」的确认卡，
// 同时 [[PI_SESSION:new]] 示例还真的新开了一个会话（上下文全丢）。
//
// 现在的规则（两条都要满足，宁可不触发也不要误触发）：
//   1) 标记必须独占一行（允许 markdown 列表/引用前缀与首尾空白）——与系统提示词里
//      「在回复最后一行单独输出标记」的要求一致；
//   2) 标记不能出现在 markdown 代码块（```/~~~）或行内代码（`…`）里——文档示例几乎都是这样写的。
// 命中不了但在正文里看到过标记字样时，调用方会打一行日志，便于复盘「为什么没弹卡」。
//
// 宽松兜底（2026-11-16 实录）：模型把标记发成 `[[PI_PAGE:C:/x/y.html|标题`（漏了收尾 ]]）过一次，
// 严格规则下整条被当普通文字丢弃，手机上只剩一串裸文本、页面也没发布。现在若**整行就是标记**、
// 只是缺 `]]`，按行尾自动闭合（返回里带 truncated:true，调用方记一行日志）。
// 只对整行成立的标记生效，所以写在句子里或代码里的示例仍不会被误采纳。

const FENCE = /^\s*(?:```|~~~|`{3,}|~{3,})/;
const INLINE_CODE = /`[^`\n]*`/g;

/**
 * 逐行扫描（跳过代码块内容、剥掉行内代码），返回最后一个满足「独占一行」的标记。
 * @param {string} text 本轮 assistant 正文
 * @param {'PI_CONFIRM'|'PI_SESSION'} name 标记名
 * @returns {{ payload: string, ignoredInline: boolean } | null}
 */
function lastStandaloneMarker(text, name) {
	const lines = String(text ?? '').split(/\r?\n/);
	let inFence = false;
	let sawAnywhere = false;
	let hit = null;
	for (const rawLine of lines) {
		if (FENCE.test(rawLine)) {
			inFence = !inFence;
			continue;
		}
		// 行内代码先剥掉：示例写法 `[[PI_CONFIRM:…]]` 到此就不剩标记了。
		const line = inFence ? '' : rawLine.replace(INLINE_CODE, ' ');
		if (line.includes(name)) sawAnywhere = true;
		if (!line.includes(name)) continue;
		// 去掉 markdown 列表 / 引用前缀后，整行必须就是标记本身。
		let s = line.trim().replace(/^(?:>\s*)+/, '');
		while (/^(?:[-*+]|\d+[.)])\s+/.test(s)) s = s.replace(/^(?:[-*+]|\d+[.)])\s+/, '').trim();
		const m = s.match(new RegExp(`^\\[\\[${name}:\\s*([\\s\\S]*?)\\s*\\]\\]$`));
		if (m) hit = { payload: m[1] };
		else {
			// 缺收尾 ]]：整行以 [[NAME: 开头就把行尾当 payload（见文件头的宽松兜底说明）。
			const open = s.match(new RegExp(`^\\[\\[${name}:\\s*([^\\n]*)$`));
			if (open && open[1].trim()) hit = { payload: open[1].trim(), truncated: true };
			else if (s.includes(name)) sawAnywhere = true;
		}
	}
	return hit ? { ...hit, ignoredInline: sawAnywhere } : (sawAnywhere ? { payload: null, ignoredInline: true } : null);
}

/**
 * 确认标记 -> { question, options }。没有标记返回 null。
 * ignoredInline=true 表示正文里出现过 PI_CONFIRM 字样但没被采纳（调用方记日志）。
 */
export function findConfirmMarker(text) {
	if (!String(text ?? '').includes('PI_CONFIRM')) return null;
	const found = lastStandaloneMarker(text, 'PI_CONFIRM');
	if (!found) return null;
	if (!found.payload) return { question: null, options: [], ignoredInline: true };
	const parts = found.payload.split('|').map((s) => s.trim()).filter(Boolean);
	const question = parts[0];
	if (!question) return { question: null, options: [], ignoredInline: true };
	return { question, options: parts.slice(1, 6), ignoredInline: false, ...(found.truncated ? { truncated: true } : {}) };
}

/** 会话标记 -> 'new' 或 sessionId。没有标记返回 null。 */
export function findSessionMarker(text) {
	if (!String(text ?? '').includes('PI_SESSION')) return null;
	const found = lastStandaloneMarker(text, 'PI_SESSION');
	if (!found || !found.payload) return null;
	const target = found.payload.trim();
	return target || null;
}

/**
 * 页面标记 -> {path, title}。没有标记返回 null。
 * 写法：[[PI_PAGE:C:/path/to/page.html|标题]]（标题可省）。
 * 同样要求独占一行、不在代码里：文档/教程里写的示例不会被真的发布。
 */
export function findPageMarker(text) {
	if (!String(text ?? '').includes('PI_PAGE')) return null;
	const found = lastStandaloneMarker(text, 'PI_PAGE');
	if (!found || !found.payload) return { path: null, title: null, ignoredInline: true };
	const parts = found.payload.split('|');
	const p = (parts[0] ?? '').trim();
	const title = parts.slice(1).join('|').trim();
	if (!p) return { path: null, title: null, ignoredInline: true };
	// 命中本身就说明这行是独占的，所以 ignoredInline=false；
	// lastStandaloneMarker 的 sawAnywhere 对命中行也算 true，直接透传会误报「被忽略过」。
	return { path: p, title: title || null, ignoredInline: false, ...(found.truncated ? { truncated: true } : {}) };
}

/** 正文里出现过标记字样但没被采纳，返回一行可读日志；否则 null。 */
export function ignoredMarkerHint(text, name) {
	const t = String(text ?? '');
	if (!t.includes(name)) return null;
	const idx = t.indexOf(name);
	return `正文里出现过 ${name} 字样，但没有独占一行（或在代码块/行内代码里），已忽略：…${t.slice(Math.max(0, idx - 40), idx + 60).replace(/\s+/g, ' ')}…`;
}
