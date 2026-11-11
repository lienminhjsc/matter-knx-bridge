// Bridge core: turns channel commands into Matter commands, computes channel state from attributes,
// tracks pending/timeout per device and blocks unlock unless enabled.
// Feedback channels are only updated from values reported by the device, never inferred from a command.
import type { BridgeConfig, LightSlot, LockSlot, ThermostatSlot } from "./config.ts";
import type { MatterPort, NodeEventView } from "./matter.ts";
import {
    CLUSTER,
    colorTempRange,
    ctLevelToMireds,
    hasCluster,
    kelvinToMireds,
    lightChannels,
    lockChannels,
    pctTo254,
    sensorChannels,
    thermostatChannels,
    thermostatFeatures,
    activeSetpointAttr,
    setpointLimits,
    fanEndpoint,
    MODE_TO_SYSTEM,
    FAN_TO_MODE,
    TSTAT,
    FAN_ATTR,
} from "./mapping.ts";
import { CONFIG_SECTION, parseChannel, toBool, toNum, type ChannelValue, type Channels, type DeviceKind } from "./channels.ts";
import { log } from "./log.ts";

export const VERSION = "0.1.0";

export type ChangeListener = (channel: string, value: ChannelValue) => void;

const SETPOINT_STEP = 100; // 1 C, in 0.01 C
const DOOR_LOCK_ALARM_EVENT = 0; // DoorLock.DoorLockAlarm
const ALARM_LOCK_JAMMED = 0; // AlarmCode.LockJammed
const TIMED_MS = 10_000;

interface Pending {
    timer: NodeJS.Timeout;
    /** Returns true once the device state matches the expected result. */
    done: () => boolean;
}

/** 0-100 integer, undefined when invalid. */
function percent(v: ChannelValue): number | undefined {
    const n = toNum(v);
    if (n === undefined || n < 0 || n > 100) return undefined;
    return Math.round(n);
}

export class Bridge {
    #cfg: BridgeConfig;
    #matter: MatterPort;
    #values = new Map<string, ChannelValue>();
    #listeners: ChangeListener[] = [];
    #pending = new Map<string, Pending>(); // key: device prefix, e.g. "lock.1", "light.3"
    #jammed = new Map<string, boolean>();

