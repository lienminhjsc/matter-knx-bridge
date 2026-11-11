// Binds KNX group addresses to bridge channels: a write on a "cmd" GA becomes Bridge.command(channel, value),
// a channel change is sent as GroupValue_Write on every "fb" GA bound to it.
// The bridge core (Matter, pending, unlock gating...) is untouched; this layer only translates.
// The object list can be replaced while running.
import { APCI, dpt1, dpt5001, dpt7, dpt9, dpt20, formatGroup, parseGroup, type GroupTelegram } from "./frames.ts";
import { KnxServer } from "./server.ts";
import { parseChannel, toBool, toNum, type ChannelValue } from "../channels.ts";
import { log } from "../log.ts";

/**
 * Value transforms between KNX and a channel:
 * - invert: negate a boolean (e.g. DPT 1.019 Window/Door 0 = closed while sensor.N.contact true = closed)
 * - fan_level: KNX 5.001 0-100 % <-> fan stage 0-3, using fan_steps (default 33/67/100 %).
 *   A fan GA using DPT 5.100 FanStage (0-3) needs no transform: the value is the stage.
 * - hvac_mode: DPT 20.105 HVACContrMode (0 Auto, 1 Heat, 3 Cool, 6 Off, 9 Fan only, 14 Dehumidify) <-> hvac.N.mode
 */
export type KnxTransform = "invert" | "fan_level" | "hvac_mode";

/** "cmd": KNX writes to the GA are sent to the channel. "fb": channel state is sent to the GA (and answers reads). */
export type KnxDirection = "cmd" | "fb";

export interface KnxObjectConfig {
    ga: string;
    /** "1.xxx", "5.001", "5.xxx" (1 byte unsigned, e.g. 5.010, 5.100), "7.xxx", "9.xxx", "20.105" */
    dpt: string;
    /** Bridge channel, e.g. "light.1.on", "hvac.2.setpoint". */
    bind: string;
    dir: KnxDirection;
    transform?: KnxTransform;
    /** fan_level: % for Low / Medium / High, ascending, 1-100. Default [33, 67, 100]. */
    fan_steps?: [number, number, number];
    /** GA name for logs / bus monitor. */
    name?: string;
}

export interface KnxConfig {
    enabled: boolean;
    port?: number;
    host_ip?: string;
    friendly_name: string;
    individual_address: string;
    /** Address of the first tunnel; further tunnels count up within the same line. */
    tunnel_address: string;
    /** Maximum concurrent tunnels (one per KNX client: visualisation, ETS...). */
    max_tunnels?: number;
    objects: KnxObjectConfig[];
}

type Family = "1" | "5.001" | "5" | "7" | "9" | "20";

export function dptFamily(dpt: string): Family | undefined {
    if (/^1\.\d{3}$/.test(dpt)) return "1";
    if (dpt === "5.001") return "5.001";
    if (/^5\.\d{3}$/.test(dpt)) return "5";
    if (/^7\.\d{3}$/.test(dpt)) return "7";
    if (/^9\.\d{3}$/.test(dpt)) return "9";
    if (/^20\.\d{3}$/.test(dpt)) return "20";
    return undefined;
}

const MODE_TO_KNX: Record<string, number> = { Auto: 0, Heat: 1, Cool: 3, Off: 6, Fan: 9, Dry: 14 };
const KNX_TO_MODE: Record<number, string> = { 0: "AUTO", 1: "HEAT", 3: "COOL", 6: "OFF", 9: "FAN", 14: "DRY" };
export const DEFAULT_FAN_STEPS: [number, number, number] = [33, 67, 100];

/** Stage 0-3 -> % using fan_steps. */
export function levelToPct(level: number, steps: readonly number[] = DEFAULT_FAN_STEPS): number {
    const l = Math.max(0, Math.min(3, Math.round(level)));
    return l === 0 ? 0 : steps[l - 1];
}

/**
 * % -> stage 0-3. fan_steps are the upper bound of each stage (like KNX fan coil actuators):
 * 0 Off, (0, s1] Low, (s1, s2] Medium, > s2 High. Inverse of levelToPct (67 % maps back to Medium).
 */
export function pctToLevel(pct: number, steps: readonly number[] = DEFAULT_FAN_STEPS): number {
    if (pct <= 0) return 0;
    if (pct <= steps[0]) return 1;
    if (pct <= steps[1]) return 2;
    return 3;
}

