// Bridge core tests against a fake Matter controller (no devices). Run: npm test
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAdminPassword, parseConfig, type BridgeConfig } from "../src/config.ts";
import { Bridge } from "../src/bridge.ts";
import type { CommandOptions, MatterPort, NodeEventView } from "../src/matter.ts";
import type { NodeView } from "../src/mapping.ts";
import { lightChannels, sensorChannels, ctLevelToMireds, miredsToCtLevel } from "../src/mapping.ts";
import { parseChannel, toBool, toNum, type ChannelValue } from "../src/channels.ts";
import { log } from "../src/log.ts";

log.setLevel("error");

interface SentCommand {
    nodeId: number;
    endpoint: number;
    cluster: number;
    name: string;
    payload?: Record<string, unknown>;
    opts?: CommandOptions;
}

/** Fake Matter: keeps nodes in memory, records commands, lets the test "report" attributes. */
class FakeMatter implements MatterPort {
    connected = true;
    nodes = new Map<number, NodeView>();
    sent: SentCommand[] = [];
    failNext: string | undefined;
    reads: Array<{ nodeId: number; paths: string[] }> = [];
    #nodeCbs: Array<(id: number) => void> = [];
    #eventCbs: Array<(e: NodeEventView) => void> = [];
    #connCbs: Array<(c: boolean) => void> = [];
    start(): void {}
    stop(): void {}
    node(id: number) {
        return this.nodes.get(id);
    }
    listNodes() {
        return [...this.nodes.values()];
    }
    async command(nodeId: number, endpoint: number, cluster: number, name: string, payload?: Record<string, unknown>, opts?: CommandOptions) {
        this.sent.push({ nodeId, endpoint, cluster, name, payload, opts });
        if (this.failNext) {
            const m = this.failNext;
            this.failNext = undefined;
            throw new Error(m);
        }
    }
    writes: Array<{ nodeId: number; path: string; value: unknown }> = [];
    async write(nodeId: number, path: string, value: unknown) {
        this.writes.push({ nodeId, path, value });
        if (this.failNext) {
            const m = this.failNext;
            this.failNext = undefined;
            throw new Error(m);
        }
    }
    async read(nodeId: number, paths: string[]): Promise<void> {
        this.reads.push({ nodeId, paths });
    }
    onNodeChanged(cb: (id: number) => void) {
        this.#nodeCbs.push(cb);
    }
    onNodeEvent(cb: (e: NodeEventView) => void) {
        this.#eventCbs.push(cb);
    }
    onConnection(cb: (c: boolean) => void) {
        this.#connCbs.push(cb);
    }
    /** The device reports new attribute values. */
    report(nodeId: number, attrs: Record<string, unknown>) {
        // Replace the node object like the real MatterGateway (never mutate the old one), to catch stale snapshots.
        const old = this.nodes.get(nodeId)!;
        this.nodes.set(nodeId, { ...old, attributes: { ...old.attributes, ...attrs } });
        for (const cb of this.#nodeCbs) cb(nodeId);
    }
    emitEvent(e: NodeEventView) {
        for (const cb of this.#eventCbs) cb(e);
    }
    setConnected(c: boolean) {
        this.connected = c;
        for (const cb of this.#connCbs) cb(c);
    }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Waits until the channel has the value (now or later). */
async function waitFor(bridge: Bridge, channel: string, value: ChannelValue, timeoutMs = 2000): Promise<void> {
    const t0 = Date.now();
    while (bridge.value(channel) !== value) {
        if (Date.now() - t0 > timeoutMs) throw new Error(`${channel} never became ${JSON.stringify(value)}, it is ${JSON.stringify(bridge.value(channel))}`);
        await sleep(5);
    }
}

/** Records every change, to check values that are set and cleared quickly. */
function recorder(bridge: Bridge) {
    const seen: string[] = [];
    bridge.onChange((ch, v) => seen.push(`${ch}=${String(v)}`));
    return {
        seen,
        async waitSeen(entry: string, timeoutMs = 2000) {
            const t0 = Date.now();
            while (!seen.includes(entry)) {
                if (Date.now() - t0 > timeoutMs) throw new Error(`no change ${entry}; last: ${seen.slice(-15).join(" | ")}`);
                await sleep(5);
            }
        },
        clear() {
            seen.length = 0;
        },
    };
}

function makeConfig(over: Record<string, unknown> = {}): BridgeConfig {
    return parseConfig({
        pending_timeout_ms: 300,
        locks: {
            "1": { node_id: 10, endpoint: 1, name: "Front door" },
            "2": { node_id: 11, endpoint: 1, unlock_enabled: true },
        },
        lights: {
            "1": { node_id: 5, endpoint: 1, name: "Living room light" },
            "2": { node_id: 20, endpoint: 1 },
        },
        sensors: { "1": { node_id: 30 } },
        thermostats: { "1": { node_id: 40, endpoint: 1, name: "Bedroom AC" } },
        ...over,
    });
}

function seedNodes(m: FakeMatter) {
    m.nodes.set(5, { node_id: 5, available: true, attributes: { "0/40/5": "Switch 4CH", "1/6/0": false } });
    m.nodes.set(20, {
        node_id: 20,
        available: true,
        attributes: {
            "1/6/0": true, "1/8/0": 127, "1/768/0": 127, "1/768/1": 254,
            "1/768/7": 370, "1/768/16395": 153, "1/768/16396": 500,
        },
    });
    m.nodes.set(10, { node_id: 10, available: true, attributes: { "1/257/0": 2, "0/47/12": 160 } });
    m.nodes.set(11, { node_id: 11, available: true, attributes: { "1/257/0": 1 } });
    m.nodes.set(30, {
        node_id: 30,
        available: true,
        attributes: { "1/1030/0": 1, "2/1026/0": 2850, "2/1029/0": 4800, "3/1024/0": 20001, "4/69/0": true, "0/47/12": 200 },
    });
    // Typical Wi-Fi AC controller: Heat + Cool, no Auto, 16-32 C, fan on endpoint 2, humidity on endpoint 3.
    m.nodes.set(40, {
        node_id: 40,
        available: true,
        attributes: {
            "1/513/65532": 3, "1/513/0": 3000, "1/513/17": 2400, "1/513/18": 2400, "1/513/28": 0,
            "1/513/21": 1600, "1/513/22": 3200, "1/513/23": 1600, "1/513/24": 3200,
            "2/514/0": 2, "2/514/3": 40, "3/1029/0": 5800,
        },
    });
}

describe("bridge: lights, locks, sensors", () => {
    let matter: FakeMatter;
    let bridge: Bridge;
    let rec: ReturnType<typeof recorder>;

    before(() => {
        matter = new FakeMatter();
        seedNodes(matter);
        bridge = new Bridge(makeConfig(), matter);
        rec = recorder(bridge);
        bridge.init();
    });

    after(() => bridge.stop());

    beforeEach(() => {
        matter.sent = [];
        matter.writes = [];
        matter.reads = [];
        rec.clear();
    });

    test("init publishes system and device channels with typed values", () => {
        const s = bridge.snapshot();
        assert.equal(s["system.version"], "0.1.0");
        assert.equal(s["system.controller_online"], true);
        assert.equal(s["light.1.name"], "Living room light");
        assert.equal(s["light.2.name"], "", "no slot name and no NodeLabel");
        assert.equal(s["lock.1.name"], "Front door");
        assert.equal(s["light.1.on"], false);
        assert.equal(s["light.1.level"], 0);
        assert.equal(s["light.1.pending"], false);
        assert.equal(s["light.2.level"], 50);
        assert.equal(s["lock.1.locked"], false);
        assert.equal(s["lock.1.state"], "Unlocked");
    });

    test("light.1.on sends OnOff.on; state only changes when the device reports", async () => {
        assert.equal(bridge.command("light.1.on", true), undefined);
        await waitFor(bridge, "light.1.pending", true);
        assert.deepEqual(matter.sent.map(s => [s.nodeId, s.endpoint, s.cluster, s.name]), [[5, 1, 6, "on"]]);
        assert.equal(bridge.value("light.1.on"), false, "state is never inferred from the command");
        matter.report(5, { "1/6/0": true });
        await waitFor(bridge, "light.1.on", true);
        await waitFor(bridge, "light.1.pending", false);
        await waitFor(bridge, "light.1.level", 100); // no LevelControl
        await sleep(400); // past pending_timeout_ms
        assert.equal(bridge.value("light.1.error"), "", "a confirmed command must not report no confirmation");
    });

    test("light.2.level 40 sends moveToLevelWithOnOff level 102", async () => {
        bridge.command("light.2.level", 40);
        await waitFor(bridge, "light.2.pending", true);
        assert.equal(matter.sent[0].name, "moveToLevelWithOnOff");
        assert.equal(matter.sent[0].payload?.level, 102);
        matter.report(20, { "1/8/0": 102 });
        await waitFor(bridge, "light.2.level", 40);
        await waitFor(bridge, "light.2.pending", false);
    });

    test("level 0 sends off; a light without LevelControl turns on for level > 0", async () => {
        bridge.command("light.2.level", 0);
        await sleep(30);
        assert.equal(matter.sent[0].name, "off");
        matter.report(20, { "1/6/0": false });
        await waitFor(bridge, "light.2.level", 0);
        bridge.command("light.1.level", "50");
        await sleep(30);
        assert.equal(matter.sent[1].name, "on");
    });

    test("bad values are rejected without a Matter command", () => {
        assert.equal(bridge.command("light.2.level", 101), "bad level 101");
        assert.equal(bridge.value("light.2.error"), "bad level 101");
        assert.equal(bridge.command("light.2.on", "maybe"), "bad on value maybe");
        assert.equal(matter.sent.length, 0);
    });

    test("hue/saturation 0-100 map to 0-254", async () => {
        bridge.command("light.2.hue", 50);
        bridge.command("light.2.saturation", 100);
        await sleep(30);
        assert.equal(matter.sent[0].name, "moveToHue");
        assert.equal(matter.sent[0].payload?.hue, 127);
        assert.equal(matter.sent[1].name, "moveToSaturation");
        assert.equal(matter.sent[1].payload?.saturation, 254);
    });

    test("ct_level: 0 = warmest (max mireds), 100 = coolest (min mireds)", async () => {
        bridge.command("light.2.ct_level", 0);
        await sleep(30);
        bridge.command("light.2.ct_level", 100);
        await sleep(30);
        assert.equal(matter.sent[0].payload?.colorTemperatureMireds, 500);
        assert.equal(matter.sent[1].payload?.colorTemperatureMireds, 153);
        matter.report(20, { "1/768/7": 500 });
        await waitFor(bridge, "light.2.ct_level", 0);
        await waitFor(bridge, "light.2.ct", 2000);
    });

    test("ct in Kelvin is clamped to the light range", async () => {
        bridge.command("light.2.ct", 2700);
        bridge.command("light.2.ct", 10000);
        await sleep(30);
        assert.equal(matter.sent[0].payload?.colorTemperatureMireds, 370);
        assert.equal(matter.sent[1].payload?.colorTemperatureMireds, 153);
    });

    test("light without ColorControl: hue reports an error, nothing is sent", async () => {
        bridge.command("light.1.hue", 10);
        await waitFor(bridge, "light.1.error", "no color control");
        assert.equal(matter.sent.length, 0);
    });

    test("unlock is blocked when unlock_enabled = false", async () => {
        assert.equal(bridge.command("lock.1.unlock", true), "unlock disabled");
        await waitFor(bridge, "lock.1.error", "unlock disabled");
        assert.equal(matter.sent.length, 0, "no unlock command may be sent");
    });

    test("lock/unlock are triggers: false is ignored (a 0 telegram never unlocks)", async () => {
        bridge.command("lock.2.unlock", false);
        bridge.command("lock.2.lock", false);
        bridge.command("lock.2.unlock", 0);
        await sleep(30);
        assert.equal(matter.sent.length, 0);
    });

    test("lock is a timed command, state follows the reported LockState", async () => {
        bridge.command("lock.1.lock", true);
        await waitFor(bridge, "lock.1.pending", true);
        assert.equal(matter.sent[0].name, "lockDoor");
        assert.equal(matter.sent[0].cluster, 257);
        assert.ok(matter.sent[0].opts?.timedRequestTimeoutMs, "lockDoor needs timedRequestTimeoutMs");
        assert.equal(bridge.value("lock.1.locked"), false);
        matter.report(10, { "1/257/0": 1 });
        await waitFor(bridge, "lock.1.locked", true);
        await waitFor(bridge, "lock.1.state", "Locked");
        await waitFor(bridge, "lock.1.pending", false);
    });

    test("unlock runs when unlock_enabled = true", async () => {
        bridge.command("lock.2.unlock", true);
        await sleep(30);
        assert.equal(matter.sent[0]?.name, "unlockDoor");
        matter.report(11, { "1/257/0": 2 });
        await waitFor(bridge, "lock.2.state", "Unlocked");
    });

    test("no confirmation within pending_timeout_ms reports an error", async () => {
        bridge.command("lock.2.lock", true);
        await waitFor(bridge, "lock.2.pending", true);
        await waitFor(bridge, "lock.2.error", "no confirmation from device", 1500);
        await waitFor(bridge, "lock.2.pending", false);
    });

    test("matter-server command errors go to the error channel", async () => {
        matter.failNext = "UnsupportedCommand";
        bridge.command("light.2.on", true);
        await waitFor(bridge, "light.2.error", "UnsupportedCommand");
        await waitFor(bridge, "light.2.pending", false);
    });

    test("LockJammed event sets lock.N.jammed, Locked/Unlocked clears it", async () => {
        matter.emitEvent({ node_id: 10, endpoint_id: 1, cluster_id: 257, event_id: 0, data: { alarmCode: 0 } });
        await waitFor(bridge, "lock.1.jammed", true);
        matter.report(10, { "1/257/0": 2 });
        await waitFor(bridge, "lock.1.jammed", false);
    });

    test("lock battery: BatPercentRemaining / 2", () => {
        assert.equal(bridge.value("lock.1.battery"), 80);
    });

    test("sensor: temperature, humidity, lux, occupancy, contact, battery", () => {
        assert.equal(bridge.value("sensor.1.temperature"), 28.5);
        assert.equal(bridge.value("sensor.1.humidity"), 48);
        assert.equal(bridge.value("sensor.1.lux"), 100);
        assert.equal(bridge.value("sensor.1.occupancy"), true);
        assert.equal(bridge.value("sensor.1.contact"), true);
        assert.equal(bridge.value("sensor.1.battery"), 100);
    });

    test("unknown slot, unknown channel and read-only channel go to system.error", () => {
        assert.equal(bridge.command("light.9.on", true), "no light 9 in config");
        assert.equal(bridge.value("system.error"), "no light 9 in config");
        assert.equal(bridge.command("light.1.foo", true), "unknown channel light.1.foo");
        assert.equal(bridge.command("bogus", 1), "unknown channel bogus");
        assert.equal(bridge.command("sensor.1.temperature", 20), "channel sensor.1.temperature is read-only");
        assert.equal(bridge.command("lock.1.locked", false), "channel lock.1.locked is read-only");
        assert.equal(matter.sent.length, 0);
    });

    test("refresh re-reads the slot; system.refresh re-reads every node", async () => {
        bridge.command("lock.1.refresh", true);
        bridge.command("light.2.refresh", true);
        assert.deepEqual(matter.reads, [{ nodeId: 10, paths: ["1/257/*"] }, { nodeId: 20, paths: ["1/*/*"] }]);
        matter.reads = [];
        bridge.command("system.refresh", true);
        assert.deepEqual(matter.reads.map(r => r.nodeId).sort((a, b) => a - b), [5, 10, 11, 20, 30, 40]);
    });

    test("matter-server disconnected: controller_online=false, commands report an error", async () => {
        matter.setConnected(false);
        await waitFor(bridge, "system.controller_online", false);
        assert.equal(bridge.value("system.error"), "matter-server disconnected");
        assert.equal(bridge.command("light.1.on", true), "matter-server disconnected");
        await waitFor(bridge, "light.1.error", "matter-server disconnected");
        assert.equal(matter.sent.length, 0);
        matter.setConnected(true);
        await waitFor(bridge, "system.controller_online", true);
        assert.equal(bridge.value("system.error"), "");
    });

    test("node offline: <kind>.N.online=false", async () => {
        matter.nodes.set(5, { ...matter.nodes.get(5)!, available: false });
        matter.report(5, {});
        await waitFor(bridge, "light.1.online", false);
        matter.nodes.set(5, { ...matter.nodes.get(5)!, available: true });
        matter.report(5, {});
        await waitFor(bridge, "light.1.online", true);
    });

    test("onChange only fires on changes", async () => {
        matter.report(20, {});
        await sleep(10);
        assert.equal(rec.seen.length, 0, "re-publishing identical values emits nothing");
        matter.report(20, { "1/768/0": 254 });
        await rec.waitSeen("light.2.hue=100");
    });
});

describe("bridge: hvac", () => {
    let matter: FakeMatter;
    let bridge: Bridge;
    before(() => {
        matter = new FakeMatter();
        seedNodes(matter);
        bridge = new Bridge(makeConfig(), matter);
        bridge.init();
    });
    after(() => bridge.stop());
    beforeEach(() => {
        matter.writes = [];
    });

    test("initial channels", () => {
        const s = bridge.snapshot();
        assert.equal(s["hvac.1.name"], "Bedroom AC");
        assert.equal(s["hvac.1.temperature"], 30);
        assert.equal(s["hvac.1.setpoint"], 24);
        assert.equal(s["hvac.1.mode"], "Off");
        assert.equal(s["hvac.1.on"], false);
        assert.equal(s["hvac.1.action"], "Idle");
        assert.equal(s["hvac.1.fan_mode"], "Medium");
        assert.equal(s["hvac.1.humidity"], 58);
        assert.equal(s["hvac.1.fan_percent"], 40);
        assert.equal(s["hvac.1.fan"], 2);
        assert.equal(s["hvac.1.setpoint_min"], 16);
        assert.equal(s["hvac.1.setpoint_max"], 32);
    });

    test("mode Cool writes SystemMode=3, state only changes when the device reports", async () => {
        bridge.command("hvac.1.mode", "Cool");
        await waitFor(bridge, "hvac.1.pending", true);
        assert.deepEqual(matter.writes, [{ nodeId: 40, path: "1/513/28", value: 3 }]);
        assert.equal(bridge.value("hvac.1.mode"), "Off");
        matter.report(40, { "1/513/28": 3 });
        await waitFor(bridge, "hvac.1.mode", "Cool");
        await waitFor(bridge, "hvac.1.on", true);
        await waitFor(bridge, "hvac.1.action", "Cooling");
        await waitFor(bridge, "hvac.1.pending", false);
    });

    test("setpoint 25.5 writes OccupiedCoolingSetpoint 2550 in Cool mode", async () => {
        bridge.command("hvac.1.setpoint", 25.5);
        await sleep(30);
        assert.deepEqual(matter.writes[0], { nodeId: 40, path: "1/513/17", value: 2550 });
        matter.report(40, { "1/513/17": 2550 });
        await waitFor(bridge, "hvac.1.setpoint", 25.5);
    });

    test("setpoint_step is 1 C, setpoints clamp to the 16-32 limits", async () => {
        matter.report(40, { "1/513/17": 3200 });
        bridge.command("hvac.1.setpoint_step", true);
        bridge.command("hvac.1.setpoint", 10);
        await sleep(30);
        assert.equal(matter.writes[0].value, 3200);
        assert.equal(matter.writes[1].value, 1600);
        matter.report(40, { "1/513/17": 2400 });
        bridge.command("hvac.1.setpoint_step", false);
        await sleep(30);
        assert.equal(matter.writes[2].value, 2300);
        assert.equal(bridge.command("hvac.1.setpoint", 41), "bad setpoint 41");
    });

    test("mode Heat then setpoint writes OccupiedHeatingSetpoint", async () => {
        bridge.command("hvac.1.mode", "HEAT");
        await sleep(30);
        assert.equal(matter.writes[0].value, 4);
        matter.report(40, { "1/513/28": 4, "1/513/18": 2000 });
        await waitFor(bridge, "hvac.1.setpoint", 20);
        bridge.command("hvac.1.setpoint", 22);
        await sleep(30);
        assert.equal(matter.writes[1].path, "1/513/18");
        matter.report(40, { "1/513/28": 3 });
    });

    test("mode Auto is rejected when the device has no Auto feature", async () => {
        bridge.command("hvac.1.mode", "auto");
        await waitFor(bridge, "hvac.1.error", "mode AUTO not supported");
        assert.equal(matter.writes.length, 0);
    });

    test("on: false = Off, true = Cool", async () => {
        bridge.command("hvac.1.on", false);
        await sleep(30);
        assert.deepEqual(matter.writes[0], { nodeId: 40, path: "1/513/28", value: 0 });
        matter.report(40, { "1/513/28": 0 });
        await waitFor(bridge, "hvac.1.on", false);
        bridge.command("hvac.1.on", true);
        await sleep(30);
        assert.equal(matter.writes[1].value, 3);
        matter.report(40, { "1/513/28": 3 });
        await waitFor(bridge, "hvac.1.on", true);
    });

    test("fan_mode: High=3, Auto=5, unknown names rejected", async () => {
        bridge.command("hvac.1.fan_mode", "High");
        await sleep(30);
        assert.deepEqual(matter.writes[0], { nodeId: 40, path: "2/514/0", value: 3 });
        matter.report(40, { "2/514/0": 3 });
        await waitFor(bridge, "hvac.1.fan_mode", "High");
        await waitFor(bridge, "hvac.1.fan", 3);
        bridge.command("hvac.1.fan_mode", "AUTO");
        await sleep(30);
        assert.equal(matter.writes[1].value, 5);
        matter.report(40, { "2/514/0": 5 });
        await waitFor(bridge, "hvac.1.fan_mode", "Auto");
        bridge.command("hvac.1.fan_mode", "TURBO");
        await waitFor(bridge, "hvac.1.error", "bad fan_mode TURBO");
    });

    test("fan stage 0-3 writes FanMode; feedback follows the device", async () => {
        bridge.command("hvac.1.fan", 1);
        await sleep(30);
        assert.deepEqual(matter.writes[0], { nodeId: 40, path: "2/514/0", value: 1 });
        matter.report(40, { "2/514/0": 1 });
        await waitFor(bridge, "hvac.1.fan", 1);
        await waitFor(bridge, "hvac.1.fan_mode", "Low");
        bridge.command("hvac.1.fan", 0);
        await sleep(30);
        assert.equal(matter.writes[1].value, 0);
        matter.report(40, { "2/514/0": 0 });
        await waitFor(bridge, "hvac.1.fan", 0);
        await waitFor(bridge, "hvac.1.pending", false);
        bridge.command("hvac.1.fan", 4);
        await waitFor(bridge, "hvac.1.error", "bad fan 4");
        // Auto: the stage shows the speed actually running
        matter.report(40, { "2/514/0": 5, "2/514/3": 80 });
        await waitFor(bridge, "hvac.1.fan", 3);
        matter.report(40, { "2/514/3": 20 });
        await waitFor(bridge, "hvac.1.fan", 1);
    });

    test("fan_mode On is confirmed when the device switches to any speed", async () => {
        bridge.command("hvac.1.fan_mode", "On");
        await waitFor(bridge, "hvac.1.pending", true);
        assert.equal(matter.writes[0].value, 4);
        matter.report(40, { "2/514/0": 3 }); // the device turns On into High
        await waitFor(bridge, "hvac.1.pending", false);
        await sleep(400);
        assert.equal(bridge.value("hvac.1.error"), "");
    });

    test("device rejects the write: hvac.N.error", async () => {
        matter.failNext = "write 1/513/28 status 135";
        bridge.command("hvac.1.mode", "Dry");
        await waitFor(bridge, "hvac.1.error", "write 1/513/28 status 135");
        await waitFor(bridge, "hvac.1.pending", false);
    });

    test("setConfig drops channels of removed slots and keeps the rest", () => {
        bridge.setConfig(makeConfig({ thermostats: {}, sensors: {} }));
        assert.equal(bridge.value("hvac.1.mode"), undefined);
        assert.equal(bridge.value("sensor.1.lux"), undefined);
        assert.equal(bridge.value("light.2.level"), 50);
        assert.equal(bridge.command("hvac.1.mode", "Cool"), "no hvac 1 in config");
    });
});

describe("pure functions", () => {
    test("parseChannel", () => {
        assert.deepEqual({ ...parseChannel("light.3.level"), spec: undefined }, { kind: "light", slot: "3", prop: "level", spec: undefined });
        assert.equal(parseChannel("hvac.1.mode")?.spec?.type, "string");
        assert.equal(parseChannel("system.error")?.kind, "system");
        assert.equal(parseChannel("light.0.on"), undefined);
        assert.equal(parseChannel("Light.1.on"), undefined);
        assert.equal(parseChannel("light.1.nope")?.spec, undefined);
    });

    test("toBool / toNum", () => {
        assert.equal(toBool("on"), true);
        assert.equal(toBool(0), false);
        assert.equal(toBool(2), undefined);
        assert.equal(toNum("24,5"), 24.5);
        assert.equal(toNum(""), undefined);
        assert.equal(toNum(Number.NaN), undefined);
    });

    test("ct_level and mireds are inverse", () => {
        const r = { min: 153, max: 500 };
        for (const lv of [0, 25, 50, 100]) assert.equal(miredsToCtLevel(ctLevelToMireds(lv, r), r), lv);
    });

    test("light off -> level 0, on -> level >= 1", () => {
        const slot = { node_id: 1, endpoint: 1 };
        const off = lightChannels("1", slot, { node_id: 1, available: true, attributes: { "1/6/0": false, "1/8/0": 200 } });
        assert.equal(off["light.1.level"], 0);
        const on = lightChannels("1", slot, { node_id: 1, available: true, attributes: { "1/6/0": true, "1/8/0": 1 } });
        assert.equal(on["light.1.level"], 1);
    });

    test("sensor lux 0 and negative temperature", () => {
        const s = sensorChannels("1", { node_id: 1 }, { node_id: 1, available: true, attributes: { "1/1024/0": 0, "1/1026/0": -150 } });
        assert.equal(s["sensor.1.lux"], 0);
        assert.equal(s["sensor.1.temperature"], -1.5);
    });

    test("config: slot out of range and missing endpoint are rejected", () => {
        assert.throws(() => parseConfig({ lights: { "256": { node_id: 1, endpoint: 1 } } }), /1-255/);
        assert.throws(() => parseConfig({ locks: { "1": { node_id: 1 } } }), /endpoint/);
        assert.throws(() => parseConfig({ matter_server: "http://x" }), /matter_server/);
        assert.equal(parseConfig({}).matter_server, "ws://127.0.0.1:5580/ws");
    });

    test("config: a KNX command on lock.N.unlock needs unlock_enabled", () => {
        const knx = { objects: [{ ga: "5/0/2", dpt: "1.001", bind: "lock.1.unlock", dir: "cmd" }] };
        assert.throws(() => parseConfig({ locks: { "1": { node_id: 1, endpoint: 1 } }, knx }), /unlock_enabled/);
        assert.throws(() => parseConfig({ knx }), /unlock_enabled/, "unknown lock slot");
        assert.doesNotThrow(() => parseConfig({ locks: { "1": { node_id: 1, endpoint: 1, unlock_enabled: true } }, knx }));
        const lockOnly = { objects: [{ ga: "5/0/1", dpt: "1.001", bind: "lock.1.lock", dir: "cmd" }, { ga: "5/0/3", dpt: "1.001", bind: "lock.1.locked", dir: "fb" }] };
        assert.doesNotThrow(() => parseConfig({ locks: { "1": { node_id: 1, endpoint: 1 } }, knx: lockOnly }));
        assert.throws(() => parseConfig({ locks: { "1": { node_id: 1, endpoint: 1, unlock_enabled: "false" } } }), /unlock_enabled: true or false/);
    });

    test("admin password: generated once on first run, persisted, never a fixed default", () => {
        const dir = mkdtempSync(join(tmpdir(), "cfg-"));
        const path = join(dir, "config.json");
        writeFileSync(path, JSON.stringify({ admin: { port: 2401 } }), { mode: 0o644 });
        const pw = ensureAdminPassword(path);
        assert.ok(pw && pw.length >= 16);
        if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600, "existing file made private");
        const saved = JSON.parse(readFileSync(path, "utf8"));
        assert.equal(saved.admin.password, pw);
        assert.equal(ensureAdminPassword(path), undefined, "only on first run");
        assert.doesNotThrow(() => parseConfig(saved));
        writeFileSync(join(dir, "b.json"), JSON.stringify({ admin: {} }));
        assert.notEqual(ensureAdminPassword(join(dir, "b.json")), pw, "random per install");
        writeFileSync(join(dir, "c.json"), JSON.stringify({ lights: {} }));
        assert.equal(ensureAdminPassword(join(dir, "c.json")), undefined, "no admin section: nothing to do");
        assert.ok(statSync(path).isFile());
    });
});