    constructor(cfg: BridgeConfig, matter: MatterPort) {
        this.#cfg = cfg;
        this.#matter = matter;
        matter.onNodeChanged(id => this.#refreshNode(id));
        matter.onNodeEvent(e => this.#onNodeEvent(e));
        matter.onConnection(up => {
            this.#publish("system.controller_online", up);
            this.#publish("system.error", up ? "" : "matter-server disconnected");
            this.refreshAll();
        });
    }

    // ------------------------------------------------------------ State store

    /** Called on every channel value change (not on unchanged re-publishes). */
    onChange(cb: ChangeListener): void {
        this.#listeners.push(cb);
    }

    value(channel: string): ChannelValue | undefined {
        return this.#values.get(channel);
    }

    snapshot(): Channels {
        return Object.fromEntries(this.#values);
    }

    #publish(channel: string, value: ChannelValue): void {
        if (this.#values.get(channel) === value) return;
        this.#values.set(channel, value);
        for (const cb of this.#listeners) {
            try {
                cb(channel, value);
            } catch (e) {
                log.error("bridge", `listener failed for ${channel}: ${(e as Error).message}`);
            }
        }
    }

    #publishAll(channels: Channels): void {
        for (const [k, v] of Object.entries(channels)) this.#publish(k, v);
    }

    // ------------------------------------------------------------ Lifecycle

    /** Publishes the initial state (also before matter-server is connected). */
    init(): void {
        this.#publish("system.version", VERSION);
        this.#publish("system.error", "");
        this.#publish("system.controller_online", this.#matter.connected);
        for (const n of Object.keys(this.#cfg.locks)) {
            this.#publish(`lock.${n}.pending`, false);
            this.#publish(`lock.${n}.error`, "");
        }
        for (const n of Object.keys(this.#cfg.lights)) {
            this.#publish(`light.${n}.pending`, false);
            this.#publish(`light.${n}.error`, "");
        }
        for (const n of Object.keys(this.#cfg.sensors)) this.#publish(`sensor.${n}.error`, "");
        for (const n of Object.keys(this.#cfg.thermostats)) {
            this.#publish(`hvac.${n}.pending`, false);
            this.#publish(`hvac.${n}.error`, "");
        }
        this.refreshAll();
    }

    get config(): BridgeConfig {
        return this.#cfg;
    }

    /** Loads a new slot configuration while running (admin "Apply"). The Matter connection stays up. */
    setConfig(cfg: BridgeConfig): void {
        this.stop();
        this.#cfg = cfg;
        this.#jammed.clear();
        // Forget channels of slots that no longer exist (silently: nothing is bound to them any more).
        for (const ch of [...this.#values.keys()]) {
            const p = parseChannel(ch);
            if (p && p.kind !== "system" && !(p.slot in this.#cfg[CONFIG_SECTION[p.kind]])) this.#values.delete(ch);
        }
        this.init();
    }

    refreshAll(): void {
        for (const [n, slot] of Object.entries(this.#cfg.locks)) this.#publishLock(n, slot);
        for (const [n, slot] of Object.entries(this.#cfg.lights)) this.#publishLight(n, slot);
        for (const [n, slot] of Object.entries(this.#cfg.sensors)) {
            this.#publishAll(sensorChannels(n, slot, this.#matter.node(slot.node_id)));
        }
        for (const [n, slot] of Object.entries(this.#cfg.thermostats)) this.#publishThermostat(n, slot);
    }

    stop(): void {
        for (const p of this.#pending.values()) clearTimeout(p.timer);
        this.#pending.clear();
    }

    // ------------------------------------------------------------ Commands

    /**
     * Executes a command on a channel, e.g. command("light.1.level", 40).
     * Returns an error message when the command is rejected immediately (it is also published to the
     * device "error" channel, or to system.error for unknown channels/slots). Device confirmation is
     * asynchronous: watch the "pending" and "error" channels.
     */
    command(channel: string, value: ChannelValue): string | undefined {
        log.debug("cmd", `${channel} = ${String(value)}`);
        const p = parseChannel(channel);
        if (!p || !p.spec) return this.#sysError(`unknown channel ${channel}`);
        if (!p.spec.cmd) return this.#sysError(`channel ${channel} is read-only`);
        if (p.kind === "system") {
            if (p.prop === "refresh") this.#refreshAllFromDevices();
            return undefined;
        }
        if (!(p.slot in this.#cfg[CONFIG_SECTION[p.kind]])) return this.#sysError(`no ${p.kind} ${p.slot} in config`);
        if (p.prop === "refresh") return this.#refreshSlot(p.kind, p.slot);
        switch (p.kind) {
            case "lock": return this.#lockCommand(p.slot, p.prop, value);
            case "light": return this.#lightCommand(p.slot, p.prop, value);
            case "hvac": return this.#hvacCommand(p.slot, p.prop, value);
            default: return this.#sysError(`channel ${channel} is read-only`);
        }
    }

    #sysError(msg: string): string {
        this.#publish("system.error", msg);
        return msg;
    }

    #deviceError(key: string, msg: string): string {
        this.#publish(`${key}.error`, msg);
        return msg;
    }

    #refreshSlot(kind: DeviceKind, n: string): undefined {
        let read: Promise<void> | undefined;
        if (kind === "hvac") read = this.#matter.read(this.#cfg.thermostats[n].node_id, ["*/513/*", "*/514/*", "*/1029/*"]);
        if (kind === "lock") {
            const lock = this.#cfg.locks[n];
            read = this.#matter.read(lock.node_id, [`${lock.endpoint}/${CLUSTER.DOOR_LOCK}/*`]);
        }
        if (kind === "light") {
            const light = this.#cfg.lights[n];
            read = this.#matter.read(light.node_id, [`${light.endpoint}/*/*`]);
        }
        read?.catch(err => log.warn("refresh", `${kind}.${n}: ${(err as Error).message}`));
        return undefined;
    }

    #refreshAllFromDevices(): void {
        const nodes = new Set<number>();
        for (const s of [...Object.values(this.#cfg.locks), ...Object.values(this.#cfg.lights), ...Object.values(this.#cfg.sensors), ...Object.values(this.#cfg.thermostats)]) {
            nodes.add(s.node_id);
        }
        for (const id of nodes) {
            this.#matter.read(id, ["*/*/*"]).catch(err => log.warn("refresh", `node ${id}: ${(err as Error).message}`));
        }
        this.refreshAll();
    }

    // ------------------------------------------------------------ Locks

    #lockCommand(n: string, prop: string, value: ChannelValue): string | undefined {
        const slot = this.#cfg.locks[n];
        const key = `lock.${n}`;
        // lock/unlock are triggers: only "true" acts, anything else is ignored (a 0 telegram never unlocks).
        if (toBool(value) !== true) return undefined;
        const unlock = prop === "unlock";
        if (unlock && slot.unlock_enabled !== true) {
            log.warn("lock", `rejected unlock of lock ${n}: unlock_enabled = false`);
            return this.#deviceError(key, "unlock disabled");
        }
        const want = unlock ? 2 : 1; // LockState Unlocked / Locked
        const name = unlock ? "unlockDoor" : "lockDoor";
        log.info("lock", `lock ${n} (node ${slot.node_id}/${slot.endpoint}): ${name}`);
        return this.#send(key, slot.node_id, slot.endpoint, CLUSTER.DOOR_LOCK, name, {}, TIMED_MS, () => {
            const node = this.#matter.node(slot.node_id);
            return node?.attributes[`${slot.endpoint}/${CLUSTER.DOOR_LOCK}/0`] === want;
        });
    }

    #publishLock(n: string, slot: LockSlot): void {
        const node = this.#matter.node(slot.node_id);
        const channels = lockChannels(n, slot, node, this.#jammed.get(n) ?? false);
        this.#publishAll(channels);
        // Clear the jammed flag once the lock is back to Locked/Unlocked.
        const st = channels[`lock.${n}.state`];
        if ((st === "Locked" || st === "Unlocked") && this.#jammed.get(n)) {
            this.#jammed.set(n, false);
            this.#publish(`lock.${n}.jammed`, false);
        }
    }

    #onNodeEvent(e: NodeEventView): void {
        if (e.cluster_id !== CLUSTER.DOOR_LOCK || e.event_id !== DOOR_LOCK_ALARM_EVENT) return;
        const d = e.data as Record<string, unknown> | null;
        const code = d?.alarmCode ?? d?.AlarmCode ?? d?.["0"];
        if (code !== ALARM_LOCK_JAMMED) return;
        for (const [n, slot] of Object.entries(this.#cfg.locks)) {
            if (slot.node_id === e.node_id && slot.endpoint === e.endpoint_id) {
                log.warn("lock", `lock ${n} reported LockJammed`);
                this.#jammed.set(n, true);
                this.#publish(`lock.${n}.jammed`, true);
            }
        }
    }

    // ------------------------------------------------------------ Lights

    #lightCommand(n: string, prop: string, value: ChannelValue): string | undefined {
        const slot = this.#cfg.lights[n];
        const node = this.#matter.node(slot.node_id);
        const ep = slot.endpoint;
        const key = `light.${n}`;
        const err = (m: string) => this.#deviceError(key, m);
        // Always read the latest node: the gateway replaces the node object on every attribute report,
        // an old snapshot would never change.
        const a = (cluster: number, attr: number) => this.#matter.node(slot.node_id)?.attributes[`${ep}/${cluster}/${attr}`];
        const opts = { optionsMask: 0, optionsOverride: 0 };
        const onOff = (on: boolean) =>
            this.#send(key, slot.node_id, ep, CLUSTER.ON_OFF, on ? "on" : "off", {}, undefined, () => a(CLUSTER.ON_OFF, 0) === on);

        switch (prop) {
            case "on": {
                const on = toBool(value);
                if (on === undefined) return err(`bad on value ${String(value)}`);
                return onOff(on);
            }
            case "level": {
                const pct = percent(value);
                if (pct === undefined) return err(`bad level ${String(value)}`);
                if (pct === 0 || !hasCluster(node, ep, CLUSTER.LEVEL)) return onOff(pct > 0);
                const level = Math.max(1, pctTo254(pct));
                return this.#send(key, slot.node_id, ep, CLUSTER.LEVEL, "moveToLevelWithOnOff", { level, transitionTime: 0, ...opts }, undefined,
                    () => a(CLUSTER.ON_OFF, 0) === true && Math.abs(Number(a(CLUSTER.LEVEL, 0)) - level) <= 3);
            }
            case "hue":
            case "saturation": {
                const pct = percent(value);
                if (pct === undefined) return err(`bad ${prop} ${String(value)}`);
                if (!hasCluster(node, ep, CLUSTER.COLOR)) return err("no color control");
                const v = pctTo254(pct);
                const isHue = prop === "hue";
                return this.#send(key, slot.node_id, ep, CLUSTER.COLOR, isHue ? "moveToHue" : "moveToSaturation",
                    isHue ? { hue: v, direction: 0, transitionTime: 0, ...opts } : { saturation: v, transitionTime: 0, ...opts },
                    undefined, () => Math.abs(Number(a(CLUSTER.COLOR, isHue ? 0 : 1)) - v) <= 3);
            }
            case "ct":
            case "ct_level": {
                if (!hasCluster(node, ep, CLUSTER.COLOR)) return err("no color control");
                const range = colorTempRange(node, ep);
                let mireds: number;
                if (prop === "ct_level") {
                    const pct = percent(value);
                    if (pct === undefined) return err(`bad ct_level ${String(value)}`);
                    if (!range) return err("no color temperature range");
                    mireds = ctLevelToMireds(pct, range);
                } else {
                    const k = toNum(value);
                    if (k === undefined || k < 1000 || k > 20000) return err(`bad kelvin ${String(value)}`);
                    mireds = kelvinToMireds(Math.round(k), range);
                }
                return this.#send(key, slot.node_id, ep, CLUSTER.COLOR, "moveToColorTemperature",
                    { colorTemperatureMireds: mireds, transitionTime: 0, ...opts }, undefined,
                    () => Math.abs(Number(a(CLUSTER.COLOR, 7)) - mireds) <= 5);
            }
        }
        return err(`unknown light command ${prop}`);
    }

    #publishLight(n: string, slot: LightSlot): void {
        this.#publishAll(lightChannels(n, slot, this.#matter.node(slot.node_id)));
    }

    // ------------------------------------------------------------ HVAC

    #hvacCommand(n: string, prop: string, value: ChannelValue): string | undefined {
        const slot = this.#cfg.thermostats[n];
        const key = `hvac.${n}`;
        const err = (m: string) => this.#deviceError(key, m);
        const node = this.#matter.node(slot.node_id);
        const ep = slot.endpoint;
        const now = (path: string) => this.#matter.node(slot.node_id)?.attributes[path];

        const writeMode = (m: number, label: string) => {
            const f = thermostatFeatures(node, ep);
            if ((m === 4 && !f.heat) || (m === 3 && !f.cool) || (m === 1 && !f.auto)) return err(`mode ${label} not supported`);
            const path = `${ep}/${CLUSTER.THERMOSTAT}/${TSTAT.SYSTEM_MODE}`;
            return this.#write(key, slot.node_id, path, m, () => now(path) === m);
        };
        const writeFan = (v: number) => {
            const fep = fanEndpoint(node, slot);
            if (fep === undefined) return err("no fan control");
            const path = `${fep}/${CLUSTER.FAN}/${FAN_ATTR.MODE}`;
            // The device may turn On (4) into High: confirm on any mode other than Off/Auto.
            const done = v === 4 ? () => { const x = Number(now(path)); return x >= 1 && x <= 4; } : () => now(path) === v;
            return this.#write(key, slot.node_id, path, v, done);
        };

        switch (prop) {
            case "setpoint":
            case "setpoint_step": {
                const spAttr = activeSetpointAttr(node, ep);
                const path = `${ep}/${CLUSTER.THERMOSTAT}/${spAttr}`;
                const cur = Number(node?.attributes[path]);
                let target: number;
                if (prop === "setpoint") {
                    const c = toNum(value);
                    if (c === undefined || c < 5 || c > 40) return err(`bad setpoint ${String(value)}`);
                    target = Math.round(c * 2) * 50; // round to 0.5 C
                } else {
                    const up = toBool(value);
                    if (up === undefined) return err(`bad setpoint_step ${String(value)}`);
                    if (!Number.isFinite(cur)) return err("setpoint unknown");
                    target = cur + (up ? SETPOINT_STEP : -SETPOINT_STEP);
                }
                const lim = setpointLimits(node, ep, spAttr);
                target = Math.min(lim.max, Math.max(lim.min, target));
                return this.#write(key, slot.node_id, path, target, () => now(path) === target);
            }
            case "mode": {
                const label = String(value).trim().toUpperCase();
                const m = MODE_TO_SYSTEM[label];
                if (m === undefined) return err(`bad mode ${String(value)}`);
                return writeMode(m, label);
            }
            case "on": {
                const on = toBool(value);
                if (on === undefined) return err(`bad on value ${String(value)}`);
                if (!on) return writeMode(0, "OFF");
                // Matter Thermostat has no separate on/off: on = Cool (air conditioner), Heat on heat-only devices.
                const f = thermostatFeatures(node, ep);
                return !f.cool && f.heat ? writeMode(4, "HEAT") : writeMode(3, "COOL");
            }
            case "fan_mode": {
                const v = FAN_TO_MODE[String(value).trim().toUpperCase()];
                if (v === undefined) return err(`bad fan_mode ${String(value)}`);
                return writeFan(v);
            }
            case "fan": {
                // Stage 0 Off, 1 Low, 2 Medium, 3 High: same values as FanMode 0-3.
                const v = toNum(value);
                if (v === undefined || !Number.isInteger(v) || v < 0 || v > 3) return err(`bad fan ${String(value)}`);
                return writeFan(v);
            }
        }
        return err(`unknown hvac command ${prop}`);
    }

    #publishThermostat(n: string, slot: ThermostatSlot): void {
        this.#publishAll(thermostatChannels(n, slot, this.#matter.node(slot.node_id)));
    }

    // ------------------------------------------------------------ Common

    /** Sends a cluster command, sets pending, waits for matching state or timeout. */
    #send(key: string, nodeId: number, ep: number, cluster: number, name: string, payload: Record<string, unknown>,
        timedMs: number | undefined, done: () => boolean): string | undefined {
        return this.#run(key, name, done, () =>
            this.#matter.command(nodeId, ep, cluster, name, payload, { timedRequestTimeoutMs: timedMs, timeoutMs: this.#cfg.command_timeout_ms }));
    }

    /** Writes an attribute, sets pending, waits for matching state or timeout. */
    #write(key: string, nodeId: number, path: string, value: unknown, done: () => boolean): string | undefined {
        return this.#run(key, `write ${path}=${String(value)}`, done, () =>
            this.#matter.write(nodeId, path, value, { timeoutMs: this.#cfg.command_timeout_ms }));
    }

    #run(key: string, name: string, done: () => boolean, exec: () => Promise<void>): string | undefined {
        if (!this.#matter.connected) return this.#deviceError(key, "matter-server disconnected");
        this.#clearPending(key);
        this.#publish(`${key}.error`, "");
        this.#publish(`${key}.pending`, true);
        const timer = setTimeout(() => {
            if (!this.#pending.has(key)) return;
            this.#pending.delete(key);
            this.#publish(`${key}.pending`, false);
            this.#publish(`${key}.error`, "no confirmation from device");
            log.warn("cmd", `${key} ${name}: no confirming state within ${this.#cfg.pending_timeout_ms} ms`);
        }, this.#cfg.pending_timeout_ms);
        this.#pending.set(key, { timer, done });

        exec()
            .then(() => this.#checkPending(key))
            .catch((e: Error) => {
                this.#clearPending(key);
                this.#publish(`${key}.pending`, false);
                this.#publish(`${key}.error`, e.message.slice(0, 120));
                log.warn("cmd", `${key} ${name} failed: ${e.message}`);
            });
        return undefined;
    }

    #clearPending(key: string): void {
        const p = this.#pending.get(key);
        if (p) clearTimeout(p.timer);
        this.#pending.delete(key);
    }

    #checkPending(key: string): void {
        const p = this.#pending.get(key);
        if (p && p.done()) {
            this.#clearPending(key);
            this.#publish(`${key}.pending`, false);
        }
    }

    #refreshNode(nodeId: number): void {
        for (const [n, slot] of Object.entries(this.#cfg.locks)) {
            if (slot.node_id === nodeId) {
                this.#publishLock(n, slot);
                this.#checkPending(`lock.${n}`);
            }
        }
        for (const [n, slot] of Object.entries(this.#cfg.lights)) {
            if (slot.node_id === nodeId) {
                this.#publishLight(n, slot);
                this.#checkPending(`light.${n}`);
            }
        }
        for (const [n, slot] of Object.entries(this.#cfg.sensors)) {
            if (slot.node_id === nodeId) this.#publishAll(sensorChannels(n, slot, this.#matter.node(nodeId)));
        }
        for (const [n, slot] of Object.entries(this.#cfg.thermostats)) {
            if (slot.node_id === nodeId) {
                this.#publishThermostat(n, slot);
                this.#checkPending(`hvac.${n}`);
            }
        }
    }
}