export function validateKnx(raw: unknown, errors: string[]): KnxConfig | undefined {
    if (raw === undefined) return undefined;
    const k = raw as Partial<KnxConfig>;
    const out: KnxConfig = {
        enabled: k.enabled !== false,
        port: k.port,
        host_ip: k.host_ip,
        friendly_name: k.friendly_name ?? "Matter Bridge",
        individual_address: k.individual_address ?? "15.15.250",
        tunnel_address: k.tunnel_address ?? "15.15.240",
        max_tunnels: k.max_tunnels ?? 8,
        objects: Array.isArray(k.objects) ? k.objects : [],
    };
    const ta = out.tunnel_address.split(".").map(Number);
    if (ta.length !== 3 || ta.some(n => !Number.isInteger(n)) || ta[2] + (out.max_tunnels ?? 8) - 1 > 255) {
        errors.push(`knx.tunnel_address ${out.tunnel_address} + max_tunnels ${out.max_tunnels} goes past .255 of the line`);
    }
    if (!Number.isInteger(out.max_tunnels) || (out.max_tunnels as number) < 1 || (out.max_tunnels as number) > 32) {
        errors.push("knx.max_tunnels: 1-32");
    }
    errors.push(...validateObjects(out.objects));
    return out;
}

export function validateObjects(objects: KnxObjectConfig[]): string[] {
    const errors: string[] = [];
    for (const [i, o] of objects.entries()) {
        const at = `knx.objects[${i}]`;
        try {
            parseGroup(o.ga);
        } catch (e) {
            errors.push(`${at}.ga: ${(e as Error).message}`);
        }
        const fam = dptFamily(o.dpt);
        if (!fam) errors.push(`${at}.dpt ${o.dpt}: only 1.x, 5.x, 7.x, 9.x, 20.x are supported`);
        if (o.dir !== "cmd" && o.dir !== "fb") errors.push(`${at}.dir: "cmd" or "fb"`);
        const ch = typeof o.bind === "string" ? parseChannel(o.bind) : undefined;
        if (!ch || !ch.spec) {
            errors.push(`${at}.bind: unknown channel ${String(o.bind)}`);
            continue;
        }
        if (o.dir === "cmd" && !ch.spec.cmd) errors.push(`${at}: ${o.bind} does not accept commands`);
        if (o.dir === "fb" && !ch.spec.fb) errors.push(`${at}: ${o.bind} has no feedback`);
        const isMode = ch.kind === "hvac" && ch.prop === "mode";
        if (ch.spec.type === "bool" && fam && fam !== "1") errors.push(`${at}: boolean channel ${o.bind} needs DPT 1.x`);
        if (ch.spec.type === "number" && (fam === "1" || fam === "20")) errors.push(`${at}: numeric channel ${o.bind} cannot use DPT ${o.dpt}`);
        if (ch.spec.type === "string" && !isMode) errors.push(`${at}: text channel ${o.bind} cannot be bound to KNX`);
        if (isMode && (fam !== "20" || o.transform !== "hvac_mode")) errors.push(`${at}: ${o.bind} needs DPT 20.105 with transform hvac_mode`);
        if (o.transform !== undefined && !["invert", "fan_level", "hvac_mode"].includes(o.transform)) errors.push(`${at}.transform ${String(o.transform)}: unknown`);
        if (o.transform === "invert" && fam !== "1") errors.push(`${at}: invert only applies to DPT 1.x`);
        if (o.transform === "hvac_mode" && !isMode) errors.push(`${at}: hvac_mode only applies to hvac.N.mode`);
        if (o.transform === "fan_level" && (fam !== "5.001" || ch.kind !== "hvac" || ch.prop !== "fan")) {
            errors.push(`${at}: fan_level only applies to hvac.N.fan with DPT 5.001 (a 0-3 stage GA uses 5.100 without transform)`);
        }
        if (o.fan_steps !== undefined) {
            const st = o.fan_steps;
            const ok = Array.isArray(st) && st.length === 3 && st.every(Number.isFinite) && st[0] >= 1 && st[0] < st[1] && st[1] < st[2] && st[2] <= 100;
            if (!ok) errors.push(`${at}.fan_steps: 3 ascending numbers within 1-100, e.g. [33, 67, 100]`);
        }
    }
    return errors;
}

/** Channel value -> value sent on KNX. undefined: nothing to send. */
export function encodeValue(o: KnxObjectConfig, value: ChannelValue): number | Buffer | undefined {
    const fam = dptFamily(o.dpt);
    if (fam === "1") {
        let b = toBool(value);
        if (b === undefined) return undefined;
        if (o.transform === "invert") b = !b;
        return dpt1.encode(b);
    }
    if (fam === "20") {
        if (o.transform === "hvac_mode") {
            const n = MODE_TO_KNX[String(value)];
            return n === undefined ? undefined : dpt20.encode(n);
        }
        const n = toNum(value);
        return n === undefined ? undefined : dpt20.encode(n);
    }
    let n = toNum(value);
    if (n === undefined) return undefined;
    if (o.transform === "fan_level") n = levelToPct(n, o.fan_steps);
    if (fam === "5.001") return dpt5001.encode(n);
    if (fam === "5") return Buffer.from([Math.max(0, Math.min(255, Math.round(n)))]);
    if (fam === "7") return dpt7.encode(n);
    if (fam === "9") return dpt9.encode(n);
    return undefined;
}

