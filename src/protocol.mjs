// 手机端与 gateway 之间的线协议。设计对标 OpenClaw 的 Control UI：
// 事件带单调 seq，断线重连用 lastSeq 补发；补不上就 resync_required，客户端整段重建。

export const PROTOCOL_VERSION = 1;

export const CLIENT_MSG = {
	Resume: 'resume', // {token, lastSeq}
	ChatSend: 'chat_send', // {text, images?:[{data,mimeType,name}]}
	Abort: 'abort',
	QueueList: 'queue_list',
	QueueRemove: 'queue_remove', // {entryId}（目标 id 用专用字段；msg.id 只能是请求配对的 id）
	CronList: 'cron_list',
	CronAdd: 'cron_add', // {prompt, at?:'HH:mm'|ISO, cron?, timezone?, enabled?, title?}
	CronUpdate: 'cron_update', // {cronId, patch}
	CronRunNow: 'cron_run', // {cronId}
	SkillRun: 'skill_run', // {name, args?}
	SkillList: 'skill_list',
	PageList: 'page_list', // 已发布页面列表（skill 生成的 HTML 单页）
	SessionList: 'session_list',
	SessionSwitch: 'session_switch', // {sessionId|null (=绑定入口会话)}
	SessionNew: 'session_new',
	SessionTranscript: 'session_transcript', // {sessionId}
	SessionRename: 'session_rename', // {sessionId, name|null}
	SessionFork: 'session_fork', // {entryId?}
	ModelList: 'model_list',
	ModelSet: 'model_set', // {provider, modelId}
	ThinkingSet: 'thinking_set', // {level}
	ApprovalList: 'approval_list',
	ApprovalResolve: 'approval_resolve', // {approvalId, value}（旧客户端只带 id 时服务端兼容回退）
	Ping: 'ping',
};

export const SERVER_MSG = {
	Ready: 'ready', // {protocol, serverTime, pinnedSessionId, boundSessionId, state, models, commands, resumed}
	Event: 'event', // {seq, event, ...payload}
	ResyncRequired: 'resync_required', // {reason}
	Response: 'response', // {id?, ok, data?, error?}
	Pong: 'pong',
};

// 推给前端的事件名（event 字段）
export const GW_EVENT = {
	AgentStart: 'agent_start',
	AgentSettled: 'agent_settled',
	AssistantDelta: 'assistant_delta', // {messageId, contentIndex, delta}
	AssistantText: 'assistant_text', // {messageId, contentIndex, text} 段结束
	ThinkingDelta: 'thinking_delta',
	ToolStart: 'tool_start', // {toolCallId, toolName, args}
	ToolEnd: 'tool_end', // {toolCallId, toolName, ok, text, durationMs}
	UserMessage: 'user_message', // {text, attachments:[name]}
	QueueUpdate: 'queue_update', // {items:[{id,kind,title,at,pinned}]}
	SessionChanged: 'session_changed', // {sessionId, sessionFile, sessionName, pinned}
	State: 'state', // {isStreaming,isCompacting,pendingMessageCount,model,thinkingLevel,runState}
	RpcState: 'rpc_state', // {connected,lastError,startedAt}
	ApprovalRequested: 'approval_requested', // {id,kind:'select'|'confirm'|'input',title,options?,placeholder?}
	ApprovalResolved: 'approval_resolved', // {id,value}
	ModelChanged: 'model_changed',
	Notice: 'notice', // {level,text}
	PageReady: 'page_ready', // {name,url,title,bytes,at} 本机 HTML 页面已发到手机上
};

export class RingBuffer {
	constructor(limit = 4000) {
		this.limit = limit;
		this.items = [];
		this.firstSeq = 0; // 当前缓冲里最小 seq
		this.nextSeq = 0; // 下一个要分配的 seq
	}

	push(ev) {
		const seq = this.nextSeq++;
		this.items.push({ seq, ...ev });
		if (this.items.length > this.limit) {
			const excess = this.items.length - this.limit;
			this.items.splice(0, excess);
			this.firstSeq += excess;
		}
		return seq;
	}

	/** 补发 seq >= lastSeq 的事件；缓冲覆盖不到时返回 null（调用方发 resync_required）。 */
	replay(lastSeq) {
		if (!Number.isFinite(lastSeq) || lastSeq < 0 || lastSeq > this.nextSeq) return null;
		if (lastSeq < this.firstSeq) return null;
		return this.items.filter((e) => e.seq >= lastSeq);
	}

	get lastSeq() {
		return this.nextSeq;
	}
}

/**
 * 按行切 JSONL：只用 LF 分帧（RPC 文档明确不能用 Node readline，
 * 因为它还会按 U+2028/U+2029 断行），并容忍紧随其前的 CR。
 */
export function makeLineSplitter() {
	let buf = '';
	return function feed(chunk) {
		buf += chunk;
		const out = [];
		let idx;
		while ((idx = buf.indexOf('\n')) >= 0) {
			let line = buf.slice(0, idx);
			buf = buf.slice(idx + 1);
			if (line.endsWith('\r')) line = line.slice(0, -1);
			if (line.trim()) out.push(line);
		}
		return out;
	};
}

export function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}
