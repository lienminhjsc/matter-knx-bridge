// Neutral channel model between the bridge core and its front ends (KNX, admin).
// A channel is "<kind>.<slot>.<property>" (e.g. "light.1.on") or "system.<property>".
// Channel values are typed (boolean, number, string). Feedback channels are only updated from values
// reported by the device, never inferred from a command.

export type ChannelValue = boolean | number | string;
export type Channels = Record<string, ChannelValue>;

export type DeviceKind = "light" | "lock" | "sensor" | "hvac";
export type ValueType = "bool" | "number" | "string";

export interface ChannelSpec {
    type: ValueType;
    /** Accepts commands (Bridge.command). */
    cmd?: boolean;
    /** Publishes state (Bridge.onChange / Bridge.value). */
    fb?: boolean;
    /** Short description, used in docs and error messages. */
    doc: string;
}

/** Config section holding the slots of each device kind. */
export const CONFIG_SECTION = { light: "lights", lock: "locks", sensor: "sensors", hvac: "thermostats" } as const;
export type ConfigSection = (typeof CONFIG_SECTION)[DeviceKind];

const META: Record<string, ChannelSpec> = {
    name: { type: "string", fb: true, doc: "slot name from config, else the Matter NodeLabel" },
    online: { type: "bool", fb: true, doc: "node reachable via matter-server" },
    error: { type: "string", fb: true, doc: "last command error, empty when OK" },
};
const PENDING: ChannelSpec = { type: "bool", fb: true, doc: "true while a command waits for device confirmation" };
const REFRESH: ChannelSpec = { type: "bool", cmd: true, doc: "trigger: re-read the device attributes (any value)" };

export const CHANNELS: Record<DeviceKind, Record<string, ChannelSpec>> = {
    light: {
        ...META,
        pending: PENDING,
        refresh: REFRESH,
        on: { type: "bool", cmd: true, fb: true, doc: "OnOff.OnOff" },
        level: { type: "number", cmd: true, fb: true, doc: "0-100 %, 0 when off, >= 1 when on (LevelControl.CurrentLevel); 0 = off" },
        hue: { type: "number", cmd: true, fb: true, doc: "0-100 % (ColorControl.CurrentHue)" },
        saturation: { type: "number", cmd: true, fb: true, doc: "0-100 % (ColorControl.CurrentSaturation)" },
        ct: { type: "number", cmd: true, fb: true, doc: "colour temperature in Kelvin, clamped to the light range (ColorControl.ColorTemperatureMireds)" },
        ct_level: { type: "number", cmd: true, fb: true, doc: "colour temperature 0-100 %, 0 = warmest, 100 = coolest" },
    },
    lock: {
        ...META,
        pending: PENDING,
        refresh: REFRESH,
        state: { type: "string", fb: true, doc: "Locked | Unlocked | NotFullyLocked | Unlatched | Unknown (DoorLock.LockState)" },
        locked: { type: "bool", fb: true, doc: "LockState == Locked" },
        jammed: { type: "bool", fb: true, doc: "set by the DoorLockAlarm LockJammed event, cleared when the lock reports Locked or Unlocked" },
        battery: { type: "number", fb: true, doc: "0-100 % (PowerSource.BatPercentRemaining / 2)" },
        lock: { type: "bool", cmd: true, doc: "trigger: true = lockDoor (false is ignored)" },
        unlock: { type: "bool", cmd: true, doc: "trigger: true = unlockDoor, rejected unless unlock_enabled is true for this lock" },
    },
    sensor: {
        ...META,
        occupancy: { type: "bool", fb: true, doc: "OccupancySensing.Occupancy bit 0" },
        contact: { type: "bool", fb: true, doc: "BooleanState.StateValue, true = contact made = closed" },
        temperature: { type: "number", fb: true, doc: "degrees C, 0.1 resolution (TemperatureMeasurement)" },
        humidity: { type: "number", fb: true, doc: "% RH, integer (RelativeHumidityMeasurement)" },
        lux: { type: "number", fb: true, doc: "lux, integer (IlluminanceMeasurement)" },
        battery: { type: "number", fb: true, doc: "0-100 % (PowerSource.BatPercentRemaining / 2)" },
    },
    hvac: {
        ...META,
        pending: PENDING,
        refresh: REFRESH,
        temperature: { type: "number", fb: true, doc: "degrees C (Thermostat.LocalTemperature)" },
        humidity: { type: "number", fb: true, doc: "% RH from any endpoint of the node" },
        setpoint: { type: "number", cmd: true, fb: true, doc: "degrees C, active setpoint (heating in Heat mode, else cooling); commands 5-40, rounded to 0.5, clamped to device limits" },
        setpoint_min: { type: "number", fb: true, doc: "lower setpoint limit, degrees C" },
        setpoint_max: { type: "number", fb: true, doc: "upper setpoint limit, degrees C" },
        setpoint_step: { type: "bool", cmd: true, doc: "true = +1 C, false = -1 C (like DPT 1.007)" },
        mode: { type: "string", cmd: true, fb: true, doc: "Off | Heat | Cool | Auto | Dry | Fan (Thermostat.SystemMode)" },
        on: { type: "bool", cmd: true, fb: true, doc: "mode != Off; command true = Cool (Heat on heat-only devices), false = Off" },
        action: { type: "string", fb: true, doc: "Heating | Cooling | Fan | Dehumidifying | Idle (Thermostat.ThermostatRunningState, else derived from mode)" },
        fan: { type: "number", cmd: true, fb: true, doc: "fan stage 0 Off, 1 Low, 2 Medium, 3 High (FanControl.FanMode); in Auto shows the running speed" },
        fan_mode: { type: "string", cmd: true, fb: true, doc: "Off | Low | Medium | High | On | Auto (FanControl.FanMode)" },
        fan_percent: { type: "number", fb: true, doc: "FanControl.PercentCurrent" },
    },
};

