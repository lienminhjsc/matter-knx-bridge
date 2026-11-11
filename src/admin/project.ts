// Admin project data (project.json): floors, rooms, Matter endpoints assigned to rooms, manual GA addresses,
// addresses reserved by an ETS import, applied / exported GA snapshots.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { normalizeGa, type CircuitType, type ReservedGa } from "./planner/types.ts";

export interface Floor {
    code: string;
    label: string;
    order: number;
    outdoor?: boolean;
}

export interface Room {
    code: string;
    floorCode: string;
    label: string;
    order: number;
}

export interface Assignment {
    /** Stable circuit key: "n{node}e{endpoint}" (e.g. n5e1). Used as the planner deviceId. */
    id: string;
    nodeId: number;
    endpoint: number;
    circuitType: CircuitType;
    floorCode: string;
    roomCode: string;
    /** "GF.LIV.L01": ASCII, starts with {floor}.{room}. */
    name: string;
    description?: string;
    /** Bridge slot (lights / thermostats / sensors). Empty: allocated automatically, keeping the existing slot. */
    slot?: number;
    /**
     * Fan GA format (hvac.unit only). "stage" (default): DPT 5.100 FanStage, value 0-3 = stage.
     * "percent": DPT 5.001, stage <-> % via fanSteps; use it to match existing KNX devices working in %.
     */
    fanFormat?: "stage" | "percent";
    /** "percent": % for Low / Medium / High. Default [33, 67, 100]. */
    fanSteps?: [number, number, number];
}

/** GA snapshot: key = "{deviceId}:{objectKey}" (or the GA name for shared GAs), value = address. */
export interface AddressSnapshot {
    at: string;
    rev: number;
    gas: Record<string, string>;
}

/** Manual address for one GA (key "{deviceId}:{objectKey}"). */
export interface GaOverride {
    ga: string;
    /** The engineer chose an address imported from ETS on purpose (the GA already exists on site). */
    useImported?: boolean;
}

export interface Project {
    version: 1;
    name: string;
    floors: Floor[];
    rooms: Room[];
    assignments: Assignment[];
    rev: number;
    /** Manual addresses, key = GA key. Win over the planner. */
    overrides?: Record<string, GaOverride>;
    /** Addresses already used on site (ETS import). The planner skips them. Written by /api/import-ets only. */
    reserved?: ReservedGa[];
    /** Last ETS import (file name, time). */
    reservedSource?: { file: string; at: string };
    applied?: AddressSnapshot;
    /** Last ETS export. Set = frozen: addresses must not change when regenerating. */
    exported?: AddressSnapshot;
}

export function emptyProject(): Project {
    return { version: 1, name: "New project", floors: [], rooms: [], assignments: [], rev: 0 };
}

const CODE_RE = /^[A-Z0-9]{2,8}$/;
const NAME_RE = /^[\x21-\x7e]+$/;

/** Project error: code + params for the UI to translate (VI/EN); English text for logs. */
export interface ProjectError {
    code:
        | "floor_code" | "floor_dup" | "room_code" | "room_dup" | "room_no_floor"
        | "circuit_dup" | "circuit_no_room" | "circuit_wrong_floor" | "circuit_name" | "circuit_name_dup"
        | "fan_format" | "fan_steps"
        | "override_format" | "override_dup" | "override_reserved" | "reserved_format" | "reserved_dup";
    params: Record<string, string>;
    text: string;
}

function pe(code: ProjectError["code"], params: Record<string, string>, text: string): ProjectError {
    return { code, params, text };
}

