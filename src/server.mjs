// 对外接口层：/healthz、/pi/ws（WebSocket）、/pi/media（图片）、/pi/pages（本机 skill 生成的 HTML 页）。
// 只监听 127.0.0.1，由 nginx + frp 暴露到公网。

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { PKG_ROOT, STATE_DIR, MEDIA_DIR, PAGES_DIR } from './paths.mjs';
import { acceptUpgrade, CLOSE_POLICY } from './ws.mjs';
import { Gateway } from './gateway.mjs';
import { SessionStore } from './session.mjs';
import { Notifier } from './notify.mjs';
import { PageStore } from './pages.mjs';

const MEDIA_ALLOWED_MIME = new Map([
	['image/png', 'png'],
	['image/jpeg', 'jpg'],
	['image/jpg', 'jpg'],
	['image/webp', 'webp'],
	['image/gif', 'gif'],
]);

export function loadConfig(configPath, log) {
	const defaults = {
		host: '127.0.0.1',
		port: 33336,
		token: '',
		piCommand: 'pi.cmd',
		piArgs: ['--mode', 'rpc', '--no-session'],
		cwd: undefined,
		sessionsDir: path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.pi', 'agent', 'sessions'),
		entrySessionId: null,
		defaultCwd: undefined,
		notify: { centerUrl: 'https://<CENTER域名>', token: '', toUser: 'opsUser', enabled: true },
		retentionHours: 48,
		maxImagesPerMessage: 4,
		maxImageBytes: 8 * 1024 * 1024,
	};
	let file = {};
	try {
		file = JSON.parse(fs.readFileSync(configPath, 'utf8'));
	} catch (err) {
		log(`[config] 未读取到配置 ${configPath}：${err?.message}（用内置默认值）`);
	}
	const merged = { ...defaults, ...file, notify: { ...defaults.notify, ...(file.notify ?? {}) } };
	merged.token = process.env.PI_GATEWAY_TOKEN || merged.token;
	merged.notify.token = process.env.PI_CENTER_NOTIFY_TOKEN || merged.notify.token;
	// 本地自测时把通知改指到 scripts/notify-stub.mjs（http://127.0.0.1:33399）：
	// 配置文件里永远放生产 center 地址，本地测试靠环境变量临时改，不来回改文件。
	merged.notify.centerUrl = process.env.PI_NOTIFY_CENTER_URL || merged.notify.centerUrl;
	merged.piCommand = process.env.PI_GATEWAY_PI_COMMAND || merged.piCommand;
	return merged;
}

class MediaStore {
	constructor(dir, { log, maxImageBytes, maxImagesPerMessage }) {
		this.dir = dir;
		this.log = log;
		this.maxImageBytes = maxImageBytes;
		this.maxImagesPerMessage = maxImagesPerMessage;
		fs.mkdirSync(this.dir, { recursive: true });
	}

