// Built-in GA planner (scheme "builtin-v1"). Deterministic, no I/O. Addressing scheme:
//
//   main    = system: 0 central (reserved, not generated), 1 lighting, 2 shading (reserved), 3 HVAC,
//             4 sensors and security. Mains 5-31 are left free for the site.
//   middle  = floor: indoor floors sorted by (order, code) take middles 1, 2, 3...; outdoor floors take
//             7, 6, 5... from the top so adding an indoor floor never moves them. Middle 0 is reserved for
//             central functions. At most 7 floors in total (error floor_limit beyond).
//   sub     = room block: rooms of a floor sorted by (order, code); room k (0-based) owns subs
//             1 + 20k .. 20 + 20k in every main, so 12 rooms per floor (subs 1-240; 241-255 stay free).
//             Circuits of a room are allocated inside its own block (circuits sorted by name, objects in
//             template order), so adding a circuit to one room never moves the addresses of another room.
//             Addresses imported from ETS (reserved) are skipped. A full block leaves the remaining GAs
//             without an address (warning block_full); the engineer sets them by hand or moves circuits.
import {
    issue,
    type CircuitType,
    type GaEntry,
    type GaPlanner,
    type PlanIssue,
    type PlannerCircuit,
    type PlannerFloor,
    type PlannerInput,
    type PlannerOutput,
    type PlannerRoom,
} from "./types.ts";

export const BUILTIN_SCHEME = "builtin-v1";

/** Scheme constants (documented in the header above). */
export const SCHEME = {
    mains: { central: 0, lighting: 1, shading: 2, hvac: 3, sensors: 4 },
    firstFloorMiddle: 1,
    lastMiddle: 7,
    blockSize: 20,
    firstSub: 1,
    roomsPerFloor: 12,
} as const;

type System = keyof typeof SCHEME.mains;

export const SYSTEM_NAMES: Record<System, string> = {
    central: "Central",
    lighting: "Lighting",
    shading: "Shading",
    hvac: "HVAC",
    sensors: "Sensors and security",
};

/** One object of a circuit template: key, DPT, feedback (status) GA. */
interface ObjectTemplate {
    key: string;
    dpt: string;
    fb: boolean;
}

const o = (key: string, dpt: string, fb: boolean): ObjectTemplate => ({ key, dpt, fb });

const LIGHT_SW = [o("SW", "1.001", false), o("FB", "1.001", true)];
const LIGHT_DIM = [...LIGHT_SW, o("VAL", "5.001", false), o("VALFB", "5.001", true)];

/** Object templates per circuit type. Types without a template get no GAs (warning type_unsupported). */
export function templateOf(c: Pick<PlannerCircuit, "type" | "options">): ObjectTemplate[] | undefined {
    switch (c.type) {
        case "lt.onoff": return LIGHT_SW;
        case "lt.dim": return LIGHT_DIM;
        case "lt.cct": return [...LIGHT_DIM, o("CCT", "7.600", false), o("CCT_FB", "7.600", true)];
        case "hvac.unit": {
            const fan = c.options.fanFormat === "percent" ? "5.001" : "5.100";
            return [
                o("ONOFF", "1.001", false), o("ONOFF_FB", "1.001", true),
                o("SETP", "9.001", false), o("SETP_FB", "9.001", true),
                o("TEMP", "9.001", true),
                o("MODE", "20.105", false), o("MODE_FB", "20.105", true),
                o("FAN", fan, false), o("FAN_FB", fan, true),
            ];
        }
        case "pres.sensor": return [o("OCC", "1.018", true), o("LUX", "9.004", true)];
        case "sec.contact": return [o("CONTACT", "1.019", true)];
    }
    return undefined;
}

export function systemOf(t: CircuitType): System {
    if (t.startsWith("lt.")) return "lighting";
    if (t.startsWith("sht.")) return "shading";
    if (t.startsWith("hvac.")) return "hvac";
    return "sensors";
}

