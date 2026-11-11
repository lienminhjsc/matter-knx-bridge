// Loads and validates the bridge config file (config.json).
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { validateKnx, type KnxConfig } from "./knx/gateway.ts";
import { parseChannel } from "./channels.ts";

/** Highest slot number per device kind. */
export const LIMITS = { locks: 64, lights: 255, sensors: 255, thermostats: 64 } as const;

export interface LockSlot {
    node_id: number;
    endpoint: number;
    name?: string;
    /** Default false: the bridge rejects lock.N.unlock. */
    unlock_enabled?: boolean;
}

export interface LightSlot {
    node_id: number;
    endpoint: number;
    name?: string;
}

export interface SensorSlot {
    node_id: number;
    /** Empty: take each value from any endpoint of the node that has the cluster. */
    endpoint?: number;
    name?: string;
}

export interface ThermostatSlot {
    node_id: number;
    /** Endpoint with the Thermostat cluster (513). */
    endpoint: number;
    /** Endpoint with FanControl (514). Empty: search all endpoints of the node. */
    fan_endpoint?: number;
    name?: string;
}

export interface AdminConfig {
    enabled: boolean;
    host: string;
    port: number;
    /** Basic auth password (user "admin"), at least 8 characters. Generated on first run when missing. */
    password: string;
    /** Admin project data (floors, rooms, assignments, exported GAs). */
    project_path: string;
    /** Admin unlock PIN (6 digits) as "scrypt$salt$hash". Set with npm run set-unlock-pin. Unset: no unlock from admin. */
    unlock_pin_hash?: string;
    /** Unlock audit log (JSON lines). */
    audit_path: string;
    /** Optional ES module exporting a GaPlanner (default export or "planner"). Unset: built-in planner. */
    planner_module?: string;
}

export interface BridgeConfig {
    matter_server: string;
    /** Time to wait for a confirming state after a command; then the device error channel is set. */
    pending_timeout_ms: number;
    /** Timeout of a single request to matter-server. */
    command_timeout_ms: number;
    locks: Record<string, LockSlot>;
    lights: Record<string, LightSlot>;
    sensors: Record<string, SensorSlot>;
    thermostats: Record<string, ThermostatSlot>;
    /** Optional: KNXnet/IP tunnelling server for KNX clients (visualisations, ETS, home automation controllers...). */
    knx?: KnxConfig;
    /** Optional: admin web app (port 2401). */
    admin?: AdminConfig;
}

function adminConfigFrom(raw: unknown, errors: string[]): AdminConfig | undefined {
    if (raw === undefined) return undefined;
    const a = raw as Partial<AdminConfig>;
    const out: AdminConfig = {
        enabled: a.enabled !== false,
        host: a.host ?? "0.0.0.0",
        port: a.port ?? 2401,
        password: a.password ?? "",
        project_path: a.project_path ?? "project.json",
        unlock_pin_hash: a.unlock_pin_hash,
        audit_path: a.audit_path ?? "unlock-audit.log",
        ...(a.planner_module !== undefined ? { planner_module: a.planner_module } : {}),
    };
    if (out.planner_module !== undefined && (typeof out.planner_module !== "string" || !out.planner_module.trim())) {
        errors.push("admin.planner_module: path to an ES module (string), or leave it out for the built-in planner");
    }
    if (out.unlock_pin_hash !== undefined && !/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(out.unlock_pin_hash)) {
        errors.push("admin.unlock_pin_hash: invalid format, set it again with npm run set-unlock-pin");
    }
    if (out.enabled && out.password.length < 8) errors.push("admin.password: at least 8 characters");
    return out;
}

const DEFAULTS: Omit<BridgeConfig, "locks" | "lights" | "sensors" | "thermostats" | "knx" | "admin"> = {
    matter_server: "ws://127.0.0.1:5580/ws",
    pending_timeout_ms: 10000,
    command_timeout_ms: 15000,
};

