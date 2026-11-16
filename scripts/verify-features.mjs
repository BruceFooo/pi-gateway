// 本地功能验证（不打生产服务器）：① 图片往返（含 /pi/media 取回）② 定时 once 任务与自删
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const cfg = JSON.parse(readFileSync(new URL("../config/config.json", import.meta.url), "utf8"));
const ws = new WebSocket(`ws://127.0.0.1:${cfg.port}/pi/ws?token=${encodeURIComponent(cfg.token)}`);
let seq = 0, ready = null, active = null;
const pending = new Map();
const events = [];

ws.addEventListener("message", (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.type === "response") { const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } return; }
    if (m.type === "ready") { ready = m; active = m.activeSession?.id ?? null; return; }
    events.push(m);
});
const req = (type, extra = {}, ms = 30000) => new Promise((res, rej) => {
    const id = `c${++seq}`;
    pending.set(id, res);
    setTimeout(() => { if (pending.delete(id)) rej(new Error(`${type} 超时`)); }, ms).unref?.();
    ws.send(JSON.stringify({ ...extra, type, id }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (name, cond, detail) => {
    console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
    if (!cond) fails.push(name);
};

// 等 agent_settled（run 结束），顺带把事件打出来
async function waitSettled(label, timeoutMs = 420000) {
    const from = events.length;
    const t0 = Date.now();
    let sawStart = false;
    while (Date.now() - t0 < timeoutMs) {
        for (let i = from; i < events.length; i++) {
            const e = events[i];
            const et = e.event ?? e.type; // 网关把事件包成 {type:'event', event:'...'}
            if (et === "agent_start") sawStart = true;
            if (et === "tool_start") console.log(`   [${label}] tool ${e.toolName}`);
            if (et === "approval_requested") console.log(`   [${label}] approval ${e.kind} ${e.title ?? ''}`);
            if (et === "notice" && e.level !== "info") console.log(`   [${label}] notice ${e.level}: ${e.text}`);
            if (et === "agent_settled") return { sawStart, ms: Date.now() - t0 };
        }
        await sleep(500);
    }
    return { sawStart, timeout: true, ms: Date.now() - t0 };
}

async function lastAssistant() {
    const tr = await req("session_transcript", { sessionId: active }, 20000);
    const lines = tr.data?.lines ?? [];
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].kind === "assistant") return lines[i].text;
    return null;
}

// 16x16 PNG：左 8 列纯红，右 8 列纯蓝
function crc32(buf) {
    let c, table = crc32.table ?? (crc32.table = (() => {
        const t = [];
        for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
        return t;
    })());
    c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const t = Buffer.from(type, "ascii");
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
}
function makePng() {
    const w = 16, h = 16, raw = [];
    for (let y = 0; y < h; y++) {
        const line = Buffer.alloc(1 + w * 3);
        for (let x = 0; x < w; x++) {
            const o = 1 + x * 3;
            if (x < 8) { line[o] = 255; line[o + 1] = 0; line[o + 2] = 0; }
            else { line[o] = 0; line[o + 1] = 0; line[o + 2] = 255; }
        }
        raw.push(line);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", deflateSync(Buffer.concat(raw))),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

ws.addEventListener("open", async () => {
    try {
        for (let i = 0; i < 20 && !ready; i++) await sleep(100);
        if (!ready) throw new Error("没有 ready");
        active = ready.activeSession?.id ?? ready.boundSessionId;
        console.log(`active=${active}`);

        // 0) 模型与视觉能力
        const ml = await req("model_list");
        const cur = ml.data?.current;
        const vision = (ml.data?.models ?? []).filter((m) => Array.isArray(m.input) ? m.input.includes("image") : m.supportsImages);
        console.log(`current=${cur?.provider}/${cur?.id} reasoning=${cur?.reasoning} context=${cur?.contextWindow}`);
        console.log(`支持图片的模型 ${vision.length} 个：${vision.slice(0, 6).map((m) => `${m.provider}/${m.id}`).join(", ")}`);
        check("当前模型声明支持图片输入", (cur?.input ?? []).includes("image"), JSON.stringify(cur?.input ?? null));

        // 1) 图片往返
        const png = makePng();
        const b64 = png.toString("base64");
        events.length = 0;
        const sent = await req("chat_send", {
            text: "这是一张纯色测试图。只回答颜色词：图片左半边是什么颜色？不要执行任何工具，不要读任何文件。",
            images: [{ mimeType: "image/png", data: b64, name: "test-16x16.png" }],
        });
        check("chat_send 带图片被接受", sent.ok === true, JSON.stringify(sent.data ?? sent.error));
        const um = events.find((e) => (e.event ?? e.type) === "user_message");
        const att = um?.attachments?.[0];
        check("user_message 带回附件 url", !!att?.url, JSON.stringify(att));
        if (att?.url) {
            const u = new URL(att.url, `http://127.0.0.1:${cfg.port}`);
            if (!u.searchParams.get("token")) u.searchParams.set("token", cfg.token);
            const r = await fetch(u);
            const buf = Buffer.from(await r.arrayBuffer());
            check("GET /pi/media 取回同一张图", r.status === 200 && buf.equals(png), `status=${r.status} bytes=${buf.length}/${png.length}`);
        }
        const s1 = await waitSettled("image");
        check("图片这一轮跑完", !s1.timeout && s1.sawStart, `ms=${s1.ms}`);
        const ans = await lastAssistant();
        console.log(`  模型回答：${String(ans).slice(0, 120)}`);
        check("模型看得出左边是红色", /红/.test(String(ans)), String(ans).slice(0, 80));

        // 2) 定时 once（30s 后），跑完应自删
        const at = Date.now() + 30_000;
        const ca = await req("cron_add", { prompt: "只回复四个字：定时完成。不要执行任何工具，不要读文件。", title: "本地once验证", at });
        check("cron_add(once/epoch) 被接受", ca.ok === true, JSON.stringify(ca.data ?? ca.error));
        const before = await req("cron_list");
        check("cron_list 里有这一条", (before.data?.crons ?? []).some((c) => c.title === "本地once验证"), `count=${(before.data?.crons ?? []).length}`);
        events.length = 0;
        const s2 = await waitSettled("cron");
        check("定时任务到点自动跑完", !s2.timeout && s2.sawStart, `ms=${s2.ms}`);
        const ans2 = await lastAssistant();
        console.log(`  定时这一轮回答：${String(ans2).slice(0, 80)}`);
        const after = await req("cron_list");
        check("once 跑完自动删除", !(after.data?.crons ?? []).some((c) => c.title === "本地once验证"), `count=${(after.data?.crons ?? []).length}`);

        // 3) 时间格式与删除：带秒的本地 ISO 要能解析出 nextAt；patch.remove 要能删掉
        const p2 = (n) => String(n).padStart(2, "0");
        const wantMs = Date.now() + 10 * 60_000;
        const d = new Date(wantMs);
        const isoLocal = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
        const ci = await req("cron_add", { prompt: "验证用，不应该真的跑到", title: "ISO格式验证", at: isoLocal });
        check("cron_add(at=本地 ISO 带秒) 被接受", ci.ok === true, JSON.stringify(ci.data ?? ci.error));
        const li = await req("cron_list");
        const row = (li.data?.crons ?? []).find((c) => c.title === "ISO格式验证");
        check("nextAt 解析正确（约 +10 分钟）", !!row && Math.abs(Date.parse(row.nextAt) - wantMs) < 90_000, `nextAt=${row?.nextAt} want=${new Date(wantMs).toISOString()}`);
        const rm = await req("cron_update", { cronId: row?.id, patch: { remove: true } });
        const li2 = await req("cron_list");
        check("cron_update(patch.remove) 能删除", rm.ok === true && !(li2.data?.crons ?? []).some((c) => c.title === "ISO格式验证"), JSON.stringify(rm.data ?? rm.error));

        console.log(fails.length ? `\nFEATURE FAILED: ${fails.join(" | ")}` : "\nFEATURE OK");
        process.exit(fails.length ? 1 : 0);
    } catch (e) {
        console.log("!! 异常:", e?.message);
        process.exit(2);
    }
});
ws.addEventListener("error", (e) => console.log("!! ws error", e?.message ?? e));
