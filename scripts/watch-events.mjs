// 事件可见性探针：连上 → 发一句极简指令 → 打印收到的每一个事件类型（含时间差）
import { readFileSync } from "node:fs";
const cfg = JSON.parse(readFileSync(new URL("../config/config.json", import.meta.url), "utf8"));
const ws = new WebSocket(`ws://127.0.0.1:${cfg.port}/pi/ws?token=${encodeURIComponent(cfg.token)}`);
const t0 = Date.now();
const seen = new Map();
let id = 0;
const pend = new Map();
const out = [];

ws.addEventListener("message", (ev) => {
    const m = JSON.parse(String(ev.data));
    const t = `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
    if (m.type === "response") {
        const p = pend.get(m.id); if (p) { pend.delete(m.id); p(m); }
        console.log(`${t} RESP ${m.id} ok=${m.ok} ${JSON.stringify(m.data ?? m.error).slice(0, 160)}`);
        return;
    }
    if (m.type === "ready") { console.log(`${t} READY bound=${m.boundSessionId} active=${m.activeSession?.id}`); return; }
    seen.set(m.event ?? m.type, (seen.get(m.event ?? m.type) ?? 0) + 1);
    let extra = "";
    if ((m.event ?? m.type) === "user_message") extra = JSON.stringify(m.attachments);
    if ((m.event ?? m.type) === "assistant_text") extra = JSON.stringify(String(m.text).slice(0, 40));
    if ((m.event ?? m.type) === "state") extra = `runState=${m.state?.runState} streaming=${m.state?.isStreaming}`;
    if ((m.event ?? m.type) === "queue_update") extra = `running=${m.running?.id ?? null} items=${m.items?.length}`;
    out.push(`${t} EVT ${m.event ?? m.type} ${extra}`.trim());
});

const req = (type, extra = {}, ms = 30000) => new Promise((res, rej) => {
    const rid = `w${++id}`;
    pend.set(rid, res);
    setTimeout(() => { if (pend.delete(rid)) rej(new Error(`${type} 超时`)); }, ms).unref?.();
    ws.send(JSON.stringify({ ...extra, type, id: rid }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ws.addEventListener("open", async () => {
    await sleep(1200);
    console.log("→ 发送 chat_send");
    const r = await req("chat_send", { text: "只回复两个字：好。不要调用任何工具，不要读任何文件。" });
    console.log(`queued=${r?.data?.queued} id=${r?.data?.id}`);
    const start = Date.now();
    while (Date.now() - start < 240000) {
        if (seen.get("agent_settled")) break;
        await sleep(1000);
    }
    console.log(out.join("\n"));
    console.log("计数：" + JSON.stringify([...seen.entries()]));
    process.exit(seen.get("agent_settled") ? 0 : 1);
});
ws.addEventListener("error", (e) => console.log("!! ws error", e?.message ?? e));