/** GA name prefix per circuit type. */
function prefixOf(t: CircuitType): string {
    if (t.startsWith("lt.")) return "LT";
    if (t.startsWith("sht.")) return "SHT";
    if (t.startsWith("hvac.")) return "HVAC";
    if (t === "pres.sensor") return "PRES";
    return "SEC";
}

const byOrder = <T extends { order: number; code: string }>(a: T, b: T): number => a.order - b.order || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
const NAME_OK = /^[\x20-\x7e]{1,255}$/;

/** Floor code -> middle group. Floors that do not fit get no middle. */
export function floorMiddles(floors: PlannerFloor[]): Map<string, number> {
    const out = new Map<string, number>();
    const outdoor = floors.filter(f => f.outdoor).sort(byOrder);
    const indoor = floors.filter(f => !f.outdoor).sort(byOrder);
    let top = SCHEME.lastMiddle;
    for (const f of outdoor) {
        if (top < SCHEME.firstFloorMiddle) break;
        out.set(f.code, top--);
    }
    let next = SCHEME.firstFloorMiddle;
    for (const f of indoor) {
        if (next > top) break;
        out.set(f.code, next++);
    }
    return out;
}

/** Room code -> block index on its floor (0-based). */
export function roomBlocks(rooms: PlannerRoom[]): Map<string, number> {
    const out = new Map<string, number>();
    const byFloor = new Map<string, PlannerRoom[]>();
    for (const r of rooms) {
        if (!byFloor.has(r.floorCode)) byFloor.set(r.floorCode, []);
        byFloor.get(r.floorCode)!.push(r);
    }
    for (const list of byFloor.values()) list.sort(byOrder).forEach((r, i) => out.set(r.code, i));
    return out;
}

