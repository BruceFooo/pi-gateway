// 一次性企业微信通知出口：给网关进程**外面**的脚本用（restart-service.ps1 等）。
// 为什么需要它：网关自己要被重启时，它已经无法通知手机了 —— 通知必须由还活着的进程发。
// 用法：node scripts/notify-once.mjs "<标题>" "<正文>" [kind]
// 复用网关同一份配置（config/config.json，可用 PI_GATEWAY_CONFIG 覆盖）与同一个 Notifier。
import path from 'node:path';
import { loadConfig } from '../src/server.mjs';
import { Notifier } from '../src/notify.mjs';

const configPath = process.env.PI_GATEWAY_CONFIG ?? path.join(import.meta.dirname, '..', 'config', 'config.json');
const config = loadConfig(configPath, (...a) => console.log(...a));
const [title, body, kind] = process.argv.slice(2);

if (!title || !body) {
	console.log('用法：node scripts/notify-once.mjs "<标题>" "<正文>" [kind]');
	process.exit(2);
}

const notifier = new Notifier({ ...config.notify });
const result = await notifier.send({ title, body, kind: kind ?? 'notice', throttleMs: 0 });
console.log(result.ok ? `NOTIFY_OK -> ${config.notify.toUser}` : `NOTIFY_FAIL ${result.error ?? result.skipped}`);
// 用 exitCode 而不是 process.exit()：process.exit() 会在 Windows 上弄断 libuv 的收尾
// （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:94），日志里多一行无意义堆栈。
process.exitCode = result.ok ? 0 : 1;
