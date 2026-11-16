// 入口：node index.js
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, start } from './src/server.mjs';

const configPath = process.env.PI_GATEWAY_CONFIG ?? path.join(import.meta.dirname, 'config', 'config.json');
const logFile = process.env.PI_GATEWAY_LOG ?? path.join(import.meta.dirname, 'logs', 'gateway.log');

function log(...args) {
	const line = `${new Date().toISOString()} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
	console.log(line);
	try {
		fs.mkdirSync(path.dirname(logFile), { recursive: true });
		fs.appendFileSync(logFile, `${line}\n`);
	} catch {
		/* 日志写不进去不影响服务 */
	}
}

const config = loadConfig(configPath, log);
config.__path = configPath;

if (!config.token) {
	log('[gateway] 致命：没有配置 token（config.json 的 token 或环境变量 PI_GATEWAY_TOKEN）。拒绝启动。');
	process.exit(1);
}

start({ config, log });
