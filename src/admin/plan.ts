// Admin project -> group addresses (GA planner + manual overrides + reserved addresses) + bridge slots + KNX
// object bindings. Pure functions, no I/O. The planner is pluggable (planner/types.ts); the checks after it
// (overrides, duplicates, reserved addresses) run here for every planner.
import { builtinPlanner } from "./planner/builtin.ts";
import {
    gaKey,
    issue,
    normalizeGa,
    parseGa,
    type CircuitType,
    type GaEntry,
    type GaPlanner,
    type PlanIssue,
    type PlannerInput,
    type PlannerOutput,
} from "./planner/types.ts";
import { LIMITS, type BridgeConfig, type LightSlot, type SensorSlot, type ThermostatSlot } from "../config.ts";
import type { KnxObjectConfig } from "../knx/gateway.ts";
import type { Assignment, Project } from "./project.ts";
import { BRIDGE_SUPPORTED } from "./suggest.ts";

type SlotKind = "lights" | "thermostats" | "sensors";

export function slotKindOf(t: CircuitType): SlotKind | undefined {
    if (t === "lt.onoff" || t === "lt.dim" || t === "lt.cct") return "lights";
    if (t === "hvac.unit") return "thermostats";
    if (t === "pres.sensor" || t === "sec.contact") return "sensors";
    return undefined;
}

/**
 * Fan GA DPT for the chosen format: default 5.100 FanStage (0-3), which KNX clients that compare exact stage
 * values expect; "percent" = 5.001.
 */
export function fanDpt(a: Assignment): string {
    return a.fanFormat === "percent" ? "5.001" : "5.100";
}

type Binding = Omit<KnxObjectConfig, "ga" | "name">;

/**
 * Planner object key -> channel binding. n = slot. Keys missing here are not served by the bridge (a plugin
 * planner may add more objects): they stay in the ETS export but have no binding.
 */
function objectBinding(kind: SlotKind, key: string, n: number, dpt: string, a: Assignment): Binding | undefined {
    if (kind === "lights") {
        switch (key) {
            case "SW": return { dpt, bind: `light.${n}.on`, dir: "cmd" };
            case "FB": return { dpt, bind: `light.${n}.on`, dir: "fb" };
            case "VAL": return { dpt, bind: `light.${n}.level`, dir: "cmd" };
            case "VALFB": return { dpt, bind: `light.${n}.level`, dir: "fb" };
            case "CCT": return { dpt, bind: `light.${n}.ct`, dir: "cmd" };
            case "CCT_FB": return { dpt, bind: `light.${n}.ct`, dir: "fb" };
        }
        return undefined;
    }
    if (kind === "thermostats") {
        switch (key) {
            // Matter Thermostat has no separate on/off: hvac.N.on maps to mode Cool (or Heat) / Off.
            case "ONOFF": return { dpt, bind: `hvac.${n}.on`, dir: "cmd" };
            case "ONOFF_FB": return { dpt, bind: `hvac.${n}.on`, dir: "fb" };
            case "SETP": return { dpt, bind: `hvac.${n}.setpoint`, dir: "cmd" };
            case "SETP_FB": return { dpt, bind: `hvac.${n}.setpoint`, dir: "fb" };
            case "TEMP": return { dpt, bind: `hvac.${n}.temperature`, dir: "fb" };
            case "MODE": return { dpt, bind: `hvac.${n}.mode`, dir: "cmd", transform: "hvac_mode" };
            case "MODE_FB": return { dpt, bind: `hvac.${n}.mode`, dir: "fb", transform: "hvac_mode" };
            case "FAN":
            case "FAN_FB": {
                const b: Binding = { dpt, bind: `hvac.${n}.fan`, dir: key === "FAN" ? "cmd" : "fb" };
                if (a.fanFormat !== "percent") return b;
                return { ...b, transform: "fan_level", ...(a.fanSteps ? { fan_steps: a.fanSteps } : {}) };
            }
        }
        return undefined;
    }
    switch (key) {
        case "OCC": return { dpt, bind: `sensor.${n}.occupancy`, dir: "fb" };
        case "LUX": return { dpt, bind: `sensor.${n}.lux`, dir: "fb" };
        // DPT 1.019: 0 = closed; sensor.N.contact true = closed
        case "CONTACT": return { dpt, bind: `sensor.${n}.contact`, dir: "fb", transform: "invert" };
    }
    return undefined;
}

/** Plan warning: code + params for the UI to translate; English text for logs. */
export interface PlanWarning {
    code: "slot_full" | "circuit_unsupported" | "objects_unsupported" | "group_gas";
    params: Record<string, string>;
    text: string;
}

export interface AddressChange {
    key: string;
    name: string;
    from: string;
    to: string;
}

