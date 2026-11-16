// 包内固定路径：媒体、状态文件都放在包根下（已在 .gitignore 里）。
// 别从 config.__path 推根目录 —— 那是 <pkg>/config/config.json，dirname 一次会落到 config/，
// 于是 media/ 和 state/ 被写进配置目录（config/ 不在 .gitignore 里，会被 git 跟踪）。

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STATE_DIR = path.join(PKG_ROOT, 'state');
export const MEDIA_DIR = path.join(PKG_ROOT, 'media');
export const PAGES_DIR = path.join(PKG_ROOT, 'pages');
