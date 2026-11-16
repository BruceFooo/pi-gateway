// 本地通知挡板：把网关打过来的企业微信通知请求原样记录下来，用来在**不发布到服务器**的前提下
// 验证「网关确实发了通知、带对了 token 和收件人」。用法：node scripts/notify-stub.mjs [端口]
import http from 'node:http';

const port = Number(process.argv[2] ?? 33399);
const hits = [];

const server = http.createServer((req, res) => {
	if (req.method === 'GET' && (req.url === '/hits' || req.url === '/')) {
		res.writeHead(200, { 'content-type': 'application/json;charset=utf-8' });
		res.end(JSON.stringify({ ok: true, count: hits.length, hits }));
		return;
	}
	let body = '';
	req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
	req.on('end', () => {
		const entry = {
			at: new Date().toISOString(),
			method: req.method,
			path: req.url,
			token: req.headers['x-pi-token'] ?? req.headers['x-pi-token'] ?? null,
			body,
		};
		hits.push(entry);
		console.log(`[stub] ${entry.method} ${entry.url} token=${entry.token ? entry.token.slice(0, 6) + '…' : '无'}`);
		console.log(`[stub]   body=${body}`);
		res.writeHead(200, { 'content-type': 'application/json;charset=utf-8' });
		res.end(JSON.stringify({ code: 200, msg: 'stub ok', hits: hits.length }));
	});
});

server.listen(port, '127.0.0.1', () => console.log(`notify stub on http://127.0.0.1:${port}/ui/api/pi/notify`));

setInterval(() => {
	console.log(`[stub] 已收到 ${hits.length} 条通知`);
}, 30000);
