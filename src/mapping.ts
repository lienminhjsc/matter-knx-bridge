// Conversion between Matter attributes and bridge channels (see channels.ts). Pure functions, no I/O.
import type { LightSlot, LockSlot, SensorSlot, ThermostatSlot } from "./config.ts";
import type { Channels } from "./channels.ts";

export interface NodeView {
    node_id: number;
    available: boolean;
    /** Key "endpoint/cluster/attribute" (decimal), as returned by matter-server. */
    attributes: Record<string, unknown>;
}

export const CLUSTER = {
    BASIC: 40,
    POWER_SOURCE: 47,
    ON_OFF: 6,
    LEVEL: 8,
    BOOLEAN_STATE: 69,
    DOOR_LOCK: 257,
    COLOR: 768,
    ILLUMINANCE: 1024,
    TEMPERATURE: 1026,
    HUMIDITY: 1029,
    OCCUPANCY: 1030,
    THERMOSTAT: 513,
    FAN: 514,
} as const;

const ATTR = {
    BASIC_NODE_LABEL: 5,
    POWER_BAT_PERCENT: 12,
    ON_OFF: 0,
    LEVEL_CURRENT: 0,
    LEVEL_MIN: 2,
    LEVEL_MAX: 3,
    COLOR_HUE: 0,
    COLOR_SAT: 1,
    COLOR_TEMP_MIREDS: 7,
    COLOR_TEMP_MIN: 16395,
    COLOR_TEMP_MAX: 16396,
    LOCK_STATE: 0,
    MEASURED_VALUE: 0,
} as const;

/** LockState of the DoorLock cluster (Matter 1.x). */
export const LOCK_STATE_NAMES: Record<number, string> = {
    0: "NotFullyLocked",
    1: "Locked",
    2: "Unlocked",
    3: "Unlatched",
};

export function attr(node: NodeView | undefined, ep: number, cluster: number, attribute: number): unknown {
    return node?.attributes[`${ep}/${cluster}/${attribute}`];
}

/** Finds an attribute on any endpoint of the node (sensors, battery). The lowest endpoint wins. */
export function findAttr(node: NodeView | undefined, cluster: number, attribute: number, ep?: number): unknown {
    if (!node) return undefined;
    if (ep !== undefined) return attr(node, ep, cluster, attribute);
    const suffix = `/${cluster}/${attribute}`;
    const keys = Object.keys(node.attributes)
        .filter(k => k.endsWith(suffix))
        .sort((a, b) => Number(a.split("/")[0]) - Number(b.split("/")[0]));
    return keys.length ? node.attributes[keys[0]] : undefined;
}

export function hasCluster(node: NodeView | undefined, ep: number, cluster: number): boolean {
    if (!node) return false;
    const prefix = `${ep}/${cluster}/`;
    return Object.keys(node.attributes).some(k => k.startsWith(prefix));
}

function num(v: unknown): number | undefined {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "bigint") return Number(v);
    return undefined;
}

function bool(v: unknown): boolean | undefined {
    return typeof v === "boolean" ? v : undefined;
}

export const pctTo254 = (pct: number): number => Math.round((pct * 254) / 100);
export const to100 = (v254: number): number => Math.round((v254 * 100) / 254);

/** A Matter bitmap may arrive as a number or as an object such as { occupied: true }. */
function bit0(v: unknown): boolean | undefined {
    if (typeof v === "number") return (v & 1) === 1;
    if (typeof v === "object" && v !== null) {
        const o = v as Record<string, unknown>;
        if (typeof o.occupied === "boolean") return o.occupied;
        if (typeof o["0"] === "boolean") return o["0"];
    }
    return undefined;
}

function setIf(out: Channels, key: string, value: boolean | number | string | undefined): void {
    if (value !== undefined) out[key] = value;
}

function nodeName(node: NodeView | undefined): string | undefined {
    const label = attr(node, 0, CLUSTER.BASIC, ATTR.BASIC_NODE_LABEL);
    return typeof label === "string" && label ? label : undefined;
}

function batteryPercent(node: NodeView | undefined): number | undefined {
    const raw = num(findAttr(node, CLUSTER.POWER_SOURCE, ATTR.POWER_BAT_PERCENT));
    return raw === undefined ? undefined : Math.round(raw / 2); // BatPercentRemaining is in half percent
}

// ---------------------------------------------------------------- Lights

export interface ColorTempRange {
    min: number;
    max: number;
}