	save(mimeType, base64) {
		const ext = MEDIA_ALLOWED_MIME.get(String(mimeType).toLowerCase());
		if (!ext) return { error: `不支持的图片类型：${mimeType}` };
		let buf;
		try {
			buf = Buffer.from(String(base64), 'base64');
		} catch (err) {
			return { error: `图片解码失败：${err?.message}` };
		}
		if (!buf.length) return { error: '图片内容为空' };
		if (buf.length > this.maxImageBytes) return { error: `图片过大（${buf.length} 字节，上限 ${this.maxImageBytes}）` };
		const id = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${Math.random().toString(36).slice(2, 8)}`;
		const file = path.join(this.dir, `${id}.${ext}`);
		fs.writeFileSync(file, buf);
		return { id, url: `/pi/media/${id}.${ext}`, bytes: buf.length };
	}

	resolve(id) {
		const safe = String(id).replace(/[^A-Za-z0-9._-]/g, '');
		if (!safe || safe.includes('..')) return null;
		const full = path.join(this.dir, safe);
		if (!full.startsWith(path.resolve(this.dir))) return null;
		return fs.existsSync(full) ? full : null;
	}

	pruneOlderThan(hours, log) {
		try {
			const cutoff = Date.now() - hours * 3600_000;
			let removed = 0;
			for (const name of fs.readdirSync(this.dir)) {
				const full = path.join(this.dir, name);
				const stat = fs.statSync(full);
				if (stat.isFile() && stat.mtimeMs < cutoff) {
					fs.unlinkSync(full);
					removed++;
				}
			}
			if (removed) log(`[media] 清理了 ${removed} 个过期图片`);
		} catch (err) {
			log(`[media] 清理失败：${err?.message}`);
		}
	}
}

function tokenOk(provided, expected) {
	if (!expected) return false;
	const a = Buffer.from(String(provided ?? ''), 'utf8');
	const b = Buffer.from(String(expected), 'utf8');
	return a.length === b.length && timingSafeEqual(a, b);
}

export function createServer({ config, log }) {
	// media / state 统一落在包根下（见 paths.mjs：不能用 config.__path 推，否则会写进 config/）
	fs.mkdirSync(STATE_DIR, { recursive: true });
	const root = PKG_ROOT;
	const media = new MediaStore(MEDIA_DIR, {
		log,
		maxImageBytes: config.maxImageBytes,
		maxImagesPerMessage: config.maxImagesPerMessage,
	});
	// 页面发布：pages/ 也在包根下（已在 .gitignore）。只发本机自己生成的 HTML。
	const pages = new PageStore({ dir: PAGES_DIR, log, maxPageBytes: config.maxPageBytes ?? 2 * 1024 * 1024 });
	const sessions = new SessionStore({ dir: config.sessionsDir, log });
	const notifier = new Notifier({ ...config.notify, log });
	const gateway = new Gateway({
		config,
		log,
		sessions,
		notifier,
		mediaDir: MEDIA_DIR,
		pages,
		saveImage: (mime, b64) => media.save(mime, b64),
	});

	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/pi/healthz')) {
			const body = JSON.stringify({
				ok: true,
				protocol: 1,
				uptimeSec: Math.round(process.uptime()),
				pi: gateway.piStatus(),
				running: gateway.currentRunId,
				notify: notifier.status(),
			});
			res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
			res.end(body);
			return;
		}
		if (req.method === 'GET' && url.pathname.startsWith('/pi/media/')) {
			if (!tokenOk(url.searchParams.get('token') ?? req.headers['x-pi-token'], config.token)) {
				res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
				res.end('unauthorized');
				return;
			}
			const full = media.resolve(url.pathname.slice('/pi/media/'.length));
			if (!full) {
				res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
				res.end('not found');
				return;
			}
			const ext = path.extname(full).slice(1).toLowerCase();
			const mime = [...MEDIA_ALLOWED_MIME.entries()].find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream';
			res.writeHead(200, { 'content-type': mime, 'cache-control': 'private, max-age=86400' });
			fs.createReadStream(full).pipe(res);
			return;
		}
		if (req.method === 'GET' && url.pathname.startsWith('/pi/pages/')) {
			// 页面与本控制台同源（手机只信这一个域名），所以能直接跑脚本；
			// 代价是只能放本机自己生成的 HTML，不能拿它代理第三方页面。
			if (!tokenOk(url.searchParams.get('token') ?? req.headers['x-pi-token'], config.token)) {
				res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
				res.end('unauthorized');
				return;
			}
			const full = pages.resolve(url.pathname.slice('/pi/pages/'.length));
			if (!full) {
				res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
				res.end('not found');
				return;
			}
			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				// 解释页需要页内 <style>/<script>；禁掉外部源与 iframe，降低“万一页子内容有问题”的影响面。
				'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'self'",
				'x-content-type-options': 'nosniff',
				'referrer-policy': 'no-referrer',
				'cache-control': 'no-store',
			});
			fs.createReadStream(full).pipe(res);
			return;
		}
		res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
		res.end('not found');
	});

	server.on('upgrade', (req, socket, head) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		if (url.pathname !== '/pi/ws') {
			socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
			socket.destroy();
			return;
		}
		const provided = url.searchParams.get('token') ?? req.headers['x-pi-token'] ?? '';
		if (!tokenOk(provided, config.token)) {
			socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
			socket.destroy();
			return;
		}
		const conn = acceptUpgrade(req, socket, head, { maxPayload: config.maxImageBytes ? config.maxImageBytes * 6 : 32 * 1024 * 1024 });
		if (!conn) return;
		gateway.addClient(conn);
		let bytesInFlight = 0;
		conn.onMessage = (text) => {
			void gateway.handleMessage(conn, text);
		};
		conn.onClose = () => gateway.removeClient(conn);
		const originalSend = conn.send.bind(conn);
		conn.send = (text) => {
			// 客户端太慢就断开，避免事件流把网关内存撑爆
			bytesInFlight = socket.writableLength ?? 0;
			if (bytesInFlight > 4 * 1024 * 1024) {
				log('[ws] 客户端写入积压过大，主动断开');
				conn.close(1013, 'backpressure');
				return false;
			}
			return originalSend(text);
		};
		log(`[ws] 已连接（当前 ${gateway.clientCount} 个设备）`);
	});

	gateway.onEvent((evt) => {
		const text = JSON.stringify(evt);
		for (const conn of gateway.clients) {
			try {
				conn.send(text);
			} catch (err) {
				log(`[ws] 发送失败：${err?.message}`);
			}
		}
	});

	const timer = setInterval(() => {
		media.pruneOlderThan(config.retentionHours, log);
		// 页面比图片容易再打开（手机会加书签），保留期长一些；config.pageRetentionHours 可调。
		pages.pruneOlderThan(config.pageRetentionHours ?? 24 * 14, log);
	}, 6 * 3600_000);
	timer.unref?.();

	return { server, gateway, notifier, sessions, media, pages, config };
}

export function start({ config, log }) {
	const app = createServer({ config, log });
	app.server.listen(config.port, config.host, () => {
		log(`[gateway] 监听 http://${config.host}:${config.port} （/healthz, /pi/ws, /pi/media）`);
		log(`[gateway] 会话目录 ${config.sessionsDir}`);
		log(`[gateway] 企业微信通知 ${app.notifier.status().label}`);
		void app.gateway.ensurePi();
	});
	const shutdown = (signal) => {
		log(`[gateway] 收到 ${signal}，开始关停`);
		void (async () => {
			try {
				await app.gateway.stop();
			} catch (err) {
				log(`[gateway] 关停异常：${err?.message}`);
			}
			app.server.close(() => process.exit(0));
			setTimeout(() => process.exit(0), 3_000).unref?.();
		})();
	};
	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));
	app.server.on('clientError', (err) => log(`[http] 客户端错误：${err?.message}`));
	return app;
}
