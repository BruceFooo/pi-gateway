/**
 * 调试探针：连上网关，打印 ready / session_list / session_transcript。
 * 用法：node scripts/probe.mjs [会话关键词]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config/config.json'), 'utf8'));
const ws = new WebSocket(`ws://127.0.0.1:${cfg.port}/pi/ws?token=${encodeURIComponent(cfg.token)}`);

let ready = null;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (obj) => ws.send(JSON.stringify(obj));

ws.addEventListener('message', (ev) => {
	let m;
	try {
		m = JSON.parse(String(ev.data));
	} catch {
		return;
	}
	if (m.type === 'ready') {
		ready = m;
		console.log('ready.bound =', m.boundSessionId);
		console.log('ready.active =', m.activeSessionId);
		console.log('ready.state =', JSON.stringify(m.state));
		console.log('ready.pi =', JSON.stringify(m.pi));
	} else if (m.type === 'response' && m.ok === false) {
		console.log('response FAIL', JSON.stringify(m).slice(0, 300));
	} else if (m.type === 'response' && m.ok === true) {
		if (m.data?.sessions) {
			console.log('session_list count =', m.data.sessions.length);
			for (const s of m.data.sessions.slice(0, 8)) {
				console.log(`  ${s.sessionId} bound=${s.bound ? 'Y' : ' '} active=${s.active ? 'Y' : ' '} ${String(s.title ?? '').slice(0, 40)}  (${s.createdAt})`);
			}
			probeTranscript(m.data.sessions);
		} else if (m.data?.lines) {
			console.log(`session_transcript lines=${m.data.lines.length} title=${JSON.stringify(m.data.title)} truncatedBefore=${m.data.truncatedBefore}`);
			const byKind = {};
			for (const l of m.data.lines) byKind[l.kind] = (byKind[l.kind] ?? 0) + 1;
			console.log('  kinds =', JSON.stringify(byKind));
			for (const l of m.data.lines.slice(0, 12)) {
				console.log(`  ${l.kind} [${l.entryId}] ${JSON.stringify(String(l.text ?? '').slice(0, 80))} ${l.toolName ? 'tool=' + l.toolName : ''} ${l.ok === undefined ? '' : 'ok=' + l.ok}`);
			}
		} else {
			console.log('response ok', JSON.stringify(m).slice(0, 240));
		}
	} else if (m.type === 'event') {
		console.log('event', m.event, JSON.stringify(m).slice(0, 180));
	}
});

async function probeTranscript(sessions) {
	const key = process.argv[2];
	const hit = (key ? sessions.find((s) => String(s.title ?? '').includes(key) || s.sessionId.includes(key)) : sessions.find((s) => s.active)) ?? sessions[0];
	if (!hit) return console.log('no session to probe');
	console.log('probing', hit.sessionId, JSON.stringify(hit.title));
	send({ type: 'session_transcript', sessionId: hit.sessionId });
}

ws.addEventListener('open', () => setTimeout(() => send({ type: 'session_list' }), 400));
ws.addEventListener('error', (e) => console.log('ws error', e.message ?? e.error?.message ?? 'unknown'));
setTimeout(() => {
	ws.close();
	process.exit(0);
}, 8000);
