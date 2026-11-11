// GA planner plugin interface. The admin app calls a GaPlanner to turn the project (floors, rooms, circuits)
// into KNX group addresses. The built-in planner (builtin.ts) is the default; a private build can plug in
// another planner with admin.planner_module (see load.ts). Pure data, no I/O.

/** Circuit types known to the admin app. Types the bridge does not serve yet are listed so projects can carry them. */
export const CIRCUIT_TYPES = [
    "lt.onoff", "lt.dim", "lt.cct", "lt.rgb", "lt.rgbw",
    "sht.roller", "sht.blind",
    "hvac.unit",
    "pres.sensor", "sec.contact",
] as const;
export type CircuitType = (typeof CIRCUIT_TYPES)[number];

export interface PlannerFloor {
    code: string;
    label: string;
    order: number;
    outdoor?: boolean;
}

export interface PlannerRoom {
    code: string;
    floorCode: string;
    label: string;
    order: number;
}

/** Per circuit options that change the generated objects. */
export interface CircuitOptions {
    /** hvac.unit fan GA: "stage" (default) = DPT 5.100 FanStage, "percent" = DPT 5.001. */
    fanFormat?: "stage" | "percent";
}

export interface PlannerCircuit {
    /** Stable circuit id (e.g. "n5e1"); becomes GaEntry.deviceId. */
    id: string;
    /** ASCII circuit name starting with "{floor}.{room}." (e.g. "GF.LIV.L01"). */
    name: string;
    type: CircuitType;
    floorCode: string;
    roomCode: string;
    description?: string;
    options: CircuitOptions;
}

/** Address already used on site (imported from ETS). Planners must not allocate it. */
export interface ReservedGa {
    ga: string;
    name: string;
    dpt?: string;
}

export interface PlannerInput {
    floors: PlannerFloor[];
    rooms: PlannerRoom[];
    circuits: PlannerCircuit[];
    /** Addresses the planner must skip (imported from ETS). */
    reserved: ReservedGa[];
}

/** Planner specific options (free form). The built-in planner has none today. */
export type PlannerOptions = Record<string, unknown>;

export interface GaEntry {
    /** "main/middle/sub". Empty string: the planner could not allocate an address (see issues). */
    ga: string;
    /** ASCII, e.g. "LT - GF.LIV.L01 - SW". */
    name: string;
    /** "1.001", "5.100"... null when unknown. */
    dpt: string | null;
    /** Object key inside the circuit (e.g. "SW", "FB"). Set together with deviceId for circuit GAs. */
    objectKey?: string;
    /** Circuit id. Missing for shared GAs (central, scenes). */
    deviceId?: string;
    /** Feedback (status) GA. */
    isStatus: boolean;
    /** Names of the main and middle group (ETS group ranges), e.g. ["Lighting", "GF Ground floor"]. */
    rangePath: string[];
    description?: string;
}

export interface PlanIssue {
    level: "error" | "warning";
    /** Stable code; the UI translates it (admin-ui/src/i18n.tsx, issue dictionary). */
    code: string;
    params: Record<string, string>;
    /** English text for logs and API clients. */
    text: string;
    ga?: string;
    deviceId?: string;
    /** GA key ("{deviceId}:{objectKey}") the issue belongs to, for inline display. */
    key?: string;
}

export interface PlanStats {
    total: number;
    /** Main group name -> GA count. */
    bySystem: Record<string, number>;
    /** Fullest allocation block, when the planner allocates in blocks. */
    maxUtilization: { scope: string; used: number; capacity: number } | null;
}

export interface PlannerOutput {
    /** Scheme id shown in the UI, e.g. "builtin-v1". */
    scheme: string;
    gas: GaEntry[];
    issues: PlanIssue[];
    stats: PlanStats;
}

/** A GA planner. plan() must be deterministic: the same input gives the same output. */
export interface GaPlanner {
    /** Short planner id for logs. */
    readonly name: string;
    plan(input: PlannerInput, options?: PlannerOptions): PlannerOutput;
}

export function issue(level: PlanIssue["level"], code: string, params: Record<string, string>, text: string, extra: Partial<PlanIssue> = {}): PlanIssue {
    return { level, code, params, text, ...extra };
}

/** Stable key of a GA across regenerations: "{deviceId}:{objectKey}", or "name:{name}" for shared GAs. */
export function gaKey(g: Pick<GaEntry, "deviceId" | "objectKey" | "name">): string {
    return g.deviceId && g.objectKey ? `${g.deviceId}:${g.objectKey}` : `name:${g.name}`;
}

const GA_RE = /^(\d{1,2})\/(\d)\/(\d{1,3})$/;

/** Parses "main/middle/sub" (3-level). Ranges: main 0-31, middle 0-7, sub 0-255; 0/0/0 is not a valid GA. */
export function parseGa(s: string): [number, number, number] | undefined {
    const m = GA_RE.exec(s.trim());
    if (!m) return undefined;
    const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (a > 31 || b > 7 || c > 255 || (a === 0 && b === 0 && c === 0)) return undefined;
    return [a, b, c];
}

/** Normalises a valid GA ("01/1/007" -> "1/1/7"); undefined when invalid. */
export function normalizeGa(s: string): string | undefined {
    const p = parseGa(s);
    return p ? p.join("/") : undefined;
}

/** 16-bit GA number (for sorting and ETS ranges). */
export function gaNumber(s: string): number {
    const p = parseGa(s);
    return p ? (p[0] << 11) | (p[1] << 8) | p[2] : -1;
}