export function planBuiltin(input: PlannerInput): PlannerOutput {
    const issues: PlanIssue[] = [];
    const gas: GaEntry[] = [];
    const reserved = new Set(input.reserved.map(r => r.ga));
    const middles = floorMiddles(input.floors);
    const blocks = roomBlocks(input.rooms);
    const floors = new Map(input.floors.map(f => [f.code, f]));
    const rooms = new Map(input.rooms.map(r => [r.code, r]));
    const maxFloors = SCHEME.lastMiddle - SCHEME.firstFloorMiddle + 1;

    for (const f of [...input.floors].sort(byOrder)) {
        if (!middles.has(f.code)) {
            issues.push(issue("error", "floor_limit", { floor: f.code, max: String(maxFloors) }, `Floor ${f.code}: the scheme has room for ${maxFloors} floors (middle groups 1-7); its circuits get no address`));
        }
    }
    for (const r of [...input.rooms].sort(byOrder)) {
        const k = blocks.get(r.code)!;
        if (k >= SCHEME.roomsPerFloor) {
            issues.push(issue("error", "room_limit", { room: r.code, floor: r.floorCode, max: String(SCHEME.roomsPerFloor) }, `Room ${r.code}: floor ${r.floorCode} has more than ${SCHEME.roomsPerFloor} rooms; its circuits get no address`));
        }
    }

    // Group circuits by room and system; allocate each block independently.
    const groups = new Map<string, PlannerCircuit[]>();
    const names = new Set<string>();
    for (const c of input.circuits) {
        const tpl = templateOf(c);
        if (!tpl) {
            issues.push(issue("warning", "type_unsupported", { name: c.name, type: c.type }, `${c.name} (${c.type}): no object template for this circuit type, no GAs generated`, { deviceId: c.id }));
            continue;
        }
        const room = rooms.get(c.roomCode);
        if (!room) {
            issues.push(issue("error", "room_missing", { name: c.name, room: c.roomCode }, `${c.name}: room ${c.roomCode} does not exist`, { deviceId: c.id }));
            continue;
        }
        if (!floors.has(room.floorCode)) {
            issues.push(issue("error", "floor_missing", { name: c.name, floor: room.floorCode }, `${c.name}: floor ${room.floorCode} does not exist`, { deviceId: c.id }));
            continue;
        }
        if (!NAME_OK.test(c.name)) {
            issues.push(issue("error", "name_invalid", { name: c.name }, `Circuit name "${c.name}": printable ASCII only`, { deviceId: c.id }));
            continue;
        }
        if (names.has(c.name)) issues.push(issue("warning", "name_duplicate", { name: c.name }, `Duplicate circuit name ${c.name}: GA names repeat`, { deviceId: c.id }));
        names.add(c.name);
        const key = `${room.code}\u0000${systemOf(c.type)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(c);
    }

    let maxUtil: PlannerOutput["stats"]["maxUtilization"] = null;
    const groupKeys = [...groups.keys()].sort((a, b) => {
        const [ra, sa] = a.split("\u0000");
        const [rb, sb] = b.split("\u0000");
        const fa = rooms.get(ra)!.floorCode;
        const fb = rooms.get(rb)!.floorCode;
        return byOrder(floors.get(fa)!, floors.get(fb)!) || byOrder(rooms.get(ra)!, rooms.get(rb)!) || SCHEME.mains[sa as System] - SCHEME.mains[sb as System];
    });
    for (const key of groupKeys) {
        const [roomCode, sys] = key.split("\u0000") as [string, System];
        const room = rooms.get(roomCode)!;
        const floor = floors.get(room.floorCode)!;
        const main = SCHEME.mains[sys];
        const middle = middles.get(floor.code);
        const k = blocks.get(room.code)!;
        const placed = middle !== undefined && k < SCHEME.roomsPerFloor;
        const start = SCHEME.firstSub + k * SCHEME.blockSize;
        const end = start + SCHEME.blockSize - 1;
        const rangePath = [SYSTEM_NAMES[sys], `${floor.code} ${floor.label}`.trim()];
        let sub = start;
        let used = 0;
        let missing = 0;
        const circuits = groups.get(key)!.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        for (const c of circuits) {
            for (const t of templateOf(c)!) {
                let ga = "";
                if (placed) {
                    while (sub <= end && reserved.has(`${main}/${middle}/${sub}`)) sub++;
                    if (sub <= end) {
                        ga = `${main}/${middle}/${sub}`;
                        sub++;
                        used++;
                    } else {
                        missing++;
                    }
                }
                gas.push({
                    ga,
                    name: `${prefixOf(c.type)} - ${c.name} - ${t.key}`,
                    dpt: t.dpt,
                    objectKey: t.key,
                    deviceId: c.id,
                    isStatus: t.fb,
                    rangePath,
                    ...(c.description ? { description: c.description } : {}),
                });
            }
        }
        if (missing) {
            issues.push(issue("warning", "block_full", { room: room.code, system: SYSTEM_NAMES[sys], capacity: String(SCHEME.blockSize), missing: String(missing) },
                `Room ${room.code}, ${SYSTEM_NAMES[sys]}: block of ${SCHEME.blockSize} addresses is full, ${missing} GAs have no address`));
        }
        if (placed && (!maxUtil || used / SCHEME.blockSize > maxUtil.used / maxUtil.capacity)) {
            maxUtil = { scope: `${main}/${middle}/${start}-${end} ${floor.code}.${room.code}`, used, capacity: SCHEME.blockSize };
        }
    }

    const bySystem: Record<string, number> = {};
    for (const g of gas) bySystem[g.rangePath[0]] = (bySystem[g.rangePath[0]] ?? 0) + 1;
    return { scheme: BUILTIN_SCHEME, gas, issues, stats: { total: gas.length, bySystem, maxUtilization: maxUtil } };
}

export const builtinPlanner: GaPlanner = {
    name: "builtin",
    plan: input => planBuiltin(input),
};
