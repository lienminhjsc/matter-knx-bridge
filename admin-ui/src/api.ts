import type { Dict } from "./i18n.tsx";
// Admin API calls (same origin; the browser keeps Basic auth after the first login).

export type CircuitType = string;

export interface EndpointInfo {
    endpoint: number;
    clusters: number[];
    deviceTypes: number[];
    suggested?: CircuitType;
    reason: string;
    bridgeSupported: boolean;
    hasIdentify: boolean;
}

export interface NodeInfo {
    nodeId: number;
    available: boolean;
    vendor?: string;
    product?: string;
    label?: string;
    network?: string;
    fabrics?: { used: number; supported: number };
    endpoints: EndpointInfo[];
}

export interface Floor { code: string; label: string; order: number; outdoor?: boolean }
export interface Room { code: string; floorCode: string; label: string; order: number }
export interface Assignment {
    id: string;
    nodeId: number;
    endpoint: number;
    circuitType: CircuitType;
    floorCode: string;
    roomCode: string;
    name: string;
    description?: string;
    slot?: number;
    fanFormat?: "stage" | "percent";
    fanSteps?: [number, number, number];
}
export interface Snapshot { at: string; rev: number; gas: Record<string, string> }
/** Manual GA address; useImported: the engineer chose an address imported from ETS on purpose. */
export interface GaOverride { ga: string; useImported?: boolean }
/** Address already used on site (ETS import). */
export interface ReservedGa { ga: string; name: string; dpt?: string }
export interface Project {
    version: 1;
    name: string;
    floors: Floor[];
    rooms: Room[];
    assignments: Assignment[];
    rev: number;
    overrides?: Record<string, GaOverride>;
    reserved?: ReservedGa[];
    reservedSource?: { file: string; at: string };
    applied?: Snapshot;
    exported?: Snapshot;
}

export interface Status {
    version: string;
    matter: { connected: boolean; nodes: number };
    knx?: { tunnels: number; port: number; objects: number; host: string | null; individualAddress: string | null } | null;
    project: { name: string; rev: number; frozen: boolean; applied: string | null };
}

export interface GaEntry {
    /** Final address (after a manual override). Empty: no address yet. */
    ga: string;
    name: string;
    dpt: string | null;
    isStatus: boolean;
    rangePath: string[];
    deviceId?: string;
    objectKey?: string;
    description?: string;
    /** Stable GA key "{deviceId}:{objectKey}" (key of project.overrides). */
    key: string;
    /** Address from the planner. */
    generated: string;
    overridden?: boolean;
    /** Name of the imported GA whose address this GA uses on purpose. */
    imported?: string;
}
/** KNX object bound to a bridge channel (see src/channels.ts). */
export interface KnxObject { ga: string; dpt: string; bind: string; dir: "cmd" | "fb"; transform?: string; fan_steps?: number[]; name?: string }
export interface Issue { level: "error" | "warning"; code: string; params: Record<string, string>; text: string; ga?: string; deviceId?: string; key?: string }
export interface Coded { code: string; params: Record<string, string>; text: string }
export interface AddressChange { key: string; name: string; from: string; to: string }
export interface PlanSummary {
    scheme: string;
    stats: { total: number; bySystem: Record<string, number>; maxUtilization: { scope: string; used: number; capacity: number } | null };
    issues: Issue[];
    gas: GaEntry[];
    objects: KnxObject[];
    slots: Record<string, number>;
    served: { mapped: number; deviceGas: number };
    warnings: Coded[];
    addressChanges: AddressChange[];
}

export interface ImportResult {
    ok: true;
    format: "csv" | "xml";
    found: number;
    imported: number;
    own: number;
    reserved: number;
    duplicates: string[];
    errors: { line: number; address: string; code: string; text: string }[];
}

export interface LockInfo {
    slot: number;
    nodeId: number;
    endpoint: number;
    name: string;
    online: boolean;
    status: string;
    battery: number | null;
    /** unlock_enabled in config: KNX clients may command lock.N.unlock. */
    unlockEnabled: boolean;
}
export interface AuditEntry { at: string; source: string; ip: string; result: string; target?: string; detail?: string }
export interface LocksInfo { locks: LockInfo[]; pinSet: boolean; lockedForMs: number; attemptsLeft: number; log: AuditEntry[] }