export function colorTempRange(node: NodeView | undefined, ep: number): ColorTempRange | undefined {
    const min = num(attr(node, ep, CLUSTER.COLOR, ATTR.COLOR_TEMP_MIN));
    const max = num(attr(node, ep, CLUSTER.COLOR, ATTR.COLOR_TEMP_MAX));
    if (min === undefined || max === undefined || min <= 0 || max <= min) return undefined;
    return { min, max };
}

/** Level 0 = warmest = highest mireds, 100 = coolest = lowest mireds. */
export function ctLevelToMireds(level: number, range: ColorTempRange): number {
    return Math.round(range.max - (level * (range.max - range.min)) / 100);
}

export function miredsToCtLevel(mireds: number, range: ColorTempRange): number {
    const v = Math.round(((range.max - mireds) * 100) / (range.max - range.min));
    return Math.min(100, Math.max(0, v));
}

export function kelvinToMireds(kelvin: number, range?: ColorTempRange): number {
    let m = Math.round(1_000_000 / kelvin);
    if (range) m = Math.min(range.max, Math.max(range.min, m));
    return m;
}

/** One decimal, as a number: 2450 (0.01 C) -> 24.5. */
export function centiToC(v: number): number {
    return Math.round(v / 10) / 10;
}

export function lightChannels(n: string, slot: LightSlot, node: NodeView | undefined): Channels {
    const p = `light.${n}.`;
    const s: Channels = {};
    const ep = slot.endpoint;
    s[p + "name"] = slot.name ?? nodeName(node) ?? "";
    s[p + "online"] = Boolean(node?.available);
    if (!node) return s;

    const on = attr(node, ep, CLUSTER.ON_OFF, ATTR.ON_OFF);
    setIf(s, p + "on", bool(on));

    const level = num(attr(node, ep, CLUSTER.LEVEL, ATTR.LEVEL_CURRENT));
    if (on === false) s[p + "level"] = 0;
    else if (level !== undefined) s[p + "level"] = Math.max(1, to100(level));
    else if (on === true) s[p + "level"] = 100;

    const hue = num(attr(node, ep, CLUSTER.COLOR, ATTR.COLOR_HUE));
    if (hue !== undefined) s[p + "hue"] = to100(hue);
    const sat = num(attr(node, ep, CLUSTER.COLOR, ATTR.COLOR_SAT));
    if (sat !== undefined) s[p + "saturation"] = to100(sat);

    const mireds = num(attr(node, ep, CLUSTER.COLOR, ATTR.COLOR_TEMP_MIREDS));
    if (mireds !== undefined && mireds > 0) {
        s[p + "ct"] = Math.round(1_000_000 / mireds);
        const range = colorTempRange(node, ep);
        if (range) s[p + "ct_level"] = miredsToCtLevel(mireds, range);
    }
    return s;
}

// ---------------------------------------------------------------- Locks

export function lockChannels(n: string, slot: LockSlot, node: NodeView | undefined, jammed: boolean): Channels {
    const p = `lock.${n}.`;
    const s: Channels = {};
    s[p + "name"] = slot.name ?? nodeName(node) ?? "";
    s[p + "online"] = Boolean(node?.available);
    s[p + "jammed"] = jammed;
    if (!node) return s;
    const state = num(attr(node, slot.endpoint, CLUSTER.DOOR_LOCK, ATTR.LOCK_STATE));
    const name = state === undefined ? "Unknown" : (LOCK_STATE_NAMES[state] ?? "Unknown");
    s[p + "state"] = name;
    s[p + "locked"] = name === "Locked";
    setIf(s, p + "battery", batteryPercent(node));
    return s;
}

// ---------------------------------------------------------------- Sensors

export function sensorChannels(n: string, slot: SensorSlot, node: NodeView | undefined): Channels {
    const p = `sensor.${n}.`;
    const s: Channels = {};
    const ep = slot.endpoint;
    s[p + "name"] = slot.name ?? nodeName(node) ?? "";
    s[p + "online"] = Boolean(node?.available);
    if (!node) return s;

    setIf(s, p + "occupancy", bit0(findAttr(node, CLUSTER.OCCUPANCY, ATTR.MEASURED_VALUE, ep)));
    // BooleanState.StateValue: for a Contact Sensor, true = contact made = closed.
    setIf(s, p + "contact", bool(findAttr(node, CLUSTER.BOOLEAN_STATE, ATTR.MEASURED_VALUE, ep)));

    const t = num(findAttr(node, CLUSTER.TEMPERATURE, ATTR.MEASURED_VALUE, ep));
    if (t !== undefined) s[p + "temperature"] = centiToC(t);

    const h = num(findAttr(node, CLUSTER.HUMIDITY, ATTR.MEASURED_VALUE, ep));
    if (h !== undefined) s[p + "humidity"] = Math.round(h / 100);

    const lux = num(findAttr(node, CLUSTER.ILLUMINANCE, ATTR.MEASURED_VALUE, ep));
    if (lux !== undefined) s[p + "lux"] = lux <= 0 ? 0 : Math.round(10 ** ((lux - 1) / 10000));

    setIf(s, p + "battery", batteryPercent(node));
    return s;
}

