// 会话相关的端到端验证：列表标题 → 绑定会话标题 → 改名（幂等）→ 新会话 → 切回入口 → 队列串行。
import { readFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync(new URL("../config/config.json", import.meta.url), "utf8"));
const ws = new WebSocket(`ws://127.0.0.1:${cfg.port}/pi/ws?token=${encodeURIComponent(cfg.token)}`);
let seq = 0;
const pending = new Map();
const events = [];
const waiters = [];

ws.addEventListener("message", (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.type === "resync_required") { console.log("!! resync_required"); return; }
    if (m.type === "response") {
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); m.ok ? p.resolve(m) : p.reject(new Error(`${m.error} / ${m.code}`)); }
        return;
    }
    if (m.type === "ready") {
        console.log(`ready bound=${m.boundSessionId} active=${m.activeSessionId} lastSeq=${m.lastSeq}`);
        return;
    }
    if (m.type === "event") {
        events.push(m.event);
        for (const w of waiters.splice(0)) w();
    }
});

const req = (type, extra = {}, ms = 30000) => new Promise((res, rej) => {
    const id = `v${++seq}`;
    pending.set(id, { resolve: res, reject: rej });
    const t = setTimeout(() => { pending.delete(id); rej(new Error(`${type} 超时`)); }, ms);
    pending.set(id, { resolve: (m) => { clearTimeout(t); res(m); }, reject: (e) => { clearTimeout(t); rej(e); } });
    ws.send(JSON.stringify({ ...extra, type, id }));
});

const waitFor = (pred, ms, label) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
        if (pred()) { clearInterval(iv); res(true); return; }
        if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`等不到 ${label}`)); }
    }, 200);
});

ws.addEventListener("open", async () => {
    try {
        // 1) 会话列表标题
        const list = await req("session_list");
        const sessions = list.data.sessions ?? [];
        console.log(`session_list count=${sessions.length}`);
        for (const s of sessions.slice(0, 4)) {
            console.log(`  ${(s.title ?? "(null)").slice(0, 40)} bound=${!!s.bound} active=${!!s.active} id=${(s.sessionId ?? "").slice(0, 8)}`);
        }
        const titled = sessions.filter((s) => s.title && s.title !== "(无标题)").length;
        if (!titled) throw new Error("没有任何会话拿到标题");

        // 2) 绑定会话的 transcript 标题 + 时间线
        const bound = list.data.boundSessionId ?? sessions.find((s) => s.bound)?.sessionId;
        const tr = await req("session_transcript", { sessionId: bound });
        const kinds = {};
        for (const l of tr.data.lines ?? []) kinds[l.kind] = (kinds[l.kind] ?? 0) + 1;
        console.log(`transcript title=${tr.data.title} lines=${(tr.data.lines ?? []).length} kinds=${JSON.stringify(kinds)}`);

        // 3) 幂等改名（走 set_session_name + 文件头重写）
        const rn = await req("session_rename", { sessionId: bound, name: "手机控制台" });
        console.log(`rename ok=${rn.ok} name=${rn.data?.name}`);
        const list2 = await req("session_list");
        const again = (list2.data.sessions ?? []).find((s) => s.sessionId === bound);
        console.log(`rename 后标题=${again?.title}`);

        // 4) 跑一轮 + 等完成（验证事件与 #followActiveSession）
        const before = (await req("queue_list")).data.running ?? null;
        await req("chat_send", { text: "只回复四个字：会话验证" });
        await waitFor(() => events.includes("agent_settled"), 60000, "agent_settled");
        const st = await req("queue_list");
        console.log(`跑完 running=${st.data.running?.id ?? "null"} pending=${(st.data.items ?? []).length} before=${before?.id ?? "null"}`);
        const tr2 = await req("session_transcript", { sessionId: bound });
        console.log(`跑完 transcript title=${tr2.data.title} lines=${(tr2.data.lines ?? []).length}`);

        // 5) 新会话 + 切回入口
        const nw = await req("session_new", {});
        console.log(`session_new active=${nw.data?.session?.id ?? "?"} bound=${nw.data?.bound}`);
        const back = await req("session_switch", { sessionId: null });
        console.log(`切回入口 active=${back.data?.session?.id ?? "?"} title=${back.data?.session?.title}`);

        console.log("VERIFY OK");
        ws.close(1000, "bye");
    } catch (e) {
        console.log(`VERIFY FAIL ${e?.message ?? e}`);
        ws.close(1000, "fail");
    }
});

ws.addEventListener("error", (e) => console.log("ws error", e?.message ?? e));
ws.addEventListener("close", (ev) => {
    console.log(`closed code=${ev.code} reason=${ev.reason}`);
    process.exit(0);
});
