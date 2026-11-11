// Admin HTTP server (port 2401): JSON API + static UI (admin-ui/dist). Basic auth required.
import http from "node:http";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { timingSafeEqual, createHash, randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import { parseConfig, type AdminConfig, type BridgeConfig } from "../config.ts";
import type { MatterPort } from "../matter.ts";
import { log } from "../log.ts";
import { buildPlan, snapshot, type Plan } from "./plan.ts";
import { loadProject, saveProject, validateProject, type GaOverride, type Project } from "./project.ts";
import { buildEtsCsv, buildEtsXml, parseEtsExport } from "./ets.ts";
import { builtinPlanner } from "./planner/builtin.ts";
import { normalizeGa, type GaPlanner, type ReservedGa } from "./planner/types.ts";
import { describeNode } from "./suggest.ts";
import { DOOR_LOCK, proxyHttp, proxyUpgrade, upstreamOf } from "./matter-proxy.ts";
import { hashPin, LOCKOUT_MS, PIN_RE, UnlockGuard } from "./unlock.ts";
import { lockChannels } from "../mapping.ts";

export interface AdminDeps {
    configPath: string;
    getConfig: () => BridgeConfig;
    /** Loads a new config into the running bridge + KNX layer. */
    applyConfig: (cfg: BridgeConfig) => void;
    matter: MatterPort;
    status: () => Record<string, unknown>;
    uiDir: string;
    /** GA planner (admin.planner_module, see planner/load.ts). Default: built-in planner. */
    planner?: GaPlanner;
}

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
    ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

/** API error: stable code for the UI to translate (VI/EN), English message for logs and API clients. */
class HttpError extends Error {
    status: number;
    code: string;
    body: unknown;
    constructor(status: number, code: string, message: string, body?: unknown) {
        super(message);
        this.status = status;
        this.code = code;
        this.body = body;
    }
}

const SESSION_COOKIE = "mb_session";
const SESSION_MS = 12 * 3600 * 1000;
/** Matter commands to a lock need a timed request (DoorLock spec). */
const LOCK_TIMED_MS = 10000;

function sha(s: string): Buffer {
    return createHash("sha256").update(s).digest();
}

export class AdminServer {
    #cfg: AdminConfig;
    #deps: AdminDeps;
    #server: http.Server;
    #projectPath: string;
    #guard: UnlockGuard;
    /** Session cookie token -> expiry (ms). The proxied WebSocket uses the cookie since browsers may not send Basic auth. */
    #sessions = new Map<string, number>();
    /** Upgraded WebSocket sockets (dashboard): closeAllConnections does not close them, close() does. */
    #upgraded = new Set<Duplex>();

    constructor(cfg: AdminConfig, deps: AdminDeps) {
        this.#cfg = cfg;
        this.#deps = deps;
        this.#projectPath = resolve(cfg.project_path);
        this.#guard = new UnlockGuard(resolve(cfg.audit_path));
        this.#server = http.createServer((req, res) => void this.#handle(req, res));
        this.#server.on("upgrade", (req, socket, head) => this.#upgrade(req, socket, head));
    }

    get guard(): UnlockGuard {
        return this.#guard;
    }

    listen(): Promise<void> {
        return new Promise((ok, fail) => {
            this.#server.once("error", fail);
            this.#server.listen(this.#cfg.port, this.#cfg.host, () => {
                log.info("admin", `http://${this.#cfg.host}:${this.#cfg.port} (project ${this.#projectPath})`);
                ok();
            });
        });
    }

    get port(): number {
        const a = this.#server.address();
        return typeof a === "object" && a ? a.port : this.#cfg.port;
    }

    close(): Promise<void> {
        return new Promise(r => {
            this.#server.close(() => r());
            this.#server.closeAllConnections(); // browser keep-alive must not keep the process alive
            for (const s of this.#upgraded) s.destroy();
        });
    }

    #basicOk(req: http.IncomingMessage): boolean {
        const h = req.headers.authorization ?? "";
        if (!h.startsWith("Basic ")) return false;
        const [user, ...rest] = Buffer.from(h.slice(6), "base64").toString("utf8").split(":");
        return user === "admin" && timingSafeEqual(sha(rest.join(":")), sha(this.#cfg.password));
    }

    #sessionOk(req: http.IncomingMessage): boolean {
        const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([0-9a-f]{64})`).exec(req.headers.cookie ?? "");
        if (!m) return false;
        const exp = this.#sessions.get(m[1]);
        if (!exp || exp < Date.now()) {
            this.#sessions.delete(m[1]);
            return false;
        }
        return true;
    }

    /** Valid Basic auth issues a session cookie (HttpOnly, SameSite=Strict). */
    #authorized(req: http.IncomingMessage, res?: http.ServerResponse): boolean {
        if (this.#sessionOk(req)) return true;
        if (!this.#basicOk(req)) return false;
        if (res) {
            const now = Date.now();
            for (const [k, exp] of this.#sessions) if (exp < now) this.#sessions.delete(k);
            const token = randomBytes(32).toString("hex");
            this.#sessions.set(token, now + SESSION_MS);
            res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
        }
        return true;
    }

    /**
     * CSRF / cross-site WebSocket guard: browsers send cached Basic credentials with cross-site requests, and a
     * text/plain form can carry a JSON body. A browser request whose Origin is not this host is refused.
     */
    #crossOrigin(req: http.IncomingMessage): boolean {
        const origin = req.headers.origin;
        if (origin === undefined) return false; // not a browser cross-site request (curl, tests, same-origin GET)
        try {
            return new URL(origin).host !== req.headers.host;
        } catch {
            return true; // "null" and other opaque origins
        }
    }

    #ip(req: http.IncomingMessage): string {
        return (req.socket.remoteAddress ?? "?").replace(/^::ffff:/, "");
    }

    #upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
        const path = new URL(req.url ?? "/", "http://admin").pathname;
        if (this.#crossOrigin(req)) {
            socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
            return;
        }
        if (path !== "/matter/ws" || !this.#authorized(req)) {
            socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
            return;
        }
        const ip = this.#ip(req);
        this.#upgraded.add(socket);
        socket.on("close", () => this.#upgraded.delete(socket));
        proxyUpgrade(upstreamOf(this.#deps.getConfig().matter_server), req, socket, head, why => {
            log.warn("admin", `dashboard ${ip}: ${why}`);
            this.#guard.record({ source: "dashboard", ip, result: "blocked_dashboard", detail: why });
        });
    }

    async #handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Cache-Control", "no-store");
        const method = req.method ?? "GET";
        if (method !== "GET" && method !== "HEAD" && this.#crossOrigin(req)) {
            res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("Cross-origin request refused");
            return;
        }
        if (!this.#authorized(req, res)) {
            res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Matter Bridge Admin", charset="UTF-8"' });
            res.end("Authentication required");
            return;
        }
        const url = new URL(req.url ?? "/", "http://admin");
        try {
            if (url.pathname === "/matter") {
                res.writeHead(302, { Location: "/matter/" });
                res.end();
                return;
            }
            if (url.pathname.startsWith("/matter/")) {
                proxyHttp(upstreamOf(this.#deps.getConfig().matter_server), url.pathname.slice(7) + url.search, req, res);
                return;
            }
            if (url.pathname.startsWith("/api/")) {
                const out = await this.#api(req.method ?? "GET", url.pathname, req);
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify(out));
                return;
            }
            this.#static(url.pathname, res);
        } catch (e) {
            const err = e instanceof HttpError ? e : new HttpError(500, "internal", (e as Error).message);
            if (err.status >= 500) log.error("admin", `${req.method} ${url.pathname}: ${err.message}`);
            res.writeHead(err.status, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: err.message, code: err.code, ...(err.body ? { detail: err.body } : {}) }));
        }
    }

    #static(pathname: string, res: http.ServerResponse): void {
        const root = resolve(this.#deps.uiDir);
        if (!existsSync(join(root, "index.html"))) {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end("<!doctype html><meta charset=utf-8><title>Matter Bridge Admin</title><p>UI not built (npm run build:admin). API: /api/status, /api/nodes, /api/project, /api/plan.</p>");
            return;
        }
        let file = normalize(join(root, decodeURIComponent(pathname)));
        if (!file.startsWith(root + sep) && file !== root) throw new HttpError(400, "bad_path", "invalid path");
        if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html"); // SPA
        res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
        createReadStream(file).pipe(res);
    }

    async #body(req: http.IncomingMessage, limit = 2_000_000): Promise<Record<string, unknown>> {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) {
            size += (c as Buffer).length;
            if (size > limit) throw new HttpError(413, "body_too_large", "body too large");
            chunks.push(c as Buffer);
        }
        if (!size) return {};
        try {
            return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        } catch {
            throw new HttpError(400, "bad_json", "invalid JSON");
        }
    }

    #project(): Project {
        return loadProject(this.#projectPath);
    }

    #plan(project: Project): Plan {
        const errors = validateProject(project);
        if (errors.length) throw new HttpError(422, "project_invalid", "project is invalid", { errors });
        return buildPlan(project, this.#deps.getConfig(), this.#deps.planner ?? builtinPlanner);
    }

    #planSummary(p: Plan) {
        return {
            scheme: p.result.scheme,
            stats: p.result.stats,
            issues: p.result.issues,
            gas: p.result.gas,
            objects: p.objects,
            slots: p.slots,
            served: p.served,
            warnings: p.warnings,
            addressChanges: p.addressChanges,
        };
    }

    async #api(method: string, path: string, req: http.IncomingMessage): Promise<unknown> {
        const { matter } = this.#deps;
        if (method === "GET" && path === "/api/status") {
            const project = this.#project();
            return { ...this.#deps.status(), project: { name: project.name, rev: project.rev, frozen: Boolean(project.exported), applied: project.applied?.at ?? null } };
        }
        if (method === "GET" && path === "/api/nodes") return matter.listNodes().map(describeNode).sort((a, b) => a.nodeId - b.nodeId);

        const ident = /^\/api\/nodes\/(\d+)\/identify$/.exec(path);
        if (method === "POST" && ident) {
            const b = await this.#body(req);
            const ep = Number(b.endpoint ?? 1);
            await matter.command(Number(ident[1]), ep, 3, "identify", { identifyTime: 10 });
            return { ok: true };
        }

        if (method === "GET" && path === "/api/project") return this.#project();
        if (method === "PUT" && path === "/api/project") {
            const b = (await this.#body(req)) as unknown as Project;
            const cur = this.#project();
            // Applied / exported snapshots are written by the bridge only, clients cannot change them.
            // Reserved addresses change through /api/import-ets only.
            const next: Project = {
                version: 1, name: String(b.name ?? cur.name), floors: b.floors ?? [], rooms: b.rooms ?? [], assignments: b.assignments ?? [], rev: cur.rev,
                overrides: normalizeOverrides(b.overrides),
                reserved: cur.reserved, reservedSource: cur.reservedSource, applied: cur.applied, exported: cur.exported,
            };
            if (!Object.keys(next.overrides!).length) delete next.overrides;
            if (!next.reserved) delete next.reserved;
            if (!next.reservedSource) delete next.reservedSource;
            const errors = validateProject(next);
            if (errors.length) throw new HttpError(422, "project_invalid", "project is invalid", { errors });
            saveProject(this.#projectPath, next);
            return next;
        }

        if (method === "POST" && path === "/api/plan") return this.#planSummary(this.#plan(this.#project()));

        if (method === "POST" && path === "/api/import-ets") return this.#importEts(await this.#body(req, 16_000_000));
        if (method === "DELETE" && path === "/api/import-ets") {
            const project = this.#project();
            delete project.reserved;
            delete project.reservedSource;
            saveProject(this.#projectPath, project);
            return { ok: true };
        }

        if (method === "POST" && path === "/api/apply") {
            const b = await this.#body(req);
            if (b.confirm !== true) throw new HttpError(400, "confirm_required", "confirmation required (confirm: true)");
            const project = this.#project();
            const p = this.#plan(project);
            if (p.result.issues.some(i => i.level === "error")) throw new HttpError(422, "plan_errors", "plan has errors, not applied", { issues: p.result.issues });
            parseConfig(p.config); // validate again before writing
            this.#writeConfig(p.config);
            this.#deps.applyConfig(p.config);
            project.applied = snapshot(p.result, project.rev + 1);
            saveProject(this.#projectPath, project);
            log.info("admin", `applied: ${p.objects.length} KNX objects, ${Object.keys(p.slots).length} slots`);
            return { ok: true, applied: project.applied.at, ...this.#planSummary(p) };
        }

        if (method === "POST" && path === "/api/export") {
            const b = await this.#body(req);
            if (b.confirm !== true) throw new HttpError(400, "confirm_required", "confirmation required (confirm: true)");
            const project = this.#project();
            const p = this.#plan(project);
            if (p.result.issues.some(i => i.level === "error")) throw new HttpError(422, "plan_errors", "plan has errors, not exported", { issues: p.result.issues });
            if (p.addressChanges.length && b.acceptAddressChanges !== true) {
                throw new HttpError(409, "address_changes", "some GAs changed address since the last export", { addressChanges: p.addressChanges });
            }
            project.rev += 1;
            project.exported = snapshot(p.result, project.rev);
            saveProject(this.#projectPath, project);
            const base = `matter-bridge-rev${project.rev}`;
            // GAs that use an imported address on purpose already exist in the site ETS project: not exported again.
            const gas = p.result.gas.filter(g => !g.imported);
            return {
                ok: true,
                rev: project.rev,
                files: {
                    [`${base}-ets.xml`]: buildEtsXml(gas),
                    [`${base}-ga.csv`]: buildEtsCsv(gas),
                },
            };
        }
        if (method === "GET" && path === "/api/locks") return this.#locks();
        const lockCmd = /^\/api\/locks\/(\d+)\/(lock|unlock)$/.exec(path);
        if (method === "POST" && lockCmd) return this.#lockCommand(lockCmd[1], lockCmd[2] as "lock" | "unlock", await this.#body(req), this.#ip(req));
        if (method === "PUT" && path === "/api/locks/pin") return this.#changePin(await this.#body(req), this.#ip(req));

        throw new HttpError(404, "not_found", `no route ${method} ${path}`);
    }

    /**
     * ETS import: the addresses become reserved (the planner skips them). Our own GAs found in the file (address in
     * the last export, or same address and name as the current plan) are skipped so a round trip through ETS does
     * not move them. Body: { text, file?, merge? }.
     */
    #importEts(b: Record<string, unknown>) {
        if (typeof b.text !== "string" || !b.text.trim()) throw new HttpError(400, "import_empty", "no file content (text)");
        const r = parseEtsExport(b.text);
        if (!r.entries.length) {
            throw new HttpError(422, "import_unrecognised", "no group addresses found (expected an ETS group address export, CSV or XML, with 3-level addresses)", { errors: r.errors.slice(0, 20) });
        }
        const project = this.#project();
        const own = new Set(Object.values(project.exported?.gas ?? {}));
        const bare: Project = { ...project, reserved: [], overrides: {} };
        const plan = buildPlan(bare, this.#deps.getConfig(), this.#deps.planner ?? builtinPlanner);
        const ours = new Map(plan.result.gas.map(g => [g.ga, g.name]));
        const kept: ReservedGa[] = [];
        let skippedOwn = 0;
        for (const e of r.entries) {
            if (own.has(e.ga) || ours.get(e.ga) === e.name) skippedOwn++;
            else kept.push(e);
        }
        const merged = new Map<string, ReservedGa>(b.merge === true ? (project.reserved ?? []).map(x => [x.ga, x]) : []);
        for (const e of kept) merged.set(e.ga, e);
        project.reserved = [...merged.values()];
        project.reservedSource = { file: typeof b.file === "string" ? b.file.slice(0, 200) : "", at: new Date().toISOString() };
        if (!project.reserved.length) {
            delete project.reserved;
        }
        saveProject(this.#projectPath, project);
        log.info("admin", `ETS import (${r.format}): ${kept.length} reserved, ${skippedOwn} own skipped, ${r.duplicates.length} duplicates, ${r.errors.length} errors`);
        return {
            ok: true,
            format: r.format,
            found: r.entries.length,
            imported: kept.length,
            own: skippedOwn,
            reserved: project.reserved?.length ?? 0,
            duplicates: r.duplicates,
            errors: r.errors,
        };
    }

    #locks() {
        const cfg = this.#deps.getConfig();
        const locks = Object.entries(cfg.locks).map(([n, slot]) => {
            const node = this.#deps.matter.node(slot.node_id);
            const ch = lockChannels(n, slot, node, false);
            const battery = ch[`lock.${n}.battery`];
            return {
                slot: Number(n),
                nodeId: slot.node_id,
                endpoint: slot.endpoint,
                name: String(ch[`lock.${n}.name`] ?? ""),
                online: ch[`lock.${n}.online`] === true,
                status: String(ch[`lock.${n}.state`] ?? "Unknown"),
                battery: typeof battery === "number" ? battery : null,
                /** unlock_enabled: lock.N.unlock may be commanded by KNX clients. */
                unlockEnabled: Boolean(slot.unlock_enabled),
            };
        });
        return {
            locks,
            pinSet: Boolean(this.#cfg.unlock_pin_hash),
            lockedForMs: this.#guard.lockedFor(),
            attemptsLeft: this.#guard.attemptsLeft,
            log: this.#guard.entries.slice(0, 50),
        };
    }

    async #lockCommand(n: string, action: "lock" | "unlock", b: Record<string, unknown>, ip: string) {
        const slot = this.#deps.getConfig().locks[n];
        if (!slot) throw new HttpError(404, "lock_not_found", `no lock in slot ${n}`);
        const target = slot.name ?? `slot ${n}`;
        if (action === "unlock") {
            const stored = this.#cfg.unlock_pin_hash;
            if (!stored) throw new HttpError(409, "pin_not_set", "unlock PIN not set (run npm run set-unlock-pin on the bridge host)");
            const r = this.#guard.check(String(b.pin ?? ""), stored);
            if (r === "locked") {
                this.#guard.record({ source: "admin", ip, result: "locked_out", target });
                throw new HttpError(429, "pin_locked_out", "too many wrong PINs, temporarily locked", { lockedForMs: this.#guard.lockedFor() || LOCKOUT_MS });
            }
            if (r === "wrong") {
                this.#guard.record({ source: "admin", ip, result: "wrong_pin", target });
                throw new HttpError(403, "pin_wrong", "wrong PIN", { attemptsLeft: this.#guard.attemptsLeft });
            }
        } else if (b.confirm !== true) {
            throw new HttpError(400, "confirm_required", "confirmation required (confirm: true)");
        }
        const name = action === "lock" ? "lockDoor" : "unlockDoor";
        try {
            await this.#deps.matter.command(slot.node_id, slot.endpoint, DOOR_LOCK, name, {}, { timedRequestTimeoutMs: LOCK_TIMED_MS });
        } catch (e) {
            if (action === "unlock") this.#guard.record({ source: "admin", ip, result: "failed", target, detail: (e as Error).message });
            throw new HttpError(502, "matter_command_failed", `command ${name} failed: ${(e as Error).message}`);
        }
        if (action === "unlock") {
            this.#guard.record({ source: "admin", ip, result: "unlocked", target });
            log.warn("admin", `UNLOCKED ${target} (node ${slot.node_id}) from admin, IP ${ip}`);
        }
        return { ok: true };
    }

    #changePin(b: Record<string, unknown>, ip: string) {
        const stored = this.#cfg.unlock_pin_hash;
        if (!stored) throw new HttpError(409, "pin_not_set", "unlock PIN not set (run npm run set-unlock-pin on the bridge host)");
        const next = String(b.next ?? "");
        if (!PIN_RE.test(next)) throw new HttpError(422, "pin_format", "new PIN must be exactly 6 digits");
        const r = this.#guard.check(String(b.current ?? ""), stored);
        if (r === "locked") throw new HttpError(429, "pin_locked_out", "too many wrong PINs, temporarily locked", { lockedForMs: this.#guard.lockedFor() });
        if (r === "wrong") {
            this.#guard.record({ source: "admin", ip, result: "wrong_pin", detail: "change PIN" });
            throw new HttpError(403, "pin_wrong", "wrong PIN", { attemptsLeft: this.#guard.attemptsLeft });
        }
        const hash = hashPin(next);
        const path = this.#deps.configPath;
        const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        const admin = (raw.admin ?? {}) as Record<string, unknown>;
        admin.unlock_pin_hash = hash;
        raw.admin = admin;
        copyFileSync(path, `${path}.bak`);
        writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
        this.#cfg = { ...this.#cfg, unlock_pin_hash: hash };
        this.#guard.record({ source: "admin", ip, result: "pin_changed" });
        return { ok: true };
    }

    /** Writes config.json: replaces only slots and knx.objects, keeps every other key. Backs up the old file. */
    #writeConfig(cfg: BridgeConfig): void {
        const path = this.#deps.configPath;
        const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        raw.lights = cfg.lights;
        raw.thermostats = cfg.thermostats;
        raw.sensors = cfg.sensors;
        if (cfg.knx && raw.knx && typeof raw.knx === "object") (raw.knx as Record<string, unknown>).objects = cfg.knx.objects;
        copyFileSync(path, `${path}.bak`);
        writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
    }
}

/** Keeps well formed override entries ({ ga, useImported? }); validateProject reports bad addresses. */
function normalizeOverrides(raw: unknown): Record<string, GaOverride> {
    const out: Record<string, GaOverride> = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
        const o = (typeof v === "string" ? { ga: v } : v) as Partial<GaOverride> | null;
        if (!key || !o || typeof o.ga !== "string" || !o.ga.trim()) continue;
        const ga = normalizeGa(o.ga) ?? o.ga.trim();
        out[key] = o.useImported === true ? { ga, useImported: true } : { ga };
    }
    return out;
}
