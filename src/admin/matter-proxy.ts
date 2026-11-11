// Proxies the matterjs-server dashboard (listening on 127.0.0.1 only) to admin port 2401 under /matter/: HTTP + WebSocket.
// Filters dashboard commands: blocks every DoorLock (257) command / attribute write except lockDoor. Unlocking only via admin with PIN.
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { log } from "../log.ts";

export const DOOR_LOCK = 257;
/** DoorLock commands the dashboard may send: locking is safe. */
const LOCK_ALLOWED = new Set(["lockdoor"]);

interface Upstream {
    host: string;
    port: number;
}

/** "ws://127.0.0.1:5580/ws" -> host, port. */
export function upstreamOf(matterServerUrl: string): Upstream {
    const u = new URL(matterServerUrl);
    return { host: u.hostname, port: Number(u.port || 80) };
}

/** Reason to block a JSON message from the dashboard; undefined = let it through. */
export function blockReason(text: string): string | undefined {
    let msg: { command?: unknown; args?: Record<string, unknown> };
    try {
        msg = JSON.parse(text);
    } catch {
        // Fail closed: matter-server uses its own JSON reader (big integers, also as object keys), which accepts
        // some texts that JSON.parse rejects. The dashboard only sends plain JSON.
        return "message is not plain JSON";
    }
    if (typeof msg !== "object" || msg === null) return undefined;
    const args = msg.args ?? {};
    const cmds: Record<string, unknown>[] = [];
    if (msg.command === "device_command") cmds.push(args);
    if (msg.command === "batched_device_commands" && Array.isArray(args.commands)) cmds.push(...(args.commands as Record<string, unknown>[]));
    for (const c of cmds) {
        if (Number(c.cluster_id) === DOOR_LOCK && !LOCK_ALLOWED.has(String(c.command_name).toLowerCase())) {
            return `DoorLock command ${String(c.command_name)} is blocked on the dashboard, unlock via admin (PIN)`;
        }
    }
    if (msg.command === "write_attribute") {
        // matter-server reads each path segment as a decimal number, so "0257" is cluster 257 too.
        const path = String(args.attribute_path ?? "");
        const cluster = path.split("/")[1];
        if (cluster !== undefined && /^\d+$/.test(cluster.trim()) && Number(cluster) === DOOR_LOCK) return `DoorLock attribute write ${path} is blocked on the dashboard`;
    }
    return undefined;
}

const INJECT = "<script>window.__MATTERJS_PRODUCTION_MODE__=true</script>";

/** HTTP: /matter/<rest> -> upstream /<rest>. The index page gets the production flag injected so the dashboard connects to /matter/ws. */
export function proxyHttp(up: Upstream, rest: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    const headers = { ...req.headers, host: `${up.host}:${up.port}` };
    delete headers.authorization;
    delete headers.cookie;
    delete headers["accept-encoding"];
    const isIndex = rest === "/" || rest === "/index.html";
    const p = http.request({ host: up.host, port: up.port, method: req.method, path: rest, headers }, r => {
        const h = { ...r.headers };
        if (!isIndex || !String(h["content-type"] ?? "").includes("text/html")) {
            res.writeHead(r.statusCode ?? 502, h);
            r.pipe(res);
            return;
        }
        const chunks: Buffer[] = [];
        r.on("data", c => chunks.push(c));
        r.on("end", () => {
            let html = Buffer.concat(chunks).toString("utf8");
            html = html.includes("<script") ? html.replace("<script", `${INJECT}<script`) : html + INJECT;
            delete h["content-length"];
            res.writeHead(r.statusCode ?? 200, h);
            res.end(html);
        });
    });
    p.on("error", e => {
        if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`matter-server not responding: ${e.message}`);
    });
    req.pipe(p);
}

/** WebSocket frame server -> client (unmasked). */
export function wsFrame(opcode: number, payload: Buffer): Buffer {
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    if (n >= 126) {
        head[0] = 0x80 | opcode;
        if (n < 65536) {
            head[1] = 126;
            head.writeUInt16BE(n, 2);
        } else {
            head[1] = 127;
            head.writeBigUInt64BE(BigInt(n), 2);
        }
    }
    return Buffer.concat([head, payload]);
}

