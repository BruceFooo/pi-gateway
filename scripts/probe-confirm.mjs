// 标记协议端到端自测：模型输出 [[PI_CONFIRM:问题|选项A|选项B]] → 网关发确认卡 + 推企业微信
// → 手机端回答 → 网关自动排一轮新任务把答案送回模型。
// 用法：先起网关（node index.js）与通知 stub（node scripts/notify-stub.mjs），再 node scripts/probe-confirm.mjs
// 两轮模型往返，实测 2~3 分钟；退出码 0 = 全部检查通过。

import fs from 'node:fs';
// 用 Node 全局 WebSocket（网关本身不依赖 ws 包，是手写的帧实现）

const cfgPath = new URL('../config/config.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const url = process.env.PI_SMOKE_URL ?? `ws://${cfg.host}:${cfg.port}/pi/ws`;
const tok = process.env.PI_GATEWAY_TOKEN ?? cfg.token;
const stubUrl = process.env.PI_NOTIFY_STUB ?? 'http://127.0.0.1:33399';

const checks = {
	chatAccepted: false,
	approvalSeen: false,
	approvalShape: false,
	queueNotBlocked: false,
	resolved: false,
	followUpStarted: false,
	followUpAnswered: false,
	approvalNotifyHit: false,
	listEmptyAfter: false,
};
let sendSeq = 0;
let chatEntryId = null;
let firstRunId = null;
let followUpRunId = null;
let modelApproval = null;
let resolvedAt = 0;
let followUpText = '';
const log = (s) => console.log(s);

function finish(ok) {
	clearTimeout(hard);
	clearInterval(keep);
	console.log('== 检查项 == ' + JSON.stringify(checks));
	console.log('approval = ' + (modelApproval ? JSON.stringify(modelApproval) : '(没收到)'));
	console.log('followUpText = ' + JSON.stringify(followUpText.slice(0, 300)));
	console.log(ok ? 'PROBE-CONFIRM PASS' : 'PROBE-CONFIRM FAIL');
	process.exit(ok ? 0 : 1);
}

const hard = setTimeout(() => { log('!! 超时'); finish(false); }, 300_000);
// 全局 WebSocket 不拖住事件循环，需要一个 ref 的定时器兜住进程
const keep = setInterval(() => { try { send('ping'); } catch { /* ignore */ } }, 15_000);

const ws = new WebSocket(`${url}?token=${encodeURIComponent(tok)}`);
const send = (type, extra = {}) => ws.send(JSON.stringify({ id: ++sendSeq, type, ...extra }));

ws.onopen = () => {
	log(`[probe] 已连接 ${url}`);
	send('chat_send', {
		text: '标记协议自测。不要调用任何工具，不要读文件。正文只写「测试开始」，然后在最后一行原样输出下面这行标记（只输出一次，不要加代码块，输出完就结束本轮）：\n[[PI_CONFIRM:要不要继续这个测试|继续|取消]]',
	});
};

ws.onmessage = (ev) => {
	const m = JSON.parse(String(ev.data));
	if (m.ok === false) { log(`[probe] 出错 id=${m.id} ${m.error}`); return; }
	if (m.ok === true && m.data?.queued) {
		// 注意：approval_resolve 的响应也带 queued（新一轮的 id），不能拿来覆盖 chat 那一轮的 id
		if (!chatEntryId) chatEntryId = m.data.queued;
		checks.chatAccepted = true;
		log(`[probe] 已入队 entry=${m.data.queued}`);
		return;
	}
	if (m.ok === true && m.data && 'running' in m.data && Array.isArray(m.data.items)) {
		// 模型确认不应把队列算成 busy：否则一个已结束的 run 会把后面的任务卡到超时
		checks.queueNotBlocked = m.data.running == null;
		log(`[probe] queue_list running=${m.data.running ? m.data.running.id : 'null'} items=${m.data.items.length}`);
		return;
	}
	if (m.ok === true && Array.isArray(m.data?.approvals)) {
		const pending = m.data.approvals.filter((a) => a.source === 'model');
		log(`[probe] approval_list 里待确认的模型标记数 = ${pending.length}`);
		// 只认回答之后的那一次查询：回答之前表里必然有东西，不能拿来判定
		if (resolvedAt) checks.listEmptyAfter = pending.length === 0;
		return;
	}
	if (m.type !== 'event') return;
	// 事件信封是 {type:'event', seq, event:'<名字>', ...payload}：payload 直接展平在顶层
	const t = typeof m.event === 'string' ? m.event : null;
	const e = m;

	if (t === 'agent_start') {
		const runId = e.runId ?? null;
		if (!firstRunId) firstRunId = runId;
		else if (resolvedAt && !followUpRunId) { followUpRunId = runId; checks.followUpStarted = true; }		log(`[probe] agent_start run=${runId}${followUpRunId === runId ? '（新一轮：把答案送回模型）' : ''}`);
	} else if (t === 'assistant_text') {
		if (followUpRunId) followUpText += e.text ?? '';
	} else if (t === 'approval_requested') {
		const a = e.approval ?? {};
		log(`[probe] approval_requested id=${a.id} source=${a.source} method=${a.method} title=${a.title} options=${JSON.stringify((a.options ?? []).map((o) => o.value))}`);
		if (a.source !== 'model') return;
		modelApproval = a;
		checks.approvalSeen = true;
		checks.approvalShape = a.method === 'select'
			&& (a.options ?? []).length === 2
			&& (a.options ?? []).map((o) => o.value).includes('继续')
			&& String(a.title ?? '').length > 0;
		setTimeout(() => { log('[probe] 查队列状态'); send('queue_list'); }, 800);
		setTimeout(() => { log('[probe] 手机端选择「继续」'); send('approval_resolve', { approvalId: a.id, value: '继续' }); }, 1800);
	} else if (t === 'approval_resolved') {
		if (modelApproval && e.id === modelApproval.id) {
			resolvedAt = Date.now();
			checks.resolved = true;
			log(`[probe] approval_resolved value=${JSON.stringify(e.value)}`);
		}
	} else if (t === 'notice') {
		log(`[probe] notice ${e.text}`);
	} else if (t === 'agent_settled') {
		log(`[probe] agent_settled run=${e.runId ?? null}`);
		if (followUpRunId) void finishRound();
	}
};

async function finishRound() {
	try {
		const j = await (await fetch(`${stubUrl}/hits`)).json();
		const hit = (j.hits ?? []).filter((h) => /"kind":"approval"/.test(h.body)).pop();
		checks.approvalNotifyHit = !!hit;
		if (hit) log('[probe] 通知 stub 收到：' + hit.body.slice(0, 200));
	} catch (err) {
		log('[probe] 通知 stub 不可达：' + err.message);
	}
	checks.followUpAnswered = /继续|完成|收到|好的/.test(followUpText);
	await new Promise((r) => setTimeout(r, 1000));
	send('approval_list');
	setTimeout(() => finish(Object.values(checks).every(Boolean)), 2500);
}

ws.onerror = (ev) => { log('[probe] ws 错误：' + (ev.message ?? 'unknown')); finish(false); };