function isPositiveInt(v: unknown): v is number {
    return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function checkSlots<T extends { node_id: number; endpoint?: number }>(
    kind: keyof typeof LIMITS,
    raw: unknown,
    endpointRequired: boolean,
    errors: string[],
): Record<string, T> {
    if (raw === undefined) return {};
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        errors.push(`${kind}: must be an object { "1": {...}, "2": {...} }`);
        return {};
    }
    const out: Record<string, T> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const n = Number(key);
        if (!Number.isInteger(n) || n < 1 || n > LIMITS[kind] || String(n) !== key) {
            errors.push(`${kind}.${key}: slot must be an integer 1-${LIMITS[kind]}`);
            continue;
        }
        const slot = value as Record<string, unknown>;
        if (!isPositiveInt(slot?.node_id)) errors.push(`${kind}.${key}.node_id: must be a positive integer`);
        if (endpointRequired && !(typeof slot?.endpoint === "number" && Number.isInteger(slot.endpoint) && slot.endpoint >= 0)) {
            errors.push(`${kind}.${key}.endpoint: required, integer >= 0`);
        }
        if (kind === "locks" && slot?.unlock_enabled !== undefined && typeof slot.unlock_enabled !== "boolean") {
            errors.push(`${kind}.${key}.unlock_enabled: true or false`);
        }
        out[key] = slot as unknown as T;
    }
    return out;
}

/** A KNX command on lock.N.unlock is only allowed when that lock has unlock_enabled = true. */
function checkUnlockBindings(cfg: BridgeConfig, errors: string[]): void {
    for (const [i, o] of (cfg.knx?.objects ?? []).entries()) {
        const ch = typeof o.bind === "string" ? parseChannel(o.bind) : undefined;
        if (o.dir !== "cmd" || ch?.kind !== "lock" || ch.prop !== "unlock") continue;
        if (cfg.locks[ch.slot]?.unlock_enabled !== true) {
            errors.push(`knx.objects[${i}]: ${o.bind} needs locks.${ch.slot}.unlock_enabled = true`);
        }
    }
}

export function parseConfig(raw: unknown): BridgeConfig {
    const errors: string[] = [];
    if (typeof raw !== "object" || raw === null) throw new Error("config must be a JSON object");
    const r = raw as Record<string, unknown>;
    const cfg: BridgeConfig = {
        ...DEFAULTS,
        ...(r as Partial<BridgeConfig>),
        locks: checkSlots<LockSlot>("locks", r.locks, true, errors),
        lights: checkSlots<LightSlot>("lights", r.lights, true, errors),
        sensors: checkSlots<SensorSlot>("sensors", r.sensors, false, errors),
        thermostats: checkSlots<ThermostatSlot>("thermostats", r.thermostats, true, errors),
        knx: validateKnx(r.knx, errors),
        admin: adminConfigFrom(r.admin, errors),
    };
    checkUnlockBindings(cfg, errors);
    if (typeof cfg.matter_server !== "string" || !/^wss?:\/\//.test(cfg.matter_server)) errors.push("matter_server: ws:// or wss:// URL");
    if (!isPositiveInt(cfg.pending_timeout_ms)) errors.push("pending_timeout_ms: positive integer (ms)");
    if (!isPositiveInt(cfg.command_timeout_ms)) errors.push("command_timeout_ms: positive integer (ms)");
    if (errors.length) throw new Error("invalid config:\n  " + errors.join("\n  "));
    return cfg;
}

export function loadConfig(path: string): BridgeConfig {
    return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * First run: when the config has an enabled "admin" section without a password, generate a random one,
 * write it into the config file and return it (the caller prints it once). Never a built-in default.
 */
export function ensureAdminPassword(path: string): string | undefined {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const admin = raw.admin as Record<string, unknown> | undefined;
    if (!admin || typeof admin !== "object" || admin.enabled === false) return undefined;
    if (typeof admin.password === "string" && admin.password !== "") return undefined;
    const password = randomBytes(12).toString("base64url");
    admin.password = password;
    writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
    chmodSync(path, 0o600); // the mode option only applies when the file is created (cp config.example.json gives 0644)
    return password;
}