interface Frame {
    fin: boolean;
    opcode: number;
    payload: Buffer;
    raw: Buffer;
}

const MAX_MESSAGE = 16 * 1024 * 1024;

/** Splits client -> server frames (masked). Returns complete frames and the remaining bytes. */
export function readFrames(buf: Buffer): { frames: Frame[]; rest: Buffer } {
    const frames: Frame[] = [];
    let off = 0;
    for (;;) {
        if (buf.length - off < 2) break;
        const b0 = buf[off];
        const b1 = buf[off + 1];
        let len = b1 & 0x7f;
        let p = off + 2;
        if (len === 126) {
            if (buf.length - p < 2) break;
            len = buf.readUInt16BE(p);
            p += 2;
        } else if (len === 127) {
            if (buf.length - p < 8) break;
            const big = buf.readBigUInt64BE(p);
            if (big > BigInt(MAX_MESSAGE)) throw new Error("frame too large");
            len = Number(big);
            p += 8;
        }
        const masked = (b1 & 0x80) !== 0;
        const mask = masked ? buf.subarray(p, p + 4) : undefined;
        if (masked) p += 4;
        if (buf.length - p < len) break;
        const payload = Buffer.from(buf.subarray(p, p + len));
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload, raw: buf.subarray(off, p + len) });
        off = p + len;
    }
    return { frames, rest: buf.subarray(off) };
}

/** WebSocket /matter/ws -> upstream /ws. Client frames are checked before forwarding, upstream frames pass through. */
export function proxyUpgrade(up: Upstream, req: http.IncomingMessage, socket: Duplex, head: Buffer, onBlocked: (why: string) => void): void {
    const upstream = net.connect(up.port, up.host);
    const lines = [`GET /ws HTTP/1.1`, `Host: ${up.host}:${up.port}`];
    for (const [k, v] of Object.entries(req.headers)) {
        // Drop extensions: no permessage-deflate, compressed frames could not be inspected.
        if (["host", "authorization", "cookie", "origin", "sec-websocket-extensions"].includes(k) || v === undefined) continue;
        for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
    }
    upstream.on("connect", () => upstream.write(lines.join("\r\n") + "\r\n\r\n"));

    let pending = Buffer.alloc(0);
    let message: Frame[] = [];
    const fromClient = (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        let parsed;
        try {
            parsed = readFrames(pending);
        } catch {
            socket.destroy();
            upstream.destroy();
            return;
        }
        pending = Buffer.from(parsed.rest);
        for (const f of parsed.frames) {
            if (f.opcode >= 0x8) {
                upstream.write(f.raw); // close / ping / pong
                continue;
            }
            message.push(f);
            if (message.reduce((n, x) => n + x.payload.length, 0) > MAX_MESSAGE) {
                socket.destroy();
                upstream.destroy();
                return;
            }
            if (!f.fin) continue;
            const parts = message;
            message = [];
            const op = parts[0].opcode;
            if (op !== 0x1 && op !== 0x2) {
                // continuation without a start, or a reserved opcode: not a message we can inspect
                socket.destroy();
                upstream.destroy();
                return;
            }
            // Binary messages too: matter-server parses every message as JSON text, whatever the opcode.
            const text = Buffer.concat(parts.map(x => x.payload)).toString("utf8");
            const why = blockReason(text);
            if (why) {
                onBlocked(why);
                let id: unknown;
                try {
                    id = JSON.parse(text).message_id;
                } catch {
                    id = undefined;
                }
                socket.write(wsFrame(0x1, Buffer.from(JSON.stringify({ message_id: id, error_code: 403, details: `Blocked by Matter Bridge: ${why}` }))));
                continue;
            }
            for (const x of parts) upstream.write(x.raw);
        }
    };

    upstream.pipe(socket);
    socket.on("data", fromClient);
    if (head.length) fromClient(head);
    const end = () => {
        socket.destroy();
        upstream.destroy();
    };
    socket.on("error", end);
    upstream.on("error", e => {
        log.warn("admin", `proxy matter-server: ${e.message}`);
        end();
    });
    socket.on("close", end);
    upstream.on("close", end);
}