/** KNX write telegram -> channel command value. undefined: cannot decode. */
export function decodeTelegram(o: KnxObjectConfig, t: GroupTelegram): ChannelValue | undefined {
    const fam = dptFamily(o.dpt);
    if (fam === "1") {
        const on = dpt1.decode(t);
        if (on === undefined) return undefined;
        return o.transform === "invert" ? !on : on;
    }
    if (fam === "5.001") {
        const pct = dpt5001.decode(t);
        if (pct === undefined) return undefined;
        return o.transform === "fan_level" ? pctToLevel(pct, o.fan_steps) : pct;
    }
    if (fam === "5") return t.data.length >= 1 ? t.data[0] : undefined;
    if (fam === "7") return dpt7.decode(t);
    if (fam === "9") {
        const n = dpt9.decode(t);
        return n === undefined ? undefined : Math.round(n * 10) / 10;
    }
    if (fam === "20") {
        const n = dpt20.decode(t);
        if (n === undefined) return undefined;
        return o.transform === "hvac_mode" ? KNX_TO_MODE[n] : n;
    }
    return undefined;
}

export interface KnxGatewayDeps {
    /** Sends a command to the bridge (Bridge.command). */
    command: (channel: string, value: ChannelValue) => void;
    /** Current channel value (Bridge.value). */
    value: (channel: string) => ChannelValue | undefined;
}

interface Obj {
    ga: number;
    cfg: KnxObjectConfig;
}

export class KnxGateway {
    #server: KnxServer;
    /** Command GA -> objects (one GA may drive several channels, like a KNX group). */
    #cmd = new Map<number, Obj[]>();
    #byChannel = new Map<string, Obj[]>();
    /** Feedback GA -> object answering GroupValue_Read (first one bound). */
    #status = new Map<number, Obj>();
    #deps: KnxGatewayDeps;

    constructor(cfg: KnxConfig, deps: KnxGatewayDeps) {
        this.#deps = deps;
        this.setObjects(cfg.objects);
        this.#server = new KnxServer({
            hostIp: cfg.host_ip,
            port: cfg.port,
            friendlyName: cfg.friendly_name,
            individualAddress: cfg.individual_address,
            tunnelAddress: cfg.tunnel_address,
            maxTunnels: cfg.max_tunnels,
            onGroupWrite: (ga, t) => this.#onWrite(ga, t),
            onGroupRead: ga => this.#onRead(ga),
        });
    }

    get server(): KnxServer {
        return this.#server;
    }

    /** Replaces the whole object list; open tunnels stay connected. */
    setObjects(objects: KnxObjectConfig[]): void {
        this.#cmd.clear();
        this.#byChannel.clear();
        this.#status.clear();
        for (const c of objects) {
            const o = { ga: parseGroup(c.ga), cfg: c };
            if (c.dir === "cmd") this.#cmd.set(o.ga, [...(this.#cmd.get(o.ga) ?? []), o]);
            if (c.dir === "fb") {
                if (!this.#status.has(o.ga)) this.#status.set(o.ga, o);
                this.#byChannel.set(c.bind, [...(this.#byChannel.get(c.bind) ?? []), o]);
            }
        }
    }

    /** Sends the current value of every feedback GA (after loading new objects). */
    pushAll(): void {
        for (const objs of this.#byChannel.values()) {
            for (const o of objs) {
                const v = this.#deps.value(o.cfg.bind);
                if (v === undefined) continue;
                const enc = encodeValue(o.cfg, v);
                if (enc !== undefined) this.#server.sendGroup(o.ga, APCI.WRITE, enc);
            }
        }
    }

    listen(): Promise<void> {
        return this.#server.listen();
    }

    close(): Promise<void> {
        return this.#server.close();
    }

    /** Called on every channel change: sends GroupValue_Write on the bound feedback GAs. */
    channelChanged(channel: string, value: ChannelValue): void {
        for (const o of this.#byChannel.get(channel) ?? []) {
            const v = encodeValue(o.cfg, value);
            if (v === undefined) continue;
            log.debug("knx", `${channel}=${String(value)} -> ${o.cfg.ga}`);
            this.#server.sendGroup(o.ga, APCI.WRITE, v);
        }
    }

    #onRead(ga: number): number | Buffer | undefined {
        const o = this.#status.get(ga);
        if (!o) return undefined;
        const v = this.#deps.value(o.cfg.bind);
        return v === undefined ? undefined : encodeValue(o.cfg, v);
    }

    #onWrite(ga: number, t: GroupTelegram): void {
        for (const o of this.#cmd.get(ga) ?? []) {
            const value = decodeTelegram(o.cfg, t);
            if (value === undefined) {
                log.warn("knx", `${formatGroup(ga)}: cannot decode value (DPT ${o.cfg.dpt})`);
                continue;
            }
            log.info("knx", `${formatGroup(ga)} -> ${o.cfg.bind} = ${String(value)}`);
            this.#deps.command(o.cfg.bind, value);
        }
    }
}
