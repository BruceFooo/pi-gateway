// transcript 分页的纯单元测试：不连活网关，自己造一份 JSONL 会话文件。
// 锁四件事：① 逐页往前翻能拿到全部内容；② 页与页不重叠（一个 entry.id 只出现在一页里）；
// ③ cursor 严格递减、翻到头 hasMore=false；④ 单条比窗口还长时不会死循环。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../src/session.mjs";

let fails = 0;
const ok = (cond, label, extra = "") => {
    console.log(`${cond ? "  ok " : "  FAIL"} ${label}${extra ? " :: " + extra : ""}`);
    if (!cond) fails++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-paging-"));
const dir = path.join(tmp, "--cwd--");
fs.mkdirSync(dir, { recursive: true });

const pad = (i, n) => `第${i}条 ` + "x".repeat(n);
const entry = (i, parts) => JSON.stringify({
    type: "message",
    id: `e${String(i).padStart(3, "0")}`,
    timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
    message: { role: "assistant", content: parts },
});

// 会话 A：40 条，其中一条带多个 part（用来验证「一个条目的多行不会被页边界拆散」）
function writeSession(name, lines) {
    const file = path.join(dir, name);
    const header = JSON.stringify({ type: "session", id: name.replace(/\.jsonl$/, "").split("_").pop(), cwd: "x", timestamp: "2026-01-01T00:00:00.000Z" });
    fs.writeFileSync(file, [header, ...lines].join("\n") + "\n", "utf8");
    return file;
}

const linesA = [];
for (let i = 1; i <= 40; i++) {
    if (i === 20) linesA.push(entry(i, [{ type: "text", text: pad(i, 60) }, { type: "text", text: pad(i, 60) }, { type: "text", text: pad(i, 60) }]));
    else linesA.push(entry(i, [{ type: "text", text: pad(i, 120) }]));
}
const fileA = writeSession("2026-01-01T00-00-00-000Z_aaaa0000-0000-0000-0000-00000000000a.jsonl", linesA);

const store = new SessionStore({ dir: tmp, log: (m) => console.log("   log:", m) });
const sid = path.basename(fileA, ".jsonl").split("_").pop();

// 基准：一次读全量
const whole = store.transcript(sid, { maxBytes: Number.MAX_SAFE_INTEGER });
ok(whole.hasMore === false && whole.cursor === null, "全量读：hasMore=false、cursor=null", `hasMore=${whole.hasMore} cursor=${whole.cursor}`);
ok(whole.lines.length === 42, "全量读：42 行（40 条 + 第 20 条多出的 2 行）", `lines=${whole.lines.length}`);

// 分页：窗口 1200 字节，从最新往最前翻
const MAX_PAGES = 50;
const pages = [];
let before;
let guard = 0;
while (guard++ < MAX_PAGES) {
    const p = store.transcript(sid, { maxBytes: 1200, before });
    pages.push(p);
    if (!p.hasMore) break;
    if (p.cursor == null) { console.log("  FAIL hasMore=true 但 cursor 为空"); fails++; break; }
    if (before !== undefined && p.cursor >= before) { console.log(`  FAIL cursor 没往前推：${p.cursor} >= ${before}`); fails++; break; }
    before = p.cursor;
}
console.log(`  页数=${pages.length} 每页行数=${pages.map((p) => p.lines.length).join(",")}`);
ok(pages.length > 3, "被切成多页", `pages=${pages.length}`);
ok(pages.length < MAX_PAGES, "没有死循环", `pages=${pages.length}`);
ok(pages[pages.length - 1].hasMore === false, "末页 hasMore=false");
ok(pages[pages.length - 1].cursor === null, "末页 cursor=null");
ok(pages[0].truncatedBefore > 0, "首页 truncatedBefore>0（还有更早的）", `truncatedBefore=${pages[0].truncatedBefore}`);
ok(pages[0].lines.length > 0 && pages[0].lines.length <= 42, "首页非空且不超全量", `lines=${pages[0].lines.length}`);

// 拼回去应当等于全量（时间正序 = 末页→首页）
const joined = [...pages].reverse().flatMap((p) => p.lines);
const sig = (ls) => ls.map((l) => `${l.entryId}|${l.kind}|${l.text}`).join("\n");
ok(sig(joined) === sig(whole.lines), "逐页拼接 == 一次全量读（顺序与内容都一致）", `joined=${joined.length} whole=${whole.lines.length}`);

// 一个 entryId 只能出现在一页里
const pageOfEntry = new Map();
let split = 0;
for (const [idx, p] of pages.entries()) {
    for (const l of p.lines) {
        if (!l.entryId) continue;
        if (pageOfEntry.has(l.entryId) && pageOfEntry.get(l.entryId) !== idx) split++;
        else pageOfEntry.set(l.entryId, idx);
    }
}
ok(split === 0, "没有条目被页边界拆散", `跨页条目=${split}`);

// 旧行为：不再往 lines 里塞「（更早的 N 条未显示）」这种合成行
ok(!whole.lines.some((l) => l.kind === "notice" && String(l.text).includes("未显示")), "不再插入合成 notice 行");

// 会话 B：单条比窗口还长（~6KB），窗口只有 800 字节：必须能翻到头而不是空转，而且这条不能丢（窗口会自动翻倍）
const fat = JSON.stringify({ type: "message", id: "fat", timestamp: "2026-01-01T00:01:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "肥".repeat(2000) }] } });
const fileB = writeSession("2026-01-01T00-00-00-001Z_bbbb0000-0000-0000-0000-00000000000b.jsonl", [fat, entry(1, [{ type: "text", text: pad(1, 100) }]), entry(2, [{ type: "text", text: pad(2, 100) }])]);
const sidB = path.basename(fileB, ".jsonl").split("_").pop();
// list() 缓存 5 秒，上一段已经读过一次 ⇒ 新建一个 store，不拿本测试当缓存测试
const storeB = new SessionStore({ dir: tmp, log: (m) => console.log("   log:", m) });
ok(storeB.list().some((s) => s.sessionId === sidB), "B：会话被发现", `sid=${sidB}`);
const pagesB = [];
let beforeB;
let guardB = 0;
while (guardB++ < MAX_PAGES) {
    const p = storeB.transcript(sidB, { maxBytes: 800, before: beforeB });
    pagesB.push(p);
    if (!p.hasMore) break;
    if (beforeB !== undefined && p.cursor >= beforeB) { console.log(`  FAIL B: cursor 没前进 ${p.cursor} >= ${beforeB}`); fails++; break; }
    beforeB = p.cursor;
}
console.log(`  B 页数=${pagesB.length} 行数=${pagesB.map((p) => p.lines.length).join(",")}`);
ok(pagesB[pagesB.length - 1].hasMore === false, "B：超长条目下仍能翻到头");
ok(pagesB.length < MAX_PAGES, "B：没有死循环", `pages=${pagesB.length}`);
const allB = pagesB.flatMap((p) => p.lines);
ok(allB.some((l) => l.entryId === "fat"), "B：超长条目也被渲染出来了（窗口会向前翻倍）", `lines=${allB.map((l) => l.entryId).join(",")}`);
ok(allB.filter((l) => l.entryId === "fat").length === 1, "B：超长条目只出现一次");
ok(["fat", "e001", "e002"].every((id) => allB.some((l) => l.entryId === id)), "B：三条全部到位");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `VERIFY FAIL (${fails})` : "VERIFY OK");
process.exit(fails ? 1 : 0);