export class ApiError extends Error {
    status: number;
    code: string;
    detail: Record<string, unknown> | undefined;
    constructor(status: number, code: string, message: string, detail?: Record<string, unknown>) {
        super(message);
        this.status = status;
        this.code = code;
        this.detail = detail;
    }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
        // location.origin has no user:pass; fetch rejects URLs with credentials (when opened as http://admin:pw@host).
        res = await fetch(location.origin + path, {
            method,
            headers: body === undefined ? undefined : { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    } catch {
        throw new ApiError(0, "network", "network");
    }
    const text = await res.text();
    let data: unknown;
    try {
        data = text ? JSON.parse(text) : undefined;
    } catch {
        data = undefined;
    }
    if (!res.ok) {
        const d = (data ?? {}) as { error?: string; code?: string; detail?: Record<string, unknown> };
        throw new ApiError(res.status, d.code ?? "internal", d.error ?? `HTTP ${res.status}`, d.detail);
    }
    return data as T;
}

export const api = {
    status: () => call<Status>("GET", "/api/status"),
    nodes: () => call<NodeInfo[]>("GET", "/api/nodes"),
    identify: (nodeId: number, endpoint: number) => call<{ ok: true }>("POST", `/api/nodes/${nodeId}/identify`, { endpoint }),
    project: () => call<Project>("GET", "/api/project"),
    saveProject: (p: Project) => call<Project>("PUT", "/api/project", p),
    plan: () => call<PlanSummary>("POST", "/api/plan"),
    apply: () => call<PlanSummary & { ok: true; applied: string }>("POST", "/api/apply", { confirm: true }),
    exportEts: (acceptAddressChanges: boolean) =>
        call<{ ok: true; rev: number; files: Record<string, string> }>("POST", "/api/export", { confirm: true, acceptAddressChanges }),
    importEts: (text: string, file: string) => call<ImportResult>("POST", "/api/import-ets", { text, file }),
    clearImport: () => call<{ ok: true }>("DELETE", "/api/import-ets"),
    locks: () => call<LocksInfo>("GET", "/api/locks"),
    lock: (slot: number) => call<{ ok: true }>("POST", `/api/locks/${slot}/lock`, { confirm: true }),
    unlock: (slot: number, pin: string) => call<{ ok: true }>("POST", `/api/locks/${slot}/unlock`, { pin }),
    changePin: (current: string, next: string) => call<{ ok: true }>("PUT", "/api/locks/pin", { current, next }),
};

/** Error lines in the UI language: message + details (project errors, plan errors). */
export function errorLines(e: unknown, t: Dict): string[] {
    if (!(e instanceof ApiError)) return [String((e as Error)?.message ?? e)];
    const head = t.err[e.code] ?? e.message;
    const out = [e.code === "matter_command_failed" ? `${head}: ${e.message.replace(/^.*?: /, "")}` : head];
    const errs = e.detail?.errors;
    if (Array.isArray(errs)) out.push(...errs.map(x => (typeof x === "object" && x && "code" in x ? codedText(x as Coded, t.perr) : String(x))));
    const issues = e.detail?.issues;
    if (Array.isArray(issues)) out.push(...issues.filter(i => i?.level === "error").map(i => issueText(i as Issue, t)));
    return out;
}

export function codedText(c: Coded, table: Record<string, (p: Record<string, string>) => string>): string {
    return table[c.code]?.(c.params) ?? c.text;
}

export function issueText(i: Issue, t: Dict): string {
    return t.issue[i.code]?.(i.params ?? {}) ?? i.text;
}

/** Reads an uploaded file as text: UTF-8 (BOM or not) or UTF-16 with BOM. */
export async function readFileText(f: File): Promise<string> {
    const b = new Uint8Array(await f.arrayBuffer());
    if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b);
    if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b);
    return new TextDecoder("utf-8").decode(b);
}

/** Same rule as the bridge: main 0-31 / middle 0-7 / sub 0-255, not 0/0/0. Returns the normalised address. */
export function normalizeGa(s: string): string | undefined {
    const m = /^(\d{1,2})\/(\d)\/(\d{1,3})$/.exec(s.trim());
    if (!m) return undefined;
    const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (a > 31 || b > 7 || c > 255 || (a === 0 && b === 0 && c === 0)) return undefined;
    return `${a}/${b}/${c}`;
}

export function download(name: string, content: string): void {
    const type = name.endsWith(".xml") ? "application/xml" : "text/csv";
    const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