/** Validates a project. Returns coded errors (translated by the UI). */
export function validateProject(p: Project): ProjectError[] {
    const errors: ProjectError[] = [];
    const floorCodes = new Set<string>();
    for (const f of p.floors) {
        if (!CODE_RE.test(f.code)) errors.push(pe("floor_code", { code: f.code }, `Floor code "${f.code}": 2-8 characters A-Z, 0-9`));
        if (floorCodes.has(f.code)) errors.push(pe("floor_dup", { code: f.code }, `Duplicate floor code ${f.code}`));
        floorCodes.add(f.code);
    }
    const roomCodes = new Set<string>();
    for (const r of p.rooms) {
        if (!CODE_RE.test(r.code)) errors.push(pe("room_code", { code: r.code }, `Room code "${r.code}": 2-8 characters A-Z, 0-9`));
        if (roomCodes.has(r.code)) errors.push(pe("room_dup", { code: r.code }, `Duplicate room code ${r.code} (room codes are unique per project)`));
        if (!floorCodes.has(r.floorCode)) errors.push(pe("room_no_floor", { room: r.code, floor: r.floorCode }, `Room ${r.code}: no floor ${r.floorCode}`));
        roomCodes.add(r.code);
    }
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const a of p.assignments) {
        const who = a.name || a.id;
        if (ids.has(a.id)) errors.push(pe("circuit_dup", { id: a.id }, `Duplicate circuit ${a.id}`));
        ids.add(a.id);
        if (!roomCodes.has(a.roomCode)) errors.push(pe("circuit_no_room", { name: who, room: a.roomCode }, `${who}: no room ${a.roomCode}`));
        const room = p.rooms.find(r => r.code === a.roomCode);
        if (room && room.floorCode !== a.floorCode) {
            errors.push(pe("circuit_wrong_floor", { name: who, room: a.roomCode, floor: a.floorCode }, `${who}: room ${a.roomCode} is not on floor ${a.floorCode}`));
        }
        const prefix = `${a.floorCode}.${a.roomCode}.`;
        if (!NAME_RE.test(a.name) || !a.name.startsWith(prefix)) {
            errors.push(pe("circuit_name", { name: a.name, prefix }, `Name "${a.name}": ASCII, no spaces, starting with ${prefix}`));
        }
        if (names.has(a.name)) errors.push(pe("circuit_name_dup", { name: a.name }, `Duplicate circuit name ${a.name}`));
        names.add(a.name);
        if (a.fanFormat !== undefined && a.fanFormat !== "stage" && a.fanFormat !== "percent") {
            errors.push(pe("fan_format", { name: who, value: String(a.fanFormat) }, `${who}: invalid fan format ${String(a.fanFormat)}`));
        }
        if (a.fanSteps !== undefined) {
            const st = a.fanSteps;
            const ok = Array.isArray(st) && st.length === 3 && st.every(Number.isFinite) && st[0] >= 1 && st[0] < st[1] && st[1] < st[2] && st[2] <= 100;
            if (!ok) errors.push(pe("fan_steps", { name: who }, `${who}: fan % must be Low < Medium < High within 1-100`));
        }
    }
    const reserved = new Map<string, ReservedGa>();
    for (const r of p.reserved ?? []) {
        const ga = typeof r?.ga === "string" ? normalizeGa(r.ga) : undefined;
        if (!ga) {
            errors.push(pe("reserved_format", { ga: String(r?.ga) }, `Imported address "${String(r?.ga)}" is not a valid group address`));
            continue;
        }
        if (reserved.has(ga)) errors.push(pe("reserved_dup", { ga }, `Imported address ${ga} appears twice`));
        reserved.set(ga, r);
    }
    const targets = new Map<string, string>();
    for (const [key, o] of Object.entries(p.overrides ?? {})) {
        const ga = typeof o?.ga === "string" ? normalizeGa(o.ga) : undefined;
        if (!ga) {
            errors.push(pe("override_format", { key, ga: String(o?.ga) }, `${key}: "${String(o?.ga)}" is not a valid group address (main 0-31 / middle 0-7 / sub 0-255, not 0/0/0)`));
            continue;
        }
        const other = targets.get(ga);
        if (other) errors.push(pe("override_dup", { ga, key, other }, `Manual address ${ga} is set for both ${other} and ${key}`));
        targets.set(ga, key);
        const r = reserved.get(ga);
        if (r && o.useImported !== true) {
            errors.push(pe("override_reserved", { key, ga, name: r.name }, `${key}: ${ga} is imported from ETS ("${r.name}"); confirm to use the imported address`));
        }
    }
    return errors;
}

export function loadProject(path: string): Project {
    if (!existsSync(path)) return emptyProject();
    const p = JSON.parse(readFileSync(path, "utf8")) as Project;
    if (p.version !== 1) throw new Error(`${path}: version ${String(p.version)} is not supported`);
    return p;
}

/** Safe write: temp file then rename (no half-written project.json on power loss). */
export function saveProject(path: string, p: Project): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(p, null, 2) + "\n");
    renameSync(tmp, path);
}
