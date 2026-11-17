#!/usr/bin/env node
// 部署清单读取器：域名 / 服务器路径 / SSH 目标这些真实值不入库，放在 config/deploy.local.json。
// 用法：
//   node scripts/deploy-config.mjs --path                  # 清单文件路径（给 ps1 等外部读者）
//   node scripts/deploy-config.mjs --get ssh.host          # 取一个点号路径的值
//   node scripts/deploy-config.mjs --sh                    # 打印 NAME='value' 供 shell eval
//   node scripts/deploy-config.mjs --json                  # 整个清单
// 缺文件时不猜默认值：直接退出并提示复制 config/deploy.example.json。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = process.env.PI_DEPLOY_CONFIG || path.join(ROOT, 'config', 'deploy.local.json');
const EXAMPLE = path.join(ROOT, 'config', 'deploy.example.json');

function die(msg) {
	console.error(msg);
	process.exit(2);
}

function load() {
	if (!fs.existsSync(LOCAL)) {
		die(`找不到部署清单：${LOCAL}\n请先复制：cp "${EXAMPLE}" "${LOCAL}" 并填上你的真实域名/服务器路径。`);
	}
	let cfg;
	try {
		cfg = JSON.parse(fs.readFileSync(LOCAL, 'utf8'));
	} catch (err) {
		die(`部署清单不是合法 JSON（${LOCAL}）：${err?.message}`);
	}
	const raw = JSON.stringify(cfg);
	if (/CHANGE[-_]ME|your-domain\.example/.test(raw)) {
		die(`${LOCAL} 里还是示例占位值，先把真实值填进去再跑。`);
	}
	return cfg;
}

function get(obj, dotted) {
	return String(dotted ?? '').split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// ssh.host -> SSH_HOST, server.uiBackupDir -> SERVER_UI_BACKUP_DIR
function flatten(obj, prefix = [], out = []) {
	for (const [k, v] of Object.entries(obj ?? {})) {
		if (k.startsWith('_')) continue;
		if (v && typeof v === 'object' && !Array.isArray(v)) {
			flatten(v, [...prefix, k], out);
		} else {
			const seg = [k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')];
			out.push([[...prefix, ...seg].join('_').toUpperCase(), v]);
		}
	}
	return out;
}

const arg = process.argv[2];
if (arg === '--path') {
	console.log(LOCAL);
} else if (arg === '--json') {
	console.log(JSON.stringify(load(), null, 2));
} else if (arg === '--get') {
	const value = get(load(), process.argv[3]);
	if (value === undefined) die(`清单里没有 ${process.argv[3]}`);
	console.log(value);
} else if (arg === '--sh') {
	for (const [name, value] of flatten(load())) {
		console.log(`${name}='${String(value).replace(/'/g, `'\\''`)}'`);
	}
} else {
	die('用法: deploy-config.mjs --path | --get <a.b.c> | --sh | --json');
}
