// 极简 RFC6455 服务端（文本帧、单帧消息、ping/pong/close），只用 node 内置模块。
// 与 pi-browser-assistant 的 ws.ts 同目的，但这里要收发图片（最大约 8MB），所以
// 长度字段支持 16/64 位；分片帧只累积不解析（浏览器不会主动分片）。

import { createHash, randomBytes } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export const CLOSE_NORMAL = 1000;
export const CLOSE_POLICY = 1008;
export const CLOSE_GOING_AWAY = 1001;

function encodeFrame(opcode, payload, { mask = false, maskKey } = {}) {
	const len = payload.length;
	let header;
	if (len < 126) {
		header = Buffer.alloc(2);
		header[1] = len;
	} else if (len < 0x10000) {
		header = Buffer.alloc(4);
		header[1] = 126;
		header.writeUInt16BE(len, 2);
	} else {
		header = Buffer.alloc(10);
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(len), 2);
	}
	header[0] = 0x80 | opcode; // FIN + opcode
	if (!mask) return Buffer.concat([header, payload]);
	const key = maskKey ?? randomBytes(4);
	const masked = Buffer.allocUnsafe(len);
	for (let i = 0; i < len; i += 1) masked[i] = payload[i] ^ key[i & 3];
	header[1] |= 0x80;
	return Buffer.concat([header, key, masked]);
}

export class WsConnection {
	constructor(socket, { maxPayload = 8 * 1024 * 1024, onMessage, onClose, onError } = {}) {
		this.socket = socket;
		this.maxPayload = maxPayload;
		this.onMessage = onMessage ?? (() => {});
		this.onClose = onClose ?? (() => {});
		this.onError = onError ?? (() => {});
		this.buffer = Buffer.alloc(0);
		this.fragments = [];
		this.fragmentOpcode = 0;
		this.closed = false;
		this.alive = true;
		socket.on('data', (chunk) => this.#consume(chunk));
		socket.on('error', (err) => {
			this.onError(err);
			this.finish(CLOSE_GOING_AWAY, err?.message ?? 'socket error');
		});
		socket.on('close', () => this.finish(CLOSE_GOING_AWAY, 'socket closed'));
	}

	get isOpen() {
		return !this.closed;
	}

	send(text) {
		if (this.closed) return false;
		try {
			this.socket.write(encodeFrame(OP_TEXT, Buffer.from(String(text), 'utf8')));
			return true;
		} catch (err) {
			this.onError(err);
			this.finish(CLOSE_GOING_AWAY, err?.message ?? 'send failed');
			return false;
		}
	}

	ping() {
		if (this.closed) return;
		try {
			this.socket.write(encodeFrame(OP_PING, Buffer.alloc(0)));
		} catch {
			/* ignore */
		}
	}

	close(code = CLOSE_NORMAL, reason = '') {
		if (this.closed) return;
		const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
		payload.writeUInt16BE(code, 0);
		payload.write(reason, 2);
		try {
			this.socket.write(encodeFrame(OP_CLOSE, payload));
		} catch {
			/* ignore */
		}
		this.finish(code, reason);
	}

	finish(code, reason) {
		if (this.closed) return;
		this.closed = true;
		try {
			this.socket.destroy();
		} catch {
			/* ignore */
		}
		this.onClose(code, reason);
	}

	feed(chunk) {
		if (chunk && chunk.length) this.#consume(chunk);
	}

	#consume(chunk) {
		this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
		if (this.buffer.length > this.maxPayload) {
			this.finish(CLOSE_POLICY, 'message too large');
			return;
		}
		for (;;) {
			const frame = this.#readFrame();
			if (!frame) return;
			this.#handleFrame(frame);
			if (this.closed) return;
		}
	}

	#readFrame() {
		const buf = this.buffer;
		if (buf.length < 2) return null;
		const fin = (buf[0] & 0x80) !== 0;
		const opcode = buf[0] & 0x0f;
		const masked = (buf[1] & 0x80) !== 0;
		let len = buf[1] & 0x7f;
		let offset = 2;
		if (len === 126) {
			if (buf.length < offset + 2) return null;
			len = buf.readUInt16BE(offset);
			offset += 2;
		} else if (len === 127) {
			if (buf.length < offset + 8) return null;
			const big = buf.readBigUInt64BE(offset);
			if (big > BigInt(this.maxPayload)) {
				this.finish(CLOSE_POLICY, 'message too large');
				return null;
			}
			len = Number(big);
			offset += 8;
		}
		let mask;
		if (masked) {
			if (buf.length < offset + 4) return null;
			mask = buf.subarray(offset, offset + 4);
			offset += 4;
		}
		if (buf.length < offset + len) return null;
		const payload = buf.subarray(offset, offset + len);
		this.buffer = buf.subarray(offset + len);
		if (masked) {
			const out = Buffer.allocUnsafe(len);
			for (let i = 0; i < len; i += 1) out[i] = payload[i] ^ mask[i & 3];
			return { fin, opcode, payload: out };
		}
		return { fin, opcode, payload: Buffer.from(payload) };
	}

	#handleFrame({ fin, opcode, payload }) {
		if (opcode === OP_CLOSE) {
			const code = payload.length >= 2 ? payload.readUInt16BE(0) : CLOSE_NORMAL;
			this.finish(code, 'peer close');
			return;
		}
		if (opcode === OP_PING) {
			try {
				this.socket.write(encodeFrame(OP_PONG, payload));
			} catch {
				/* ignore */
			}
			return;
		}
		if (opcode === OP_PONG) {
			this.alive = true;
			return;
		}
		if (opcode === OP_CONT) {
			this.fragments.push(payload);
			if (!fin) return;
			const full = Buffer.concat(this.fragments);
			const type = this.fragmentOpcode;
			this.fragments = [];
			this.fragmentOpcode = 0;
			if (type === OP_TEXT) this.onMessage(full.toString('utf8'));
			return;
		}
		if (opcode === OP_TEXT || opcode === OP_BIN) {
			if (!fin) {
				this.fragments = [payload];
				this.fragmentOpcode = opcode;
				return;
			}
			if (opcode === OP_TEXT) this.onMessage(payload.toString('utf8'));
			else this.finish(CLOSE_POLICY, 'binary frames not supported');
			return;
		}
		this.finish(CLOSE_POLICY, 'bad opcode');
	}
}

const SEC_WS_KEY_RE = /^(?:[A-Za-z0-9+\/]{4})*(?:[A-Za-z0-9+\/]{2}==|[A-Za-z0-9+\/]{3}=)?$/;

/** 完成 WebSocket 握手；返回 null 表示不是合法升级请求（调用方自行 400）。 */
export function acceptUpgrade(req, socket, head, options = {}) {
	const key = String(req.headers['sec-websocket-key'] ?? '');
	const version = String(req.headers['sec-websocket-version'] ?? '');
	const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
	const connection = String(req.headers.connection ?? '').toLowerCase().split(/[\s,]+/);
	if (req.method !== 'GET' || req.httpVersionMajor !== 1 || upgrade !== 'websocket' || !connection.includes('upgrade') || version !== '13' || !SEC_WS_KEY_RE.test(key)) {
		socket.destroy('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
		return null;
	}
	const accept = createHash('sha1').update(key + GUID).digest('base64');
	socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
	const conn = new WsConnection(socket, options);
	conn.feed(head);
	return conn;
}