/** Planner GA after manual overrides. */
export interface PlanGa extends GaEntry {
    /** Stable GA key ("{deviceId}:{objectKey}"). */
    key: string;
    /** Address from the planner (before the manual override). */
    generated: string;
    /** A manual address is set for this GA. */
    overridden?: boolean;
    /** Name of the imported (reserved) GA this GA uses on purpose. */
    imported?: string;
}

export interface PlanResult extends PlannerOutput {
    gas: PlanGa[];
}

export interface Plan {
    result: PlanResult;
    /** assignment id -> bridge slot */
    slots: Record<string, number>;
    /** Bridge config after apply (slots not managed by admin are kept). */
    config: BridgeConfig;
    objects: KnxObjectConfig[];
    /** Warnings for the UI (non-blocking). */
    warnings: PlanWarning[];
    /** GAs whose address changed since the last export (frozen). Non-empty blocks export unless the engineer confirms. */
    addressChanges: AddressChange[];
    /** GAs served by the bridge / total device GAs. */
    served: { mapped: number; deviceGas: number };
}

export { gaKey };

function nodeEp(s: { node_id: number; endpoint?: number }): string {
    return `${s.node_id}/${s.endpoint ?? "*"}`;
}

/** Slot allocation: keep the existing slot of the same node/endpoint, then the manual slot, then the lowest free slot. */
function allocateSlots(project: Project, cfg: BridgeConfig, warnings: PlanWarning[]): Record<string, number> {
    const out: Record<string, number> = {};
    const byKind: Record<SlotKind, Record<string, { node_id: number; endpoint?: number }>> = {
        lights: cfg.lights, thermostats: cfg.thermostats, sensors: cfg.sensors,
    };
    const used: Record<SlotKind, Set<number>> = { lights: new Set(), thermostats: new Set(), sensors: new Set() };
    const pending: Assignment[] = [];
    for (const a of project.assignments) {
        const kind = slotKindOf(a.circuitType);
        if (!kind) continue;
        const existing = Object.entries(byKind[kind]).find(([, s]) => s.node_id === a.nodeId && (s.endpoint === undefined || s.endpoint === a.endpoint));
        const want = existing ? Number(existing[0]) : a.slot;
        if (want !== undefined && !used[kind].has(want) && want >= 1 && want <= LIMITS[kind]) {
            out[a.id] = want;
            used[kind].add(want);
        } else {
            pending.push(a);
        }
    }
    for (const a of pending) {
        const kind = slotKindOf(a.circuitType) as SlotKind;
        // Skip slots used by devices not managed by admin (e.g. hand-configured locks).
        const taken = new Set([...used[kind], ...Object.keys(byKind[kind]).map(Number)]);
        let n = 1;
        while (taken.has(n) && n <= LIMITS[kind]) n++;
        if (n > LIMITS[kind]) {
            warnings.push({ code: "slot_full", params: { name: a.name, kind, max: String(LIMITS[kind]) }, text: `${a.name}: no free ${kind} slot (max ${LIMITS[kind]})` });
            continue;
        }
        out[a.id] = n;
        used[kind].add(n);
    }
    return out;
}

export function plannerInput(project: Project): PlannerInput {
    return {
        floors: project.floors.map(f => ({ ...f })),
        rooms: project.rooms.map(r => ({ ...r })),
        circuits: project.assignments.map(a => ({
            id: a.id,
            name: a.name,
            type: a.circuitType,
            floorCode: a.floorCode,
            roomCode: a.roomCode,
            ...(a.description ? { description: a.description } : {}),
            options: a.fanFormat ? { fanFormat: a.fanFormat } : {},
        })),
        reserved: (project.reserved ?? []).map(r => ({ ...r })),
    };
}

/** Runs the planner and checks its output (shape only; a broken plugin must not crash the admin app). */
function runPlanner(planner: GaPlanner, input: PlannerInput): PlannerOutput {
    const out = planner.plan(input);
    if (!out || !Array.isArray(out.gas) || !Array.isArray(out.issues)) throw new Error(`planner ${planner.name}: plan() must return { scheme, gas[], issues[], stats }`);
    return {
        scheme: String(out.scheme ?? planner.name),
        gas: out.gas,
        issues: out.issues.map(i => ({ ...i, params: i.params ?? {}, text: i.text ?? i.code })),
        stats: out.stats ?? { total: out.gas.length, bySystem: {}, maxUtilization: null },
    };
}

/**
 * Applies manual overrides and checks every address: unassigned, invalid, duplicate, reserved (imported) without
 * explicit consent. Also reports overrides whose GA no longer exists.
 */