// ---------------------------------------------------------------- HVAC (Thermostat + FanControl)

/** Thermostat cluster (513) attributes used by the bridge. */
export const TSTAT = {
    LOCAL_TEMP: 0,
    ABS_MIN_HEAT: 3,
    ABS_MAX_HEAT: 4,
    ABS_MIN_COOL: 5,
    ABS_MAX_COOL: 6,
    COOL_SETPOINT: 17,
    HEAT_SETPOINT: 18,
    MIN_HEAT: 21,
    MAX_HEAT: 22,
    MIN_COOL: 23,
    MAX_COOL: 24,
    SYSTEM_MODE: 28,
    RUNNING_STATE: 41,
    FEATURE_MAP: 65532,
} as const;

export const FAN_ATTR = { MODE: 0, PERCENT_CURRENT: 3 } as const;

/** Matter SystemMode -> hvac.N.mode name. */
export const SYSTEM_MODE_NAMES: Record<number, string> = {
    0: "Off",
    1: "Auto",
    3: "Cool",
    4: "Heat",
    5: "Heat", // EmergencyHeat
    6: "Cool", // Precooling
    7: "Fan",
    8: "Dry",
};

/** hvac.N.mode command (upper case) -> SystemMode. */
export const MODE_TO_SYSTEM: Record<string, number> = { OFF: 0, AUTO: 1, COOL: 3, HEAT: 4, FAN: 7, DRY: 8 };

/** Matter FanMode -> hvac.N.fan_mode name. */
export const FAN_MODE_NAMES: Record<number, string> = { 0: "Off", 1: "Low", 2: "Medium", 3: "High", 4: "On", 5: "Auto", 6: "Auto" };

/** hvac.N.fan_mode command (upper case) -> FanMode. */
export const FAN_TO_MODE: Record<string, number> = { OFF: 0, LOW: 1, MED: 2, MEDIUM: 2, HIGH: 3, ON: 4, AUTO: 5 };

const THERMOSTAT_FEATURE = { HEAT: 1, COOL: 2, AUTO: 32 } as const;

export function thermostatFeatures(node: NodeView | undefined, ep: number): { heat: boolean; cool: boolean; auto: boolean } {
    const f = num(attr(node, ep, CLUSTER.THERMOSTAT, TSTAT.FEATURE_MAP)) ?? 0;
    return { heat: (f & THERMOSTAT_FEATURE.HEAT) !== 0, cool: (f & THERMOSTAT_FEATURE.COOL) !== 0, auto: (f & THERMOSTAT_FEATURE.AUTO) !== 0 };
}

/** Active setpoint attribute: heating setpoint in Heat mode (or heat-only devices), else cooling setpoint (air conditioners). */
export function activeSetpointAttr(node: NodeView | undefined, ep: number): number {
    const mode = num(attr(node, ep, CLUSTER.THERMOSTAT, TSTAT.SYSTEM_MODE));
    const f = thermostatFeatures(node, ep);
    if (mode === 4 || mode === 5) return TSTAT.HEAT_SETPOINT;
    if (!f.cool && f.heat) return TSTAT.HEAT_SETPOINT;
    return TSTAT.COOL_SETPOINT;
}

/** Setpoint limits (0.01 C) for the given setpoint attribute. */
export function setpointLimits(node: NodeView | undefined, ep: number, spAttr: number): { min: number; max: number } {
    const heat = spAttr === TSTAT.HEAT_SETPOINT;
    const get = (a: number) => num(attr(node, ep, CLUSTER.THERMOSTAT, a));
    const min = get(heat ? TSTAT.MIN_HEAT : TSTAT.MIN_COOL) ?? get(heat ? TSTAT.ABS_MIN_HEAT : TSTAT.ABS_MIN_COOL) ?? 700;
    const max = get(heat ? TSTAT.MAX_HEAT : TSTAT.MAX_COOL) ?? get(heat ? TSTAT.ABS_MAX_HEAT : TSTAT.ABS_MAX_COOL) ?? 3500;
    return { min, max };
}

