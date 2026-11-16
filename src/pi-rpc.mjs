// 用 RPC 模式驱动一个 pi 子进程：pi --mode rpc
// 协议：一行一条 JSON，LF 分帧（不能用 Node readline，它还会按 U+2028/U+2029 断行）。
// 命令可带 id，响应按 id 关联而不是按顺序到达。

import { spawn } from 'node:child_process';
import { makeLineSplitter, parseJson } from './protocol.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;

export class PiRpc {
	/**
	 * @param {{command?:string,args?:string[],cwd?:string,env?:object,log?:(...a:any[])=>void}} opts
	 */
	constructor(opts = {}) {
		this.command = opts.command ?? 'pi';
		this.args = opts.args ?? ['--mode', 'rpc', '--no-session'];
		this.cwd = opts.cwd;
		this.env = opts.env;
		this.log = opts.log ?? (() => {});
		this.child = null;
		this.startedAt = null;
		this.pending = new Map(); // id -> {resolve,reject,timer,command}
		this.listeners = new Set();
		this.state = null; // 最近一次 get_state / 事件推导出的状态
		this.seq = 0;
		this.stopping = false;
		this.exitInfo = null;
	}

	onEvent(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	get connected() {
		return !!this.child && this.child.exitCode === null && !this.stopping;
	}

	start() {
		if (this.child) throw new Error('pi 子进程已在运行');
		this.stopping = false;
		this.exitInfo = null;
		this.log(`[pi] 启动：${this.command} ${this.args.join(' ')} (cwd=${this.cwd ?? process.cwd()})`);
		this.child = spawn(this.command, this.args, {
			cwd: this.cwd,
			env: this.env ?? process.env,
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsVerbatimArguments: false,
		});
		this.startedAt = Date.now();
		this.child.stdout.setEncoding('utf8');
		this.child.stderr.setEncoding('utf8');
		const split = makeLineSplitter();
		this.child.stdout.on('data', (chunk) => {
			for (const line of split(chunk)) this.#handleLine(line);
		});
		this.child.stderr.on('data', (chunk) => {
			const text = String(chunk).trim();
			if (text) this.log(`[pi:err] ${text.slice(0, 500)}`);
		});
		this.child.on('error', (err) => {
			this.log(`[pi] 进程错误：${err?.message}`);
			this.#failAll(err instanceof Error ? err : new Error(String(err)));
		});
		this.child.on('close', (code, signal) => {
			this.exitInfo = { code, signal, at: new Date().toISOString() };
			this.log(`[pi] 子进程退出 code=${code} signal=${signal}`);
			this.#failAll(new Error(`pi 子进程已退出 (code=${code ?? signal})`));
			for (const listener of [...this.listeners]) {
				try {
					listener({ type: 'process_closed', code, signal });
				} catch (err) {
					this.log(`[pi] 事件监听器异常：${err?.message}`);
				}
			}
		});
		return this;
	}

	/** 等待第一次 get_state 成功，作为「可以开工」的信号。 */
	async waitReady(timeoutMs = 20_000) {
		const deadline = Date.now() + timeoutMs;
		let lastError = null;
		while (Date.now() < deadline) {
			if (!this.connected) throw lastError ?? new Error('pi 子进程未运行');
			try {
				const res = await this.request('get_state', {}, 5_000);
				if (res.success) {
					this.state = res.data ?? null;
					return this.state;
				}
				lastError = new Error(res.error ?? 'get_state 失败');
			} catch (err) {
				lastError = err;
			}
			await new Promise((r) => setTimeout(r, 300));
		}
		throw lastError ?? new Error('等待 pi 就绪超时');
	}

	request(command, fields = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
		if (!this.connected) return Promise.reject(new Error('pi 子进程未运行'));
		const id = `g${++this.seq}`;
		const payload = { id, type: command, ...fields };
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve({ type: 'response', command, success: false, error: `命令 ${command} 超时（${timeoutMs}ms）`, timeout: true });
			}, timeoutMs);
			this.pending.set(id, { resolve, timer, command });
			try {
				this.child.stdin.write(`${JSON.stringify(payload)}\n`);
			} catch (err) {
				clearTimeout(timer);
				this.pending.delete(id);
				resolve({ type: 'response', command, success: false, error: `写入 stdin 失败：${err?.message}` });
			}
		});
	}

	#handleLine(line) {
		const record = parseJson(line);
		if (!record || typeof record !== 'object') {
			this.log(`[pi] 忽略无法解析的行：${line.slice(0, 200)}`);
			return;
		}
		if (record.type === 'response' && record.id) {
			const entry = this.pending.get(record.id);
			if (entry) {
				clearTimeout(entry.timer);
				this.pending.delete(record.id);
				entry.resolve(record);
				return;
			}
		}
		if (record.type === 'response' && !record.success && record.command) {
			// 无 id 的失败（例如 JSON 解析失败）记日志即可
			this.log(`[pi] ${record.command} 失败：${record.error ?? ''}`);
			if (record.command === 'parse') return;
		}
		this.#deriveState(record);
		for (const listener of [...this.listeners]) {
			try {
				listener(record);
			} catch (err) {
				this.log(`[pi] 事件监听器异常：${err?.message}`);
			}
		}
	}

	#deriveState(record) {
		if (record.type === 'agent_start') this.state = { ...(this.state ?? {}), isStreaming: true };
		if (record.type === 'agent_settled') this.state = { ...(this.state ?? {}), isStreaming: false };
		if (record.type === 'compaction_start') this.state = { ...(this.state ?? {}), isCompacting: true };
		if (record.type === 'compaction_end') this.state = { ...(this.state ?? {}), isCompacting: false };
	}

	#failAll(err) {
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.resolve({ type: 'response', command: entry.command, success: false, error: err.message });
		}
		this.pending.clear();
	}

	// ---- 便捷方法 ----

	/** 发一条 prompt；message 省略时不会发送任何提示，所以这里必须带 message。 */
	prompt(message, images) {
		const fields = { message };
		if (Array.isArray(images) && images.length) fields.images = images;
		return this.request('prompt', fields, 30_000);
	}

	steer(message, images) {
		const fields = { message };
		if (Array.isArray(images) && images.length) fields.images = images;
		return this.request('steer', fields, 30_000);
	}

	followUp(message, images) {
		const fields = { message };
		if (Array.isArray(images) && images.length) fields.images = images;
		return this.request('follow_up', fields, 30_000);
	}

	abort() {
		return this.request('abort', {}, 15_000);
	}

	clearQueue() {
		return this.request('clear_queue', {}, 10_000);
	}

	getState() {
		return this.request('get_state', {}, 10_000);
	}

	getMessages() {
		return this.request('get_messages', {}, 30_000);
	}

	getCommands() {
		return this.request('get_commands', {}, 10_000);
	}

	getAvailableModels() {
		return this.request('get_available_models', {}, 15_000);
	}

	setModel(provider, modelId) {
		return this.request('set_model', { provider, modelId }, 15_000);
	}

	setThinkingLevel(level) {
		return this.request('set_thinking_level', { level }, 10_000);
	}

	newSession(parentSession) {
		const fields = parentSession ? { parentSession } : {};
		return this.request('new_session', fields, 20_000);
	}

	switchSession(sessionPath) {
		return this.request('switch_session', { sessionPath }, 30_000);
	}

	fork(entryId) {
		return this.request('fork', entryId ? { entryId } : {}, 20_000);
	}

	clone() {
		return this.request('clone', {}, 20_000);
	}

	setSessionName(name) {
		return this.request('set_session_name', name ? { name } : {}, 10_000);
	}

	getSessionStats() {
		return this.request('get_session_stats', {}, 10_000);
	}

	getLastAssistantText() {
		return this.request('get_last_assistant_text', {}, 15_000);
	}

	bash(command, timeoutMs = 60_000) {
		return this.request('bash', {}, timeoutMs + 5_000).then((res) => res);
	}

	/** 回应 Pi 发来的扩展 UI 请求（审批/提问）。id 复用请求里的 id，不产生普通响应。 */
	resolveExtensionUi(id, value) {
		if (!this.connected) return false;
		try {
			this.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id, ...value })}\n`);
			return true;
		} catch (err) {
			this.log(`[pi] 写 extension_ui_response 失败：${err?.message}`);
			return false;
		}
	}

	/**
	 * 有序关停：关闭 stdin（RPC 文档说关 stdin 会等未完成的工作退出），
	 * 给 timeoutMs 时间，超时再 SIGTERM，最后强杀。
	 */
	async stop(timeoutMs = 8_000) {
		if (!this.child) return;
		this.stopping = true;
		const child = this.child;
		const exited = new Promise((resolve) => {
			const onExit = () => {
				clearTimeout(t1);
				clearTimeout(t2);
				resolve();
			};
			child.once('close', onExit);
			const t1 = setTimeout(() => {
				try {
					child.kill('SIGTERM');
				} catch {
					/* ignore */
				}
			}, timeoutMs);
			const t2 = setTimeout(() => {
				try {
					child.kill('SIGKILL');
				} catch {
					/* ignore */
				}
			}, timeoutMs + 5_000);
		});
		try {
			child.stdin.end();
		} catch {
			/* ignore */
		}
		await exited;
	}
}