function finishGas(project: Project, gas: GaEntry[], issues: PlanIssue[]): PlanGa[] {
    const overrides = project.overrides ?? {};
    const reserved = new Map((project.reserved ?? []).map(r => [normalizeGa(r.ga) ?? r.ga, r]));
    const out: PlanGa[] = gas.map(g => {
        const key = gaKey(g);
        const o = overrides[key];
        const ga = o ? normalizeGa(o.ga) ?? o.ga : g.ga;
        const r = reserved.get(ga);
        return {
            ...g,
            key,
            ga,
            generated: g.ga,
            ...(o ? { overridden: true } : {}),
            ...(o && r && o.useImported ? { imported: r.name } : {}),
        };
    });
    const names = new Map(project.assignments.map(a => [a.id, a.name]));
    const unassigned = new Map<string, string[]>();
    const byGa = new Map<string, PlanGa[]>();
    for (const g of out) {
        if (!g.ga) {
            const who = (g.deviceId && names.get(g.deviceId)) ?? g.name;
            if (!unassigned.has(who)) unassigned.set(who, []);
            unassigned.get(who)!.push(g.objectKey ?? g.name);
            continue;
        }
        if (!parseGa(g.ga)) {
            issues.push(issue("error", "ga_out_of_range", { ga: g.ga, name: g.name }, `${g.name}: ${g.ga} is not a valid group address (main 0-31 / middle 0-7 / sub 0-255, not 0/0/0)`, { ga: g.ga, key: g.key }));
            continue;
        }
        if (!byGa.has(g.ga)) byGa.set(g.ga, []);
        byGa.get(g.ga)!.push(g);
        const r = reserved.get(g.ga);
        if (r && !g.imported) {
            issues.push(issue("error", "ga_reserved", { ga: g.ga, name: g.name, imported: r.name }, `${g.name}: ${g.ga} is already used on site ("${r.name}", ETS import)`, { ga: g.ga, key: g.key }));
        }
    }
    for (const [who, keys] of unassigned) {
        issues.push(issue("error", "ga_unassigned", { name: who, objects: keys.join(", ") }, `${who}: no address for ${keys.join(", ")}; set the addresses by hand or move circuits`));
    }
    for (const [ga, list] of byGa) {
        if (list.length < 2) continue;
        const manual = list.filter(g => g.overridden);
        if (manual.length) {
            for (const g of manual) {
                const other = list.find(x => x !== g)!;
                issues.push(issue("error", "override_conflict", { ga, name: g.name, other: other.name }, `${g.name}: manual address ${ga} is already used by ${other.name}`, { ga, key: g.key }));
            }
        } else {
            const names2 = list.map(g => g.name).join(", ");
            issues.push(issue("error", "ga_duplicate", { ga, names: names2 }, `Duplicate address ${ga}: ${names2}`, { ga }));
        }
    }
    const keys = new Set(out.map(g => g.key));
    for (const [key, o] of Object.entries(overrides)) {
        if (!keys.has(key)) issues.push(issue("warning", "override_unused", { key, ga: o.ga }, `Manual address ${o.ga} for ${key}: this GA no longer exists`, { key }));
    }
    return out;
}