export function fanEndpoint(node: NodeView | undefined, slot: ThermostatSlot): number | undefined {
    if (slot.fan_endpoint !== undefined) return slot.fan_endpoint;
    if (!node) return undefined;
    const k = Object.keys(node.attributes).find(key => key.endsWith(`/${CLUSTER.FAN}/${FAN_ATTR.MODE}`));
    return k === undefined ? undefined : Number(k.split("/")[0]);
}

/** ThermostatRunningState (bitmap) -> hvac.N.action; derived from the mode when the attribute is missing. */
function hvacAction(node: NodeView, ep: number, modeName: string | undefined): string | undefined {
    const rs = num(attr(node, ep, CLUSTER.THERMOSTAT, TSTAT.RUNNING_STATE));
    if (rs !== undefined) {
        if (rs & 0b1001001) return "Heating"; // Heat, HeatStage2, AuxHeat: bits 0, 3, 6
        if (rs & 0b0010010) return "Cooling"; // Cool, CoolStage2: bits 1, 4
        if (rs & 0b0100100) return "Fan"; // Fan, FanStage2/3: bits 2, 5
        return "Idle";
    }
    switch (modeName) {
        case "Cool": return "Cooling";
        case "Heat": return "Heating";
        case "Fan": return "Fan";
        case "Dry": return "Dehumidifying";
        case "Off": return "Idle";
        default: return undefined;
    }
}

export function thermostatChannels(n: string, slot: ThermostatSlot, node: NodeView | undefined): Channels {
    const p = `hvac.${n}.`;
    const s: Channels = {};
    const ep = slot.endpoint;
    s[p + "name"] = slot.name ?? nodeName(node) ?? "";
    s[p + "online"] = Boolean(node?.available);
    if (!node) return s;
    const t = (a: number) => num(attr(node, ep, CLUSTER.THERMOSTAT, a));

    const local = t(TSTAT.LOCAL_TEMP);
    if (local !== undefined) s[p + "temperature"] = centiToC(local);

    const spAttr = activeSetpointAttr(node, ep);
    const sp = t(spAttr);
    if (sp !== undefined) s[p + "setpoint"] = centiToC(sp);
    const lim = setpointLimits(node, ep, spAttr);
    s[p + "setpoint_min"] = centiToC(lim.min);
    s[p + "setpoint_max"] = centiToC(lim.max);

    const mode = t(TSTAT.SYSTEM_MODE);
    const modeName = mode === undefined ? undefined : SYSTEM_MODE_NAMES[mode];
    if (modeName) {
        s[p + "mode"] = modeName;
        s[p + "on"] = modeName !== "Off";
    }
    setIf(s, p + "action", hvacAction(node, ep, modeName));

    const hum = num(findAttr(node, CLUSTER.HUMIDITY, ATTR.MEASURED_VALUE));
    if (hum !== undefined) s[p + "humidity"] = Math.round(hum / 100);

    const fep = fanEndpoint(node, slot);
    const fan = fep === undefined ? undefined : num(attr(node, fep, CLUSTER.FAN, FAN_ATTR.MODE));
    setIf(s, p + "fan_mode", fan === undefined ? undefined : FAN_MODE_NAMES[fan]);
    const pct = fep === undefined ? undefined : num(attr(node, fep, CLUSTER.FAN, FAN_ATTR.PERCENT_CURRENT));
    setIf(s, p + "fan_percent", pct);
    setIf(s, p + "fan", fanStage(fan, pct));
    return s;
}

/**
 * Fan stage 0 Off, 1 Low, 2 Medium, 3 High. FanMode On (4) -> 3. Auto/Smart has no stage of its own:
 * report the speed actually running, from PercentCurrent.
 */
export function fanStage(fanMode: number | undefined, percentCurrent: number | undefined): number | undefined {
    if (fanMode === undefined) return undefined;
    if (fanMode >= 0 && fanMode <= 3) return fanMode;
    if (fanMode === 4) return 3;
    if (percentCurrent === undefined) return undefined;
    if (percentCurrent <= 0) return 0;
    return percentCurrent <= 33 ? 1 : percentCurrent <= 67 ? 2 : 3; // same upper bounds as KNX fan_steps 33/67/100
}
