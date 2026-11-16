#!/usr/bin/env node
/**
 * 页面发布（pages/）的离线回归（不连活体网关）：锁住安全边界与可重复打开的行为。
 *   1) 只发本机自己生成的 HTML；越界路径 / 非 .html / 超大 一律拒绝
 *   2) 同一个文件重发 → 同一个 URL（手机书签不会失效）
 *   3) 不同目录同名文件 → 不同 URL（不互相覆盖）
 *   4) 标题优先 index.json，其次 <title>，最后文件名；重启（重建实例）后仍能列出
 *   5) pruneOlderThan 只删过期的，且同步清 index
 * 用法：node scripts/verify-pages.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PageStore } from '../src/pages.mjs';

let n = 0, bad = 0;
const check = (ok, label, extra = '') => { n++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  :: ' + extra : ''}`); if (!ok) bad++; };
const sha8 = (s) => crypto.createHash('sha1').update(String(s).toLowerCase()).digest('hex').slice(0, 8);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piverify-'));
const dir = path.join(root, 'pages');
const srcA = path.join(root, 'outA');
const srcB = path.join(root, 'outB');
fs.mkdirSync(srcA, { recursive: true });
fs.mkdirSync(srcB, { recursive: true });
const html = (t) => `<!doctype html><html><head><meta charset="utf-8"><title>${t}</title></head><body><h1>${t}</h1><script>console.log(1)</script></body></html>`;
const fileA = path.join(srcA, 'explain.html');
const fileB = path.join(srcB, 'explain.html'); // 同名不同目录
const fileMd = path.join(srcA, 'note.md');
fs.writeFileSync(fileA, html('A 页'));
fs.writeFileSync(fileB, html('B 页'));
fs.writeFileSync(fileMd, '# 不是网页');

const log = () => {};
const store = new PageStore({ dir, log });

// 1) 基本发布 + 标题（显式优先）
const p1 = store.publish(fileA, '调度原理');
check(!!p1 && p1.name.endsWith('.html'), '发布成功并返回文件名', p1?.name);
check(p1.url === `/pi/pages/${p1.name}`, 'url 就是 /pi/pages/<文件名>', p1.url);
check(p1.title === '调度原理', '显式标题优先', p1.title);
check(p1.name.includes(sha8(fileA)), '文件名带源路径短哈希（可重复打开、不泄露目录）', p1.name);
check(fs.existsSync(path.join(dir, p1.name)), '文件确实复制进 pages/');

// 2) 重复发布同文件 → 同名（书签不失效），内容更新
fs.writeFileSync(fileA, html('A 页 v2'));
const p2 = store.publish(fileA, '调度原理 v2');
check(p2.name === p1.name, '同文件重发 → 同一个 URL', `${p1.name} vs ${p2.name}`);
check(fs.readFileSync(path.join(dir, p1.name), 'utf8').includes('A 页 v2'), '重发会覆盖为新内容');
check(store.list().length === 1, '列表不会因重发变长', String(store.list().length));

// 3) 不同目录同名 → 不同 URL
const p3 = store.publish(fileB);
check(p3.name !== p1.name, '不同目录的同名文件不互相覆盖', `${p1.name} / ${p3.name}`);
check(p3.title === 'B 页', '没给标题时取 <title>', p3.title);
check(store.list().length === 2, '列表两条');

// 4) 安全边界
let threw = '';
try { store.publish(fileMd); } catch (e) { threw = String(e.message || e); }
check(!!threw, '非 .html 被拒绝', threw);
threw = '';
try { store.publish(path.join(root, 'missing.html')); } catch (e) { threw = String(e.message || e); }
check(!!threw, '不存在的源文件被拒绝', threw);
threw = '';
try { store.publish(dir); } catch (e) { threw = String(e.message || e); }
check(!!threw, '目录不能当页面发布', threw);
const big = path.join(srcA, 'big.html');
fs.writeFileSync(big, html('x'.repeat(5000)));
const small = new PageStore({ dir, log, maxPageBytes: 200 });
threw = '';
try { small.publish(big); } catch (e) { threw = String(e.message || e); }
check(/页面太大/.test(threw), '超过 maxPageBytes 被拒绝', threw);
check(store.resolve('..\\..\\config\\config.json') === null, 'resolve 拒绝 ../ 越界读配置');
check(store.resolve('../../config/config.json') === null, 'resolve 拒绝 POSIX 越界');
check(store.resolve('a.js') === null && store.resolve('explain.html;x') === null, 'resolve 只接受 <名字>.html');

// 5) 重启语义：新建实例（模拟服务重启）仍能列出，标题来自 index.json
const reopened = new PageStore({ dir, log });
const listed = reopened.list();
check(listed.length === 2, '重启后 pages/ 里已发布过的页面仍在列表', String(listed.length));
check(listed.some((x) => x.title === '调度原理 v2') && listed.some((x) => x.title === 'B 页'), '标题从 index.json 恢复', JSON.stringify(listed.map((x) => x.title)));
check(listed.every((x) => x.url.startsWith('/pi/pages/')), 'url 前缀正确');
check(reopened.resolve(p1.name) !== null, '重启后按名字仍能取到文件（手机可直接刷新）');
// index.json 丢失时回落 <title>
fs.rmSync(path.join(dir, 'index.json'), { force: true });
const fallback = new PageStore({ dir, log });
check(fallback.list().every((x) => x.title), 'index.json 丢失时标题回落 <title>/文件名', JSON.stringify(fallback.list().map((x) => x.title)));

// 6) 清理：只删过期的
const old = path.join(dir, p3.name);
const past = new Date(Date.now() - 30 * 24 * 3600_000);
fs.utimesSync(old, past, past);
const removed = reopened.pruneOlderThan(24 * 14);
check(removed === 1, 'pruneOlderThan 只删过期的一个', String(removed));
check(!fs.existsSync(old) && fs.existsSync(path.join(dir, p1.name)), '过期的删掉、新的留下');
check(reopened.list().length === 1 && reopened.resolve(p3.name) === null, '列表与索引同步清理', String(reopened.list().length));

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${n - bad}/${n} 通过`);
process.exitCode = bad ? 1 : 0;