export function buildPlan(project: Project, cfg: BridgeConfig, planner: GaPlanner = builtinPlanner): Plan {
    const warnings: PlanWarning[] = [];
    const planned = runPlanner(planner, plannerInput(project));
    const issues = [...planned.issues];
    const byId0 = new Map(project.assignments.map(a => [a.id, a]));
    // DPTs the bridge needs, whatever the planner chose (the ETS export must match the bridge): fan per the
    // chosen format, MODE 20.105 HVACContrMode.
    for (const g of planned.gas) {
        const a = g.deviceId ? byId0.get(g.deviceId) : undefined;
        if (a?.circuitType !== "hvac.unit") continue;
        if (g.objectKey === "FAN" || g.objectKey === "FAN_FB") g.dpt = fanDpt(a);
        if (g.objectKey === "MODE" || g.objectKey === "MODE_FB") g.dpt = "20.105";
    }
    const gas = finishGas(project, planned.gas, issues);
    const result: PlanResult = { ...planned, gas, issues };
    const slots = allocateSlots(project, cfg, warnings);
    const byId = new Map(project.assignments.map(a => [a.id, a]));

    // Bridge slots: keep slots not managed by admin (node/endpoint not in the project), replace the project ones.
    const managed = new Set(project.assignments.map(a => `${a.nodeId}/${a.endpoint}`));
    const keep = <T extends { node_id: number; endpoint?: number }>(rec: Record<string, T>): Record<string, T> =>
        Object.fromEntries(Object.entries(rec).filter(([, s]) => !managed.has(nodeEp(s)) && !managed.has(`${s.node_id}/*`)));
    const lights: Record<string, LightSlot> = keep(cfg.lights);
    const thermostats: Record<string, ThermostatSlot> = keep(cfg.thermostats);
    const sensors: Record<string, SensorSlot> = keep(cfg.sensors);
    for (const a of project.assignments) {
        const n = slots[a.id];
        if (n === undefined) continue;
        const kind = slotKindOf(a.circuitType);
        const old = kind ? (cfg[kind] as Record<string, { name?: string; fan_endpoint?: number }>)[String(n)] : undefined;
        if (kind === "lights") lights[String(n)] = { node_id: a.nodeId, endpoint: a.endpoint, name: a.description ?? a.name };
        if (kind === "thermostats") {
            thermostats[String(n)] = { node_id: a.nodeId, endpoint: a.endpoint, name: a.description ?? a.name };
            if (old?.fan_endpoint !== undefined) thermostats[String(n)].fan_endpoint = old.fan_endpoint;
        }
        if (kind === "sensors") sensors[String(n)] = { node_id: a.nodeId, endpoint: a.endpoint, name: a.description ?? a.name };
    }

    const objects: KnxObjectConfig[] = [];
    let deviceGas = 0;
    const unsupported = new Map<string, Set<string>>();
    for (const g of result.gas) {
        if (!g.deviceId || !g.objectKey) continue;
        deviceGas++;
        if (!parseGa(g.ga)) continue;
        const a = byId.get(g.deviceId);
        if (!a) continue;
        const kind = slotKindOf(a.circuitType);
        const n = slots[a.id];
        const m = kind && n !== undefined && g.dpt ? objectBinding(kind, g.objectKey, n, g.dpt, a) : undefined;
        if (m) objects.push({ ga: g.ga, name: g.name, ...m });
        else {
            if (!unsupported.has(a.name)) unsupported.set(a.name, new Set());
            unsupported.get(a.name)!.add(g.objectKey);
        }
    }
    const withGas = new Set(result.gas.map(g => g.deviceId));
    for (const a of project.assignments) {
        // Without GAs the planner already warned (type_unsupported).
        if (!BRIDGE_SUPPORTED.has(a.circuitType) && withGas.has(a.id)) {
            warnings.push({ code: "circuit_unsupported", params: { name: a.name, type: a.circuitType }, text: `${a.name} (${a.circuitType}): the bridge does not control this circuit type yet; its GAs stay in the ETS export` });
        }
    }
    for (const [name, keys] of unsupported) {
        const a = project.assignments.find(x => x.name === name);
        const objs = [...keys].join(", ");
        if (a && BRIDGE_SUPPORTED.has(a.circuitType)) warnings.push({ code: "objects_unsupported", params: { name, objects: objs }, text: `${name}: objects ${objs} are not served by the bridge yet` });
    }
    const groupGas = result.gas.filter(g => !g.deviceId).length;
    if (groupGas) warnings.push({ code: "group_gas", params: { count: String(groupGas) }, text: `${groupGas} shared GAs (scenes, room/floor groups, central) are not served by the bridge yet` });

    const addressChanges: AddressChange[] = [];
    if (project.exported) {
        for (const g of result.gas) {
            const was = project.exported.gas[g.key];
            if (was !== undefined && was !== g.ga) addressChanges.push({ key: g.key, name: g.name, from: was, to: g.ga });
        }
    }

    // Keep hand-written KNX objects for devices the project does not manage (door locks, slots configured by
    // hand, system channels), as long as their address is not taken by the plan. Same rule as for slots.
    const prefix: Record<string, string> = { lights: "light", thermostats: "hvac", sensors: "sensor" };
    const managedDevices = new Set(
        project.assignments.flatMap(a => {
            const kind = slotKindOf(a.circuitType);
            const n = slots[a.id];
            return kind && n !== undefined ? [`${prefix[kind]}.${n}`] : [];
        }),
    );
    const plannedGas = new Set(objects.map(o => o.ga));
    const kept = (cfg.knx?.objects ?? []).filter(o => {
        const device = o.bind.split(".").slice(0, 2).join(".");
        return !managedDevices.has(device) && !plannedGas.has(o.ga);
    });
    const knx = cfg.knx ? { ...cfg.knx, objects: [...objects, ...kept] } : undefined;
    const config: BridgeConfig = { ...cfg, lights, thermostats, sensors, ...(knx ? { knx } : {}) };
    return { result, slots, config, objects, warnings, addressChanges, served: { mapped: objects.length, deviceGas } };
}

export function snapshot(result: PlanResult, rev: number): { at: string; rev: number; gas: Record<string, string> } {
    return { at: new Date().toISOString(), rev, gas: Object.fromEntries(result.gas.filter(g => parseGa(g.ga)).map(g => [g.key, g.ga])) };
}
