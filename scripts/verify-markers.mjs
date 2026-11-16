#!/usr/bin/env node
/**
 * 标记扫描的离线回归（不连活体网关）：文档示例必须被忽略，真标记必须被采纳。
 * 触发这次修复的事故：使用指南回复里的 `[[PI_CONFIRM:问题|选项A|选项B]]` 与 [[PI_SESSION:new]]
 * 被当成真标记执行，弹出「问题」确认卡并新开了会话。
 * 用法：node scripts/verify-markers.mjs
 */
import { findConfirmMarker, findSessionMarker, ignoredMarkerHint } from '../src/markers.mjs';

let n = 0, bad = 0;
const check = (ok, label, extra = '') => { n++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  :: ' + extra : ''}`); if (!ok) bad++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 1) 事故原样：行内代码里的示例（指南正文）
const guide = [
	'**确认交互（两种）**：',
	'1. **原生审批卡**：pi 要执行危险操作时推卡片到手机。',
	'2. **模型自发的选择题**：我在回复里发 `[[PI_CONFIRM:问题|选项A|选项B]]` 标记 → 手机弹卡片。',
	'',
	'## 4. 会话标记协议',
	'',
	'- `[[PI_SESSION:new]]` → 建议新开会话',
	'- `[[PI_SESSION:<sessionId>]]` → 建议切到已有会话',
].join('\n');
check(findConfirmMarker(guide) === null || findConfirmMarker(guide).question === null, '行内代码里的 PI_CONFIRM 示例不触发', JSON.stringify(findConfirmMarker(guide)));
check(findSessionMarker(guide) === null, '行内代码里的 PI_SESSION 示例不触发', String(findSessionMarker(guide)));
check(!!ignoredMarkerHint(guide, 'PI_CONFIRM'), '被忽略的示例仍会留下日志线索', ignoredMarkerHint(guide, 'PI_CONFIRM') ?? '');

// 2) 围栏代码块里的示例
const fenced = ['说明：', '```', '[[PI_CONFIRM:示例|A|B]]', '```', '以上就是格式。'].join('\n');
check(findConfirmMarker(fenced)?.question == null, '围栏代码块里的示例不触发', JSON.stringify(findConfirmMarker(fenced)));
check(findSessionMarker(fenced) === null, '围栏代码块里的 PI_SESSION 示例不触发');

// 3) 真标记：独占最后一行
const real = '我要发布 UI，先确认范围。\n[[PI_CONFIRM:今晚发布哪些部分？|只发 UI|UI + center|全部]]';
const c = findConfirmMarker(real);
check(c?.question === '今晚发布哪些部分？' && eq(c.options, ['只发 UI', 'UI + center', '全部']), '真确认标记被采纳', JSON.stringify(c));

// 4) 无选项 -> 自由输入
const free = findConfirmMarker('缺信息。\n[[PI_CONFIRM:要部署到哪个环境？]]');
check(free?.question === '要部署到哪个环境？' && eq(free.options, []), '无选项标记 = 自由输入', JSON.stringify(free));

// 5) 多个标记取最后一个；列表前缀 / 前后空白也可
const multi = '[[PI_CONFIRM:第一个|a|b]]\n中间说明\n  - [[PI_CONFIRM:第二个|c]]  ';
const m2 = findConfirmMarker(multi);
check(m2?.question === '第二个' && eq(m2.options, ['c']), '多个标记取最后一个，允许列表前缀', JSON.stringify(m2));

// 6) 混排在一句话里 -> 不触发（要求独占一行）
check(findConfirmMarker('示例写法是 [[PI_CONFIRM:x|y]]，不要用反引号。')?.question == null, '标记混在句子里不触发', JSON.stringify(findConfirmMarker('示例写法是 [[PI_CONFIRM:x|y]]，不要用反引号。')));

// 7) 会话标记：new / id
check(findSessionMarker('这个任务会长期污染本会话。\n[[PI_SESSION:new]]') === 'new', 'PI_SESSION:new 被采纳');
check(findSessionMarker('正文…\n[[PI_SESSION:01a1e07a-efef-71e6-84ae-2a809a49aada]]') === '01a1e07a-efef-71e6-84ae-2a809a49aada', 'PI_SESSION:<id> 原样返回（大小写敏感）');
check(findSessionMarker('正文 [[PI_SESSION:new]] 结尾') === null, 'PI_SESSION 混在句子里不触发');

console.log(`\n${n - bad}/${n} 通过`);
process.exitCode = bad ? 1 : 0;
