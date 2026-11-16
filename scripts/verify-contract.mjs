// 只验会话契约（不打模型，秒级）：ready 的 bound 必须是真 sessionId；
// session_new / session_switch / session_rename 都要回 { session: {id,title,path,bound} }。
import { readFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync(new URL("../config/config.json", import.meta.url), "utf8"));
const ws = new WebSocket(`ws://127.0.0.1:${cfg.port}/pi/ws?token=${encodeURIComponent(cfg.token)}`);
let seq = 0;
let ready = null;
const pending = new Map();

ws.addEventListener("message", (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.type === "response") {
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); p(m); }
        return;
    }
    if (m.type === "ready") { ready = m; return; }
});

const req = (type, extra = {}, ms = 20000) => new Promise((res, rej) => {
    const id = `c${++seq}`;
    pending.set(id, res);
    setTimeout(() => { if (pending.delete(id)) rej(new Error(`${type} 超时`)); }, ms).unref?.();
    ws.send(JSON.stringify({ ...extra, type, id }));
});

const isUuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const fails = [];
const check = (name, cond, detail) => {
    console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
    if (!cond) fails.push(name);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ws.addEventListener("open", async () => {
    try {
        for (let i = 0; i < 20 && !ready; i++) await sleep(100);
        check("ready.boundSessionId 是 sessionId（不是文件名）", isUuid(ready?.boundSessionId), String(ready?.boundSessionId));
        const bound = ready.boundSessionId;

        const list = await req("session_list");
        const ent = list.data.sessions.find((s) => s.sessionId === bound);
        check("session_list 里能按 sessionId 找到入口会话", !!ent, ent ? `${ent.title} active=${ent.active} bound=${ent.bound}` : `count=${list.data.sessions.length}`);

        const tr = await req("session_transcript", { sessionId: bound });
        check("session_transcript 按真 sessionId 可读", !!tr.ok && Array.isArray(tr.data.lines) && tr.data.lines.length > 0, `lines=${tr.data?.lines?.length}`);
        check("session_transcript 回 session.title", !!tr.data?.session?.title, JSON.stringify(tr.data?.session?.title));

        const nw = await req("session_new");
        check("session_new 回 session.id", !!nw.data?.session?.id, JSON.stringify(nw.data?.session));
        check("session_new 后 active == 新会话", nw.data?.active === nw.data?.session?.id, `${nw.data?.active}`);

        const sw = await req("session_switch", { sessionId: bound });
        check("session_switch 回 session.id", sw.data?.session?.id === bound, JSON.stringify(sw.data?.session));
        check("session_switch 后 bound=true", sw.data?.session?.bound === true, String(sw.data?.session?.bound));

        const rn = await req("session_rename", { sessionId: bound, name: "手机控制台" });
        check("session_rename 回 session.title", rn.ok && rn.data?.session?.title === "手机控制台", JSON.stringify(rn.data?.session ?? rn.error));

        const q = await req("queue_list");
        check("切会话没污染队列", q.ok && (q.data.running === null || q.data.running === undefined), JSON.stringify(q.data?.running));

        console.log(fails.length ? `\nVERIFY CONTRACT FAILED: ${fails.join(", ")}` : "\nVERIFY CONTRACT OK");
        process.exit(fails.length ? 1 : 0);
    } catch (e) {
        console.log("!! 异常:", e?.message);
        process.exit(2);
    }
});

ws.addEventListener("error", (e) => { console.log("!! ws error", e?.message ?? e); });