export const SYSTEM_CHANNELS: Record<string, ChannelSpec> = {
    version: { type: "string", fb: true, doc: "bridge version" },
    error: { type: "string", fb: true, doc: "last bridge level error (unknown channel, unknown slot...)" },
    controller_online: { type: "bool", fb: true, doc: "connected to matter-server" },
    refresh: { type: "bool", cmd: true, doc: "trigger: re-read every configured node" },
};

export type ParsedChannel =
    | { kind: DeviceKind; slot: string; prop: string; spec: ChannelSpec | undefined }
    | { kind: "system"; slot?: undefined; prop: string; spec: ChannelSpec | undefined };

const DEVICE_RE = /^(light|lock|sensor|hvac)\.([1-9]\d{0,3})\.([a-z_]+)$/;
const SYSTEM_RE = /^system\.([a-z_]+)$/;

/** Splits a channel name. Returns undefined when the syntax is wrong; spec is undefined for unknown properties. */
export function parseChannel(channel: string): ParsedChannel | undefined {
    const d = DEVICE_RE.exec(channel);
    if (d) {
        const kind = d[1] as DeviceKind;
        return { kind, slot: d[2], prop: d[3], spec: CHANNELS[kind][d[3]] };
    }
    const s = SYSTEM_RE.exec(channel);
    if (s) return { kind: "system", prop: s[1], spec: SYSTEM_CHANNELS[s[1]] };
    return undefined;
}

export function channel(kind: DeviceKind, slot: string | number, prop: string): string {
    return `${kind}.${slot}.${prop}`;
}

/** Boolean from true/false, 0/1, "true"/"false", "on"/"off". */
export function toBool(v: ChannelValue | undefined): boolean | undefined {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v === 1 ? true : v === 0 ? false : undefined;
    if (typeof v === "string") {
        const s = v.trim().toLowerCase();
        if (s === "true" || s === "1" || s === "on") return true;
        if (s === "false" || s === "0" || s === "off") return false;
    }
    return undefined;
}

/** Finite number from a number or a numeric string (decimal comma accepted). */
export function toNum(v: ChannelValue | undefined): number | undefined {
    if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
    if (typeof v === "string" && v.trim() !== "") {
        const n = Number(v.trim().replace(",", "."));
        return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
}
