// Admin tests: DPTs, KNX value transforms, plan (built-in GA planner, overrides, reserved, slots, bindings),
// ETS import / export, planner plugins, admin API on 2401.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dpt7, dpt9, dpt5001, cemi, parseCemi, CEMI, APCI } from "../src/knx/frames.ts";
import { encodeValue, decodeTelegram, validateObjects, type KnxObjectConfig } from "../src/knx/gateway.ts";
import { parseConfig, type BridgeConfig } from "../src/config.ts";
import { buildPlan, plannerInput } from "../src/admin/plan.ts";
import { validateProject, type Project } from "../src/admin/project.ts";
import { planBuiltin, SCHEME } from "../src/admin/planner/builtin.ts";
import { loadPlanner } from "../src/admin/planner/load.ts";
import type { GaPlanner } from "../src/admin/planner/types.ts";
import { buildEtsCsv, buildEtsXml, dptFromEts, etsDptId, parseEtsExport } from "../src/admin/ets.ts";
import { AdminServer } from "../src/admin/server.ts";
import { describeNode } from "../src/admin/suggest.ts";
import type { MatterPort, NodeEventView } from "../src/matter.ts";
import type { NodeView } from "../src/mapping.ts";
import { log } from "../src/log.ts";
import net from "node:net";
import { blockReason, readFrames, wsFrame } from "../src/admin/matter-proxy.ts";
import { hashPin, UnlockGuard, LOCKOUT_MS } from "../src/admin/unlock.ts";

log.setLevel("error");

const tel = (v: Buffer | number) => parseCemi(cemi(CEMI.L_DATA_REQ, 0, 1, APCI.WRITE, v))!;

describe("DPT", () => {
    test("9.xxx round trip and edge values", () => {
        for (const v of [0, 24.5, -1.5, 30, 0.01, 1000, 670433.28]) {
            const d = dpt9.decode(tel(dpt9.encode(v)))!;
            assert.ok(Math.abs(d - v) <= Math.max(0.01, Math.abs(v) * 0.005), `${v} -> ${d}`);
        }
        assert.deepEqual([...dpt9.encode(24.5)], [0x0c, 0xc9]); // 24,5 = 0,01 * 1225 * 2^1 -> E=1, M=0x4C9
        assert.notDeepEqual([...dpt9.encode(1e9)], [0x7f, 0xff], "never produces the invalid code");
    });
    test("7.600 Kelvin 2 bytes", () => {
        assert.equal(dpt7.decode(tel(dpt7.encode(2700))), 2700);
    });
});

describe("KNX value transforms <-> channels", () => {
    const mode: KnxObjectConfig = { ga: "4/2/6", dpt: "20.105", bind: "hvac.1.mode", dir: "cmd", transform: "hvac_mode" };
    const fan: KnxObjectConfig = { ga: "4/2/8", dpt: "5.001", bind: "hvac.1.fan", dir: "cmd", transform: "fan_level" };
    test("hvac_mode: 20.105 3 = Cool, 6 = Off; mode Cool -> 3", () => {
        assert.equal(decodeTelegram(mode, tel(Buffer.from([3]))), "COOL");
        assert.equal(decodeTelegram(mode, tel(Buffer.from([6]))), "OFF");
        assert.deepEqual(encodeValue({ ...mode, dir: "fb" }, "Cool"), Buffer.from([3]));
        assert.equal(decodeTelegram(mode, tel(Buffer.from([2]))), undefined, "Standby has no equivalent");
    });
    test("fan_level: 80 % -> stage 3, stage 1 -> 33 %", () => {
        assert.equal(decodeTelegram(fan, tel(Buffer.from([204]))), 3);
        assert.equal(decodeTelegram(fan, tel(Buffer.from([0]))), 0);
        assert.deepEqual(encodeValue({ ...fan, dir: "fb" }, 1), Buffer.from([84]));
    });
    test("fan_level round trip: a feedback value written back gives the same stage (67 % is Medium)", () => {
        const fb: KnxObjectConfig = { ...fan, dir: "fb" };
        for (const level of [0, 1, 2, 3]) {
            const out = encodeValue(fb, level) as Buffer;
            assert.equal(decodeTelegram(fan, tel(out)), level, `stage ${level} (raw ${out[0]})`);
        }
        assert.equal(decodeTelegram(fan, tel(dpt5001.encode(67))), 2);
    });
    test("fan_level with custom fan_steps [20, 50, 100]", () => {
        const f: KnxObjectConfig = { ...fan, fan_steps: [20, 50, 100] };
        assert.deepEqual(encodeValue({ ...f, dir: "fb" }, 2), Buffer.from([128])); // 50 %
        assert.equal(decodeTelegram(f, tel(Buffer.from([89]))), 2); // 35 %: (20, 50]
        assert.equal(decodeTelegram(f, tel(Buffer.from([38]))), 1); // 15 %
        assert.equal(decodeTelegram(f, tel(Buffer.from([153]))), 3); // 60 %
        assert.deepEqual(validateObjects([{ ...f, fan_steps: [50, 20, 100] }]).length, 1);
    });
    test("5.100 FanStage: the value is the stage, no conversion", () => {
        const st: KnxObjectConfig = { ga: "4/2/8", dpt: "5.100", bind: "hvac.1.fan", dir: "cmd" };
        assert.equal(decodeTelegram(st, tel(Buffer.from([2]))), 2);
        assert.deepEqual(encodeValue({ ga: "4/2/9", dpt: "5.100", bind: "hvac.1.fan", dir: "fb" }, 3), Buffer.from([3]));
        assert.equal(validateObjects([st]).length, 0);
        assert.equal(validateObjects([{ ...st, transform: "fan_level" }]).length, 1, "fan_level only with 5.001");
    });
    test("invert: DPT 1.019 contact 0 = closed", () => {
        const o: KnxObjectConfig = { ga: "4/2/2", dpt: "1.019", bind: "sensor.1.contact", dir: "fb", transform: "invert" };
        assert.equal(encodeValue(o, true), 0);
        assert.equal(encodeValue(o, false), 1);
    });
    test("9.001 setpoint: commands rounded to 0.1, numeric feedback", () => {
        const sp: KnxObjectConfig = { ga: "4/2/3", dpt: "9.001", bind: "hvac.1.setpoint", dir: "cmd" };
        assert.equal(decodeTelegram(sp, tel(dpt9.encode(24.5))), 24.5);
        assert.deepEqual(encodeValue({ ga: "4/2/4", dpt: "9.001", bind: "hvac.1.setpoint", dir: "fb" }, 24.5), dpt9.encode(24.5));
        assert.equal(encodeValue({ ga: "4/2/4", dpt: "9.001", bind: "hvac.1.setpoint", dir: "fb" }, ""), undefined);
    });
    test("validation: channel, direction, DPT and transform must fit", () => {
        const ok = (o: Partial<KnxObjectConfig>) => validateObjects([{ ga: "1/1/1", dpt: "1.001", bind: "light.1.on", dir: "cmd", ...o } as KnxObjectConfig]);
        assert.deepEqual(ok({}), []);
        assert.equal(ok({ bind: "light.1.nope" }).length, 1, "unknown channel");
        assert.equal(ok({ bind: "sensor.1.occupancy" }).length, 1, "feedback-only channel as cmd");
        assert.equal(ok({ bind: "lock.1.unlock", dir: "fb" }).length, 1, "command-only channel as fb");
        assert.equal(ok({ dpt: "5.001" }).length, 1, "boolean channel on 5.001");
        assert.equal(ok({ bind: "light.1.level" }).length, 1, "numeric channel on DPT 1");
        assert.equal(ok({ bind: "lock.1.state", dir: "fb" }).length, 1, "text channel");
        assert.equal(ok({ bind: "hvac.1.mode", dpt: "20.105" }).length, 1, "mode needs hvac_mode");
        assert.equal(ok({ dir: "both" as never }).length, 1);
        assert.equal(ok({ transform: "hvac_mode" }).length, 1);
    });
});

function baseConfig(): BridgeConfig {
    return parseConfig({
        lights: {
            "1": { node_id: 5, endpoint: 1 }, "2": { node_id: 5, endpoint: 2 },
            "3": { node_id: 5, endpoint: 3 }, "4": { node_id: 5, endpoint: 4 },
        },
        thermostats: { "1": { node_id: 4, endpoint: 1, name: "Living room AC" } },
        knx: { host_ip: "127.0.0.1", objects: [{ ga: "31/0/1", dpt: "1.001", bind: "light.1.on", dir: "cmd" }] },
    });
}

function project(): Project {
    return {
        version: 1, name: "Test", rev: 0,
        floors: [{ code: "GF", label: "Ground floor", order: 1 }, { code: "1F", label: "First floor", order: 2 }],
        rooms: [
            { code: "LIV", floorCode: "GF", label: "Living room", order: 1 },
            { code: "MBR", floorCode: "1F", label: "Master bedroom", order: 1 },
        ],
        assignments: [
            { id: "n5e2", nodeId: 5, endpoint: 2, circuitType: "lt.onoff", floorCode: "GF", roomCode: "LIV", name: "GF.LIV.L02" },
            { id: "n5e1", nodeId: 5, endpoint: 1, circuitType: "lt.onoff", floorCode: "GF", roomCode: "LIV", name: "GF.LIV.L01", description: "Ceiling light" },
            { id: "n4e1", nodeId: 4, endpoint: 1, circuitType: "hvac.unit", floorCode: "1F", roomCode: "MBR", name: "1F.MBR.AC01" },
            { id: "n7e1", nodeId: 7, endpoint: 1, circuitType: "pres.sensor", floorCode: "GF", roomCode: "LIV", name: "GF.LIV.P01" },
        ],
    };
}

function buildInput(pr: Project) {
    return plannerInput(pr);
}

describe("plan", () => {
    test("apply keeps hand-written objects of unmanaged devices (locks), drops those of managed slots", () => {
        const raw = {
            lights: { "1": { node_id: 5, endpoint: 1 }, "2": { node_id: 5, endpoint: 2 } },
            locks: { "1": { node_id: 9, endpoint: 1 } },
            knx: {
                host_ip: "127.0.0.1",
                objects: [
                    { ga: "31/0/1", dpt: "1.001", bind: "light.1.on", dir: "cmd" },
                    { ga: "31/0/2", dpt: "1.001", bind: "lock.1.locked", dir: "fb" },
                    { ga: "31/0/3", dpt: "1.001", bind: "lock.1.lock", dir: "cmd" },
                ],
            },
        };
        const p = buildPlan(project(), parseConfig(raw));
        const objs = p.config.knx!.objects;
        assert.ok(objs.some(o => o.ga === "31/0/2" && o.bind === "lock.1.locked"), "lock feedback kept");
        assert.ok(objs.some(o => o.ga === "31/0/3"), "lock command kept");
        assert.ok(!objs.some(o => o.ga === "31/0/1"), "old object of a managed light slot replaced");
        assert.equal(p.served.mapped, p.objects.length, "served counts plan objects only");
    });

    test("keeps existing slots by node/endpoint, new slots take free numbers, unmanaged slots stay", () => {
        const p = buildPlan(project(), baseConfig());
        assert.equal(p.slots.n5e1, 1);
        assert.equal(p.slots.n5e2, 2);
        assert.equal(p.slots.n4e1, 1);
        assert.equal(p.slots.n7e1, 1);
        assert.ok(p.config.lights["3"] && p.config.lights["4"], "hand-configured channels 3-4 are kept");
        assert.equal(p.config.lights["1"].name, "Ceiling light");
        assert.equal(p.config.thermostats["1"].node_id, 4);
        assert.equal(p.config.sensors["1"].node_id, 7);
    });

    test("planner GAs -> channel bindings", () => {
        const p = buildPlan(project(), baseConfig());
        const by = (ga: string) => p.objects.find(o => o.ga === ga);
        assert.deepEqual([by("1/1/1")?.bind, by("1/1/1")?.dir], ["light.1.on", "cmd"]);
        assert.deepEqual([by("1/1/2")?.bind, by("1/1/2")?.dir], ["light.1.on", "fb"]);
        assert.deepEqual([by("1/1/3")?.bind, by("1/1/3")?.dir], ["light.2.on", "cmd"]);
        const mode = p.objects.find(o => o.name === "HVAC - 1F.MBR.AC01 - MODE");
        assert.equal(mode?.transform, "hvac_mode");
        assert.equal(p.objects.find(o => o.name === "HVAC - 1F.MBR.AC01 - SETP")?.dpt, "9.001");
        assert.equal(p.objects.find(o => o.name === "HVAC - 1F.MBR.AC01 - ONOFF_FB")?.bind, "hvac.1.on");
        assert.equal(p.objects.find(o => o.name === "HVAC - 1F.MBR.AC01 - TEMP")?.bind, "hvac.1.temperature");
        assert.equal(p.objects.find(o => o.name === "PRES - GF.LIV.P01 - OCC")?.bind, "sensor.1.occupancy");
        assert.ok(!p.objects.some(o => o.ga.startsWith("31/")), "the hand-written 31/x object is replaced");
        assert.deepEqual(validateObjects(p.objects), [], "every generated binding is valid");
        assert.doesNotThrow(() => parseConfig(p.config));
        assert.equal(p.objects.find(o => o.name === "PRES - GF.LIV.P01 - LUX")?.bind, "sensor.1.lux");
        assert.equal(p.warnings.length, 0, JSON.stringify(p.warnings));
        assert.equal(p.served.mapped, p.served.deviceGas, "every built-in GA is served");
        assert.equal(p.addressChanges.length, 0);
        assert.deepEqual(p.result.issues, []);
    });

    test("fan: 5.100 without transform by default; percent = 5.001 fan_level; ETS export uses the same DPT", () => {
        const p = buildPlan(project(), baseConfig());
        const fan = p.objects.find(o => o.name === "HVAC - 1F.MBR.AC01 - FAN");
        assert.equal(fan?.dpt, "5.100");
        assert.equal(fan?.transform, undefined);
        assert.equal(p.result.gas.find(g => g.ga === fan?.ga)?.dpt, "5.100");
        const mode = p.objects.find(o => o.name === "HVAC - 1F.MBR.AC01 - MODE");
        assert.equal(mode?.dpt, "20.105");
        assert.equal(p.result.gas.find(g => g.ga === mode?.ga)?.dpt, "20.105", "ETS export also 20.105");
        const pr = project();
        const ac = pr.assignments.find(a => a.id === "n4e1")!;
        ac.fanFormat = "percent";
        ac.fanSteps = [30, 60, 100];
        const q = buildPlan(pr, baseConfig());
        const fb = q.objects.find(o => o.name === "HVAC - 1F.MBR.AC01 - FAN_FB");
        assert.equal(fb?.dpt, "5.001");
        assert.equal(fb?.transform, "fan_level");
        assert.deepEqual(fb?.fan_steps, [30, 60, 100]);
    });

    test("frozen: GAs whose address changed since the export are reported", () => {
        const pr = project();
        const first = buildPlan(pr, baseConfig());
        pr.exported = { at: "x", rev: 1, gas: Object.fromEntries(first.result.gas.map(g => [g.key, g.ga])) };
        // Move light L02 to the first floor: its address changes
        pr.assignments[0] = { ...pr.assignments[0], floorCode: "1F", roomCode: "MBR", name: "1F.MBR.L02" };
        const second = buildPlan(pr, baseConfig());
        assert.ok(second.addressChanges.some(c => c.key === "n5e2:SW"));
    });
});

describe("built-in planner", () => {
    const addr = (pr: Project, name: string) => buildPlan(pr, baseConfig()).result.gas.find(g => g.name === name)?.ga;

    test("scheme: main per system, middle per floor, room blocks of 20, template DPTs", () => {
        const r = buildPlan(project(), baseConfig()).result;
        assert.equal(r.scheme, "builtin-v1");
        const g = (name: string) => r.gas.find(x => x.name === name)!;
        assert.equal(g("LT - GF.LIV.L01 - SW").ga, "1/1/1");
        assert.deepEqual(g("LT - GF.LIV.L01 - SW").rangePath, ["Lighting", "GF Ground floor"]);
        assert.equal(g("LT - GF.LIV.L02 - FB").ga, "1/1/4");
        assert.equal(g("LT - GF.LIV.L02 - FB").isStatus, true);
        assert.deepEqual(r.gas.filter(x => x.deviceId === "n4e1").map(x => `${x.objectKey} ${x.ga} ${x.dpt}`), [
            "ONOFF 3/2/1 1.001", "ONOFF_FB 3/2/2 1.001", "SETP 3/2/3 9.001", "SETP_FB 3/2/4 9.001", "TEMP 3/2/5 9.001",
            "MODE 3/2/6 20.105", "MODE_FB 3/2/7 20.105", "FAN 3/2/8 5.100", "FAN_FB 3/2/9 5.100",
        ]);
        assert.deepEqual([g("PRES - GF.LIV.P01 - OCC").ga, g("PRES - GF.LIV.P01 - OCC").dpt, g("PRES - GF.LIV.P01 - LUX").dpt], ["4/1/1", "1.018", "9.004"]);
        assert.equal(r.stats.total, 2 + 2 + 9 + 2);
        assert.deepEqual(r.stats.bySystem, { Lighting: 4, HVAC: 9, "Sensors and security": 2 });
        assert.equal(r.stats.maxUtilization?.capacity, SCHEME.blockSize);
    });

    test("lt.dim / lt.cct / sec.contact templates; fan 5.001 when the circuit uses percent", () => {
        const pr = project();
        pr.assignments.push(
            { id: "n8e1", nodeId: 8, endpoint: 1, circuitType: "lt.cct", floorCode: "1F", roomCode: "MBR", name: "1F.MBR.L01" },
            { id: "n9e1", nodeId: 9, endpoint: 1, circuitType: "sec.contact", floorCode: "1F", roomCode: "MBR", name: "1F.MBR.D01" },
        );
        pr.assignments.find(a => a.id === "n4e1")!.fanFormat = "percent";
        const r = buildPlan(pr, baseConfig()).result;
        assert.deepEqual(r.gas.filter(x => x.deviceId === "n8e1").map(x => `${x.objectKey} ${x.dpt} ${x.isStatus ? "fb" : "cmd"}`), [
            "SW 1.001 cmd", "FB 1.001 fb", "VAL 5.001 cmd", "VALFB 5.001 fb", "CCT 7.600 cmd", "CCT_FB 7.600 fb",
        ]);
        assert.deepEqual(r.gas.filter(x => x.deviceId === "n9e1").map(x => `${x.name} ${x.ga} ${x.dpt}`), ["SEC - 1F.MBR.D01 - CONTACT 4/2/1 1.019"]);
        assert.deepEqual(r.gas.filter(x => x.objectKey?.startsWith("FAN")).map(x => x.dpt), ["5.001", "5.001"]);
    });

    test("deterministic: same project gives the same plan, whatever the order of circuits", () => {
        const a = planBuiltin(buildInput(project()));
        const pr = project();
        pr.assignments.reverse();
        pr.rooms.reverse();
        pr.floors.reverse();
        assert.deepEqual(planBuiltin(buildInput(pr)), a);
    });

    test("adding a circuit or a room later does not move the addresses of other rooms", () => {
        const pr = project();
        pr.rooms.push({ code: "KIT", floorCode: "GF", label: "Kitchen", order: 2 });
        pr.assignments.push({ id: "n6e1", nodeId: 6, endpoint: 1, circuitType: "lt.dim", floorCode: "GF", roomCode: "KIT", name: "GF.KIT.L01" });
        const before = buildPlan(pr, baseConfig()).result.gas;
        assert.equal(before.find(g => g.name === "LT - GF.KIT.L01 - SW")?.ga, "1/1/21", "second room block starts at sub 21");
        pr.assignments.push({ id: "n6e2", nodeId: 6, endpoint: 2, circuitType: "lt.cct", floorCode: "GF", roomCode: "LIV", name: "GF.LIV.L03" });
        const after = buildPlan(pr, baseConfig()).result.gas;
        for (const g of before) assert.equal(after.find(x => x.key === g.key)?.ga, g.ga, g.name);
        assert.equal(after.find(g => g.name === "LT - GF.LIV.L03 - SW")?.ga, "1/1/5");
    });

    test("unsupported circuit types get no GAs and a warning", () => {
        const pr = project();
        pr.assignments.push({ id: "n3e1", nodeId: 3, endpoint: 1, circuitType: "sht.roller", floorCode: "GF", roomCode: "LIV", name: "GF.LIV.SH01" });
        const p = buildPlan(pr, baseConfig());
        assert.equal(p.result.gas.filter(g => g.deviceId === "n3e1").length, 0);
        assert.ok(p.result.issues.some(i => i.code === "type_unsupported" && i.level === "warning" && i.params.name === "GF.LIV.SH01"));
        assert.ok(!p.warnings.some(w => w.code === "circuit_unsupported"), "no second warning for the same circuit");
        assert.equal(p.slots.n3e1, undefined);
    });

    test("imported (reserved) addresses are skipped", () => {
        const pr = project();
        pr.reserved = [{ ga: "1/1/1", name: "Existing scene" }, { ga: "1/1/3", name: "Existing dimmer" }];
        assert.equal(addr(pr, "LT - GF.LIV.L01 - SW"), "1/1/2");
        assert.equal(addr(pr, "LT - GF.LIV.L01 - FB"), "1/1/4");
        assert.equal(addr(pr, "LT - GF.LIV.L02 - SW"), "1/1/5");
        assert.deepEqual(buildPlan(pr, baseConfig()).result.issues, []);
    });

    test("full room block: remaining GAs get no address (error), a manual address fixes it", () => {
        const pr = project();
        for (let i = 3; i <= 6; i++) pr.assignments.push({ id: `n6e${i}`, nodeId: 6, endpoint: i, circuitType: "lt.cct", floorCode: "GF", roomCode: "LIV", name: `GF.LIV.L0${i}` });
        let p = buildPlan(pr, baseConfig());
        const empty = p.result.gas.filter(g => !g.ga);
        assert.equal(empty.length, 4 + 24 - 20);
        assert.ok(p.result.issues.some(i => i.code === "block_full" && i.params.missing === "8"));
        assert.ok(p.result.issues.some(i => i.code === "ga_unassigned" && i.level === "error"));
        assert.ok(p.objects.every(o => o.ga), "no binding without an address");
        pr.overrides = Object.fromEntries(empty.map((g, i) => [g.key, { ga: `1/1/${241 + i}` }]));
        p = buildPlan(pr, baseConfig());
        assert.ok(!p.result.issues.some(i => i.level === "error"), JSON.stringify(p.result.issues));
    });

    test("more than 7 floors or 12 rooms per floor: clear errors; outdoor floors take middle 7 downwards", () => {
        const pr = project();
        pr.floors.push({ code: "GDN", label: "Garden", order: 0, outdoor: true });
        pr.rooms.push({ code: "POOL", floorCode: "GDN", label: "Pool", order: 1 });
        pr.assignments.push({ id: "n6e1", nodeId: 6, endpoint: 1, circuitType: "lt.onoff", floorCode: "GDN", roomCode: "POOL", name: "GDN.POOL.L01" });
        assert.equal(addr(pr, "LT - GDN.POOL.L01 - SW"), "1/7/1");
        assert.equal(addr(pr, "LT - GF.LIV.L01 - SW"), "1/1/1", "the outdoor floor does not shift indoor floors");
        for (let i = 3; i <= 8; i++) pr.floors.push({ code: `F${i}`, label: "", order: 10 + i });
        const p = buildPlan(pr, baseConfig());
        assert.deepEqual(p.result.issues.filter(i => i.code === "floor_limit").map(i => i.params.floor), ["F7", "F8"]);
        const q = project();
        for (let i = 0; i < 13; i++) q.rooms.push({ code: `R${String(i).padStart(2, "0")}`, floorCode: "GF", label: "", order: 10 + i });
        q.assignments.push({ id: "n6e1", nodeId: 6, endpoint: 1, circuitType: "lt.onoff", floorCode: "GF", roomCode: "R12", name: "GF.R12.L01" });
        const r = buildPlan(q, baseConfig()).result;
        assert.deepEqual(r.issues.filter(i => i.code === "room_limit").map(i => i.params.room), ["R11", "R12"]);
        assert.ok(r.issues.some(i => i.code === "ga_unassigned" && i.params.name === "GF.R12.L01"));
    });
});

describe("manual addresses", () => {
    test("an override wins, keeps the generated address for reference, and moves nothing else", () => {
        const pr = project();
        pr.overrides = { "n5e1:SW": { ga: "1/1/200" } };
        const p = buildPlan(pr, baseConfig());
        const sw = p.result.gas.find(g => g.key === "n5e1:SW")!;
        assert.deepEqual([sw.ga, sw.generated, sw.overridden], ["1/1/200", "1/1/1", true]);
        assert.equal(p.result.gas.find(g => g.key === "n5e1:FB")?.ga, "1/1/2");
        assert.equal(p.objects.find(o => o.ga === "1/1/200")?.bind, "light.1.on");
        assert.deepEqual(p.result.issues, []);
    });

    test("project validation: format, ranges, duplicates, imported address needs consent", () => {
        const codes = (o: Project["overrides"], reserved?: Project["reserved"]) => validateProject({ ...project(), overrides: o, reserved }).map(e => e.code);
        for (const bad of ["32/0/1", "1/8/1", "1/1/256", "0/0/0", "abc", "1/1"]) assert.deepEqual(codes({ "n5e1:SW": { ga: bad } }), ["override_format"], bad);
        assert.deepEqual(codes({ "n5e1:SW": { ga: "31/7/255" } }), []);
        assert.deepEqual(codes({ "n5e1:SW": { ga: "5/0/1" }, "n5e1:FB": { ga: "5/0/1" } }), ["override_dup"]);
        const reserved = [{ ga: "5/0/1", name: "Site light" }];
        assert.deepEqual(codes({ "n5e1:SW": { ga: "5/0/1" } }, reserved), ["override_reserved"]);
        assert.deepEqual(codes({ "n5e1:SW": { ga: "5/0/1", useImported: true } }, reserved), []);
        assert.deepEqual(codes(undefined, [{ ga: "1/9/1", name: "x" }]), ["reserved_format"]);
    });

    test("plan: duplicate with a generated GA, imported address used on purpose, stale override", () => {
        const pr = project();
        pr.overrides = { "n5e1:SW": { ga: "1/1/3" }, "gone:SW": { ga: "9/9/9" } };
        let p = buildPlan(pr, baseConfig());
        const c = p.result.issues.find(i => i.code === "override_conflict");
        assert.equal(c?.key, "n5e1:SW");
        assert.equal(c?.params.other, "LT - GF.LIV.L02 - SW");
        assert.ok(p.result.issues.some(i => i.code === "override_unused" && i.level === "warning"));
        pr.reserved = [{ ga: "5/0/1", name: "Site light" }];
        pr.overrides = { "n5e1:SW": { ga: "5/0/1", useImported: true } };
        p = buildPlan(pr, baseConfig());
        assert.equal(p.result.gas.find(g => g.key === "n5e1:SW")?.imported, "Site light");
        assert.deepEqual(p.result.issues, []);
        pr.overrides = { "n5e1:SW": { ga: "5/0/1" } };
        assert.ok(buildPlan(pr, baseConfig()).result.issues.some(i => i.code === "ga_reserved" && i.params.imported === "Site light"));
    });
});

describe("ETS files", () => {
    test("DPT ids", () => {
        assert.deepEqual(["1.001", "5.100", "20.105", "9.001", "7.600", "9"].map(etsDptId), ["DPST-1-1", "DPST-5-100", "DPST-20-105", "DPST-9-1", "DPST-7-600", "DPT-9"]);
        assert.deepEqual(["DPST-1-1", "DPT-9", "DPST-5-100,DPST-5-1", "5.1", "", "x"].map(s => dptFromEts(s)), ["1.001", "9", "5.100", "5.001", undefined, undefined]);
    });

    test("export: GroupAddress-Export XML with nested ranges, DPST ids, escaping; 3-level CSV", () => {
        const pr = project();
        pr.assignments[1].description = 'Ceiling <A&B> "main"';
        const gas = buildPlan(pr, baseConfig()).result.gas;
        const xml = buildEtsXml(gas);
        assert.match(xml, /^<\?xml version="1.0" encoding="utf-8"/);
        assert.match(xml, /<GroupAddress-Export xmlns="http:\/\/knx.org\/xml\/ga-export\/01">/);
        assert.match(xml, /<GroupRange Name="Lighting" RangeStart="2048" RangeEnd="4095">\r\n    <GroupRange Name="GF Ground floor" RangeStart="2304" RangeEnd="2559">/);
        assert.match(xml, /<GroupAddress Name="LT - GF.LIV.L01 - SW" Address="1\/1\/1" DPTs="DPST-1-1" Description="Ceiling &lt;A&amp;B&gt; &quot;main&quot;" \/>/);
        for (const id of ["DPST-5-100", "DPST-20-105", "DPST-9-1", "DPST-1-18", "DPST-9-4"]) assert.ok(xml.includes(`DPTs="${id}"`), id);
        assert.equal((xml.match(/<GroupRange /g) ?? []).length, (xml.match(/<\/GroupRange>/g) ?? []).length, "balanced ranges");
        assert.equal((xml.match(/<GroupAddress /g) ?? []).length, gas.length);
        const back = parseEtsExport(xml);
        assert.deepEqual(back.entries.map(e => e.ga).sort(), gas.map(g => g.ga).sort(), "our XML reads back");
        assert.equal(back.entries.find(e => e.ga === "1/1/1")?.dpt, "1.001");
        const csv = buildEtsCsv(gas);
        assert.ok(csv.startsWith('\ufeff"Main","Middle","Sub","Address"'));
        assert.match(csv, /"Lighting","","","1\/-\/-"/);
        assert.match(csv, /"","","HVAC - 1F.MBR.AC01 - FAN","3\/2\/8","","","","DPST-5-100","Auto"/);
        assert.deepEqual(parseEtsExport(csv).entries.length, gas.length, "our CSV reads back");
    });

    test("import CSV: 1-level with BOM and ';', duplicates, 2-level and bad addresses", () => {
        const text = '\ufeff"Group name";"Address";"Central";"Unfiltered";"Description";"DatapointType";"Security"\r\n'
            + '"Kitchen; spot";"1/2/3";"";"";"";"DPST-1-1";"Auto"\r\n'
            + '"Blind ""west""";"2/0/10";"";"";"";"";"Auto"\r\n'
            + '"Again";"1/2/3";"";"";"";"";"Auto"\r\n'
            + '"Two level";"1/300";"";"";"";"";"Auto"\r\n'
            + '"Bad";"40/1/1";"";"";"";"";"Auto"\r\n';
        const r = parseEtsExport(text);
        assert.equal(r.format, "csv");
        assert.deepEqual(r.entries, [{ ga: "1/2/3", name: "Kitchen; spot", dpt: "1.001" }, { ga: "2/0/10", name: 'Blind "west"' }]);
        assert.deepEqual(r.duplicates, ["1/2/3"]);
        assert.deepEqual(r.errors.map(e => `${e.line} ${e.code}`), ["5 address_level", "6 address_format"]);
    });

    test("import CSV: ETS 3-level, comma; and without header", () => {
        const text = '"Main","Middle","Sub","Address","Central","Unfiltered","Description","DatapointType","Security"\n'
            + '"Lighting","","","1/-/-","","","","","Auto"\n"","Ground","","1/1/-","","","","","Auto"\n'
            + '"","","Hall light","1/1/7","","","desc","DPST-5-1","Auto"\n';
        assert.deepEqual(parseEtsExport(text).entries, [{ ga: "1/1/7", name: "Hall light", dpt: "5.001" }]);
        assert.deepEqual(parseEtsExport("Hall,1/1/7\nStair,1/1/8\n").entries.map(e => `${e.name} ${e.ga}`), ["Hall 1/1/7", "Stair 1/1/8"]);
    });

    test("import XML: nested ranges, entities, BOM", () => {
        const xml = '\ufeff<?xml version="1.0" encoding="utf-8"?>\n<GroupAddress-Export xmlns="http://knx.org/xml/ga-export/01">\n'
            + '<GroupRange Name="Light" RangeStart="2048" RangeEnd="4095"><GroupRange Name="GF" RangeStart="2304" RangeEnd="2559">\n'
            + '<GroupAddress Name="Bad &amp; good &#233;" Address="1/1/9" DPTs="DPST-9-1" Description="x" />\n'
            + "<GroupAddress Name='Single' Address='1/1/10'/>\n"
            + "</GroupRange></GroupRange></GroupAddress-Export>";
        const r = parseEtsExport(xml);
        assert.equal(r.format, "xml");
        assert.deepEqual(r.entries, [{ ga: "1/1/9", name: "Bad & good \u00e9", dpt: "9.001" }, { ga: "1/1/10", name: "Single" }]);
    });
});

describe("planner plugin", () => {
    const dir = mkdtempSync(join(tmpdir(), "planner-"));
    test("loads an ES module planner and uses it; default is the built-in planner", async () => {
        const file = join(dir, "tiny.mjs");
        writeFileSync(file, `export default {
    name: "tiny",
    plan(input) {
        const gas = input.circuits.map((c, i) => ({ ga: "9/0/" + (i + 1), name: "T " + c.name, dpt: "1.001", deviceId: c.id, objectKey: "SW", isStatus: false, rangePath: ["Tiny", "All"] }));
        return { scheme: "tiny-1", gas, issues: [], stats: { total: gas.length, bySystem: { Tiny: gas.length }, maxUtilization: null } };
    },
};
`);
        const planner = await loadPlanner(file);
        assert.equal(planner.name, "tiny");
        const p = buildPlan(project(), baseConfig(), planner);
        assert.equal(p.result.scheme, "tiny-1");
        assert.equal(p.objects.find(o => o.name === "T GF.LIV.L02")?.bind, "light.2.on");
        assert.equal((await loadPlanner(undefined)).name, "builtin");
    });

    test("a module without a planner, or a missing module, fails clearly", async () => {
        const file = join(dir, "empty.mjs");
        writeFileSync(file, "export const x = 1;\n");
        await assert.rejects(loadPlanner(file), /must export a GaPlanner/);
        await assert.rejects(loadPlanner(join(dir, "nope.mjs")), /cannot load module/);
        assert.throws(() => parseConfig({ admin: { password: "test-password", planner_module: 5 } }), /admin.planner_module/);
        assert.equal(parseConfig({ admin: { password: "test-password", planner_module: "./p.mjs" } }).admin?.planner_module, "./p.mjs");
    });

    test("a planner returning garbage gives a clear error", () => {
        const bad: GaPlanner = { name: "bad", plan: () => ({}) as never };
        assert.throws(() => buildPlan(project(), baseConfig(), bad), /planner bad: plan\(\) must return/);
    });
});

describe("circuit type suggestion", () => {
    test("AC controller: hvac.unit without the fan/humidity endpoints; 4-gang switch: 4 lt.onoff", () => {
        const ac: NodeView = { node_id: 4, available: true, attributes: { "0/40/1": "Acme", "0/62/3": 5, "0/62/2": 5, "1/513/0": 3000, "1/29/0": [{ "0": 769 }], "2/514/0": 2, "3/1029/0": 5800 } };
        const d = describeNode(ac);
        assert.equal(d.endpoints.length, 1);
        assert.equal(d.endpoints[0].suggested, "hvac.unit");
        assert.deepEqual(d.fabrics, { used: 5, supported: 5 });
        const sw4: NodeView = { node_id: 5, available: true, attributes: { "1/6/0": false, "1/3/0": 0, "2/6/0": false, "3/6/0": true, "4/6/0": false } };
        const j = describeNode(sw4);
        assert.deepEqual(j.endpoints.map(e => e.suggested), ["lt.onoff", "lt.onoff", "lt.onoff", "lt.onoff"]);
        assert.equal(j.endpoints[0].hasIdentify, true);
    });
});

class FakeMatter implements MatterPort {
    connected = true;
    commands: Array<{ nodeId: number; endpoint: number; cluster: number; name: string; timed?: number }> = [];
    start() {}
    stop() {}
    node() { return undefined; }
    listNodes(): NodeView[] {
        return [{ node_id: 5, available: true, attributes: { "0/40/1": "Acme", "1/6/0": false, "1/3/0": 0 } }];
    }
    async command(nodeId: number, endpoint: number, cluster: number, name: string, _p?: unknown, opts?: { timedRequestTimeoutMs?: number }) {
        this.commands.push(opts?.timedRequestTimeoutMs ? { nodeId, endpoint, cluster, name, timed: opts.timedRequestTimeoutMs } : { nodeId, endpoint, cluster, name });
    }
    async write() {}
    async read() {}
    onNodeChanged() {}
    onNodeEvent(_cb: (e: NodeEventView) => void) {}
    onConnection() {}
}

describe("admin API on 2401", () => {
    const dir = mkdtempSync(join(tmpdir(), "admin-"));
    const configPath = join(dir, "config.json");
    const projectPath = join(dir, "project.json");
    let applied: BridgeConfig | undefined;
    let cfg: BridgeConfig;
    let server: AdminServer;
    let base = "";
    const matter = new FakeMatter();
    const auth = { Authorization: "Basic " + Buffer.from("admin:test-password").toString("base64") };
    const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = auth) => {
        const r = await fetch(base + path, { method, headers: { ...headers, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
    };

    before(async () => {
        const raw = {
            lights: { "1": { node_id: 5, endpoint: 1 }, "3": { node_id: 5, endpoint: 3 } },
            thermostats: { "1": { node_id: 4, endpoint: 1 } },
            knx: { host_ip: "127.0.0.1", objects: [] },
            admin: { password: "test-password", project_path: projectPath, port: 0 },
        };
        writeFileSync(configPath, JSON.stringify(raw));
        cfg = parseConfig(raw);
        server = new AdminServer({ ...cfg.admin!, host: "127.0.0.1", port: 0 }, {
            configPath,
            getConfig: () => cfg,
            applyConfig: c => { applied = c; cfg = c; },
            matter,
            status: () => ({ ok: true }),
            uiDir: join(dir, "no-ui"),
        });
        await server.listen();
        base = `http://127.0.0.1:${server.port}`;
    });
    after(() => server.close());

    test("no login: 401; wrong password: 401", async () => {
        assert.equal((await api("GET", "/api/status", undefined, {})).status, 401);
        const bad = { Authorization: "Basic " + Buffer.from("admin:wrong").toString("base64") };
        assert.equal((await api("GET", "/api/status", undefined, bad)).status, 401);
    });

    test("status, nodes, identify", async () => {
        const s = await api("GET", "/api/status");
        assert.equal(s.status, 200);
        assert.equal((s.json.project as { frozen: boolean }).frozen, false);
        const n = await api("GET", "/api/nodes");
        assert.equal(n.status, 200);
        const id = await api("POST", "/api/nodes/5/identify", { endpoint: 1 });
        assert.equal(id.status, 200);
        assert.deepEqual(matter.commands.at(-1), { nodeId: 5, endpoint: 1, cluster: 3, name: "identify" });
    });

    test("PUT project: bad name gives 422, valid project is saved", async () => {
        const p = project();
        const bad = { ...p, assignments: [{ ...p.assignments[0], name: "Living room light" }] };
        const r1 = await api("PUT", "/api/project", bad);
        assert.equal(r1.status, 422);
        const r2 = await api("PUT", "/api/project", p);
        assert.equal(r2.status, 200);
        assert.equal(JSON.parse(readFileSync(projectPath, "utf8")).assignments.length, 4);
    });

    test("apply needs confirm; then writes config.json and loads it into the bridge", async () => {
        assert.equal((await api("POST", "/api/apply", {})).status, 400);
        const r = await api("POST", "/api/apply", { confirm: true });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        const written = JSON.parse(readFileSync(configPath, "utf8"));
        assert.equal(written.lights["2"].node_id, 5);
        assert.ok(written.lights["3"], "unmanaged slot is kept");
        assert.ok(written.knx.objects.length > 10);
        assert.equal(written.admin.password, "test-password", "other keys are kept");
        assert.ok(written.knx.objects.every((o: KnxObjectConfig) => typeof o.bind === "string" && (o.dir === "cmd" || o.dir === "fb")));
        assert.ok(applied?.knx?.objects.length);
    });

    test("export: ETS XML + CSV, frozen; a later address change gives 409", async () => {
        const r = await api("POST", "/api/export", { confirm: true });
        assert.equal(r.status, 200);
        const files = r.json.files as Record<string, string>;
        const xml = files["matter-bridge-rev1-ets.xml"];
        assert.match(xml, /GroupAddress-Export/);
        assert.match(xml, /LT - GF.LIV.L01 - SW/);
        const p = project();
        p.assignments[0] = { ...p.assignments[0], floorCode: "1F", roomCode: "MBR", name: "1F.MBR.L02" };
        assert.equal((await api("PUT", "/api/project", p)).status, 200);
        const r2 = await api("POST", "/api/export", { confirm: true });
        assert.equal(r2.status, 409);
        const r3 = await api("POST", "/api/export", { confirm: true, acceptAddressChanges: true });
        assert.equal(r3.status, 200);
        assert.equal(r3.json.rev, 2);
    });

    test("ETS import reserves site addresses (own GAs skipped); overrides need consent for an imported address; clear", async () => {
        assert.equal((await api("POST", "/api/import-ets", { text: "nothing here" })).status, 422);
        const text = '"Group name";"Address"\n"Site light";"1/1/9"\n"LT - GF.LIV.L01 - SW";"1/1/1"\n"Two level";"1/9"\n"Site light";"1/1/9"\n';
        const r = await api("POST", "/api/import-ets", { text, file: "site.csv" });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.deepEqual([r.json.found, r.json.imported, r.json.own, r.json.reserved], [2, 1, 1, 1]);
        assert.deepEqual(r.json.duplicates, ["1/1/9"]);
        assert.equal((r.json.errors as unknown[]).length, 1);
        const saved = (await api("GET", "/api/project")).json as unknown as Project;
        assert.deepEqual(saved.reserved, [{ ga: "1/1/9", name: "Site light" }]);
        assert.equal(saved.reservedSource?.file, "site.csv");

        const put = (overrides: Project["overrides"]) => api("PUT", "/api/project", { ...saved, overrides, reserved: [] });
        const bad = await put({ "n5e1:SW": { ga: "1/1/9" } });
        assert.equal(bad.status, 422);
        assert.equal(((bad.json.detail as { errors: { code: string }[] }).errors)[0].code, "override_reserved");
        const ok = await put({ "n5e1:SW": { ga: "01/1/9", useImported: true } });
        assert.equal(ok.status, 200);
        assert.deepEqual((ok.json as unknown as Project).overrides, { "n5e1:SW": { ga: "1/1/9", useImported: true } }, "normalised");
        assert.deepEqual((ok.json as unknown as Project).reserved, saved.reserved, "PUT cannot change reserved addresses");
        const plan = await api("POST", "/api/plan");
        const gas = plan.json.gas as Array<{ key: string; ga: string; imported?: string; overridden?: boolean }>;
        assert.deepEqual(gas.find(g => g.key === "n5e1:SW"), { ...gas.find(g => g.key === "n5e1:SW"), ga: "1/1/9", imported: "Site light", overridden: true });
        const ex = await api("POST", "/api/export", { confirm: true, acceptAddressChanges: true });
        assert.equal(ex.status, 200);
        const xml = (ex.json.files as Record<string, string>)["matter-bridge-rev3-ets.xml"];
        assert.doesNotMatch(xml, /Address="1\/1\/9"/, "a GA using an imported address is not exported again");

        assert.equal((await api("DELETE", "/api/import-ets")).status, 200);
        assert.equal(((await api("GET", "/api/project")).json as unknown as Project).reserved, undefined);
    });
});

describe("Matter dashboard proxy: lock command filter", () => {
    const cmd = (command: string, args: unknown) => JSON.stringify({ message_id: "1", command, args });
    test("blocks unlockDoor / unboltDoor / batched, allows lockDoor and other commands", () => {
        assert.ok(blockReason(cmd("device_command", { node_id: 8, endpoint_id: 1, cluster_id: 257, command_name: "unlockDoor", payload: {} })));
        assert.ok(blockReason(cmd("device_command", { cluster_id: 257, command_name: "UnboltDoor" })));
        assert.ok(blockReason(cmd("device_command", { cluster_id: 257, command_name: "setCredential" })));
        assert.ok(blockReason(cmd("batched_device_commands", { commands: [{ cluster_id: 6, command_name: "on" }, { cluster_id: 257, command_name: "unlockWithTimeout" }] })));
        assert.ok(blockReason(cmd("write_attribute", { node_id: 8, attribute_path: "1/257/37", value: 0 })));
        assert.equal(blockReason(cmd("device_command", { cluster_id: 257, command_name: "lockDoor" })), undefined);
        assert.equal(blockReason(cmd("device_command", { cluster_id: 6, command_name: "toggle" })), undefined);
        assert.equal(blockReason(cmd("commission_with_code", { code: "34970112332" })), undefined);
        assert.ok(blockReason("not json"), "fail closed: matter-server reads some texts JSON.parse rejects");
        assert.ok(blockReason('{"command":"device_command","args":{"cluster_id":257,"command_name":"unlockDoor"},12345678901234567890:0}'), "big integer key");
        assert.ok(blockReason(cmd("write_attribute", { node_id: 8, attribute_path: "1/0257/37", value: 0 })), "leading zero in the cluster id");
        assert.equal(blockReason(cmd("write_attribute", { node_id: 8, attribute_path: "1/6/16385", value: 0 })), undefined);
    });
    test("reads masked frames, fragmented frames, incomplete frames", () => {
        const masked = (op: number, fin: boolean, text: string) => {
            const p = Buffer.from(text);
            const key = Buffer.from([1, 2, 3, 4]);
            const m = Buffer.from(p.map((b, i) => b ^ key[i & 3]));
            return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | op, 0x80 | p.length]), key, m]);
        };
        const a = masked(0x1, false, "{\"a\":");
        const b = masked(0x0, true, "1}");
        const { frames, rest } = readFrames(Buffer.concat([a, b, b.subarray(0, 3)]));
        assert.equal(frames.length, 2);
        assert.equal(Buffer.concat(frames.map(f => f.payload)).toString(), '{"a":1}');
        assert.equal(rest.length, 3);
        const big = wsFrame(0x1, Buffer.alloc(70000, 0x61));
        assert.equal(big[1], 127);
    });
});

describe("unlock PIN", () => {
    test("scrypt hash; 5 wrong attempts lock out for 5 minutes; a correct PIN resets the counter", () => {
        let now = 1_000_000;
        const g = new UnlockGuard(undefined, () => now);
        const h = hashPin("246813");
        assert.match(h, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
        assert.equal(g.check("246813", h), "ok");
        for (let i = 0; i < 4; i++) assert.equal(g.check("000000", h), "wrong");
        assert.equal(g.attemptsLeft, 1);
        assert.equal(g.check("000000", h), "locked");
        assert.equal(g.check("246813", h), "locked", "while locked out even the correct PIN is rejected");
        now += LOCKOUT_MS + 1;
        assert.equal(g.check("246813", h), "ok");
        assert.equal(g.check("12345", h), "wrong", "not 6 digits");
        assert.equal(g.attemptsLeft, 4);
    });
});

describe("lock API and session cookie", () => {
    const dir = mkdtempSync(join(tmpdir(), "admin-lock-"));
    const configPath = join(dir, "config.json");
    const matter = new FakeMatter();
    let server: AdminServer;
    let base = "";
    let upstream: net.Server;
    let upstreamGot = "";
    const upSockets = new Set<net.Socket>();
    const auth = { Authorization: "Basic " + Buffer.from("admin:test-password").toString("base64") };
    const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = auth) => {
        const r = await fetch(base + path, { method, headers: { ...headers, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: r.status, headers: r.headers, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
    };

    before(async () => {
        // fake matter-server: answers 101 then records every byte it receives
        upstream = net.createServer(sock => {
            upSockets.add(sock);
            let shook = false;
            sock.on("data", d => {
                if (!shook) {
                    shook = true;
                    sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
                    return;
                }
                upstreamGot += readFrames(d).frames.map(f => f.payload.toString()).join("|");
            });
        });
        await new Promise<void>(r => upstream.listen(0, "127.0.0.1", () => r()));
        const up = upstream.address() as net.AddressInfo;
        const raw = {
            matter_server: `ws://127.0.0.1:${up.port}/ws`,
            locks: { "1": { node_id: 8, endpoint: 1, name: "Front door" } },
            admin: { password: "test-password", port: 0, project_path: join(dir, "project.json"), audit_path: join(dir, "audit.log"), unlock_pin_hash: hashPin("246813") },
        };
        writeFileSync(configPath, JSON.stringify(raw));
        const cfg = parseConfig(raw);
        server = new AdminServer({ ...cfg.admin!, host: "127.0.0.1", port: 0 }, {
            configPath, getConfig: () => cfg, applyConfig: () => {}, matter, status: () => ({}), uiDir: join(dir, "ui"),
        });
        await server.listen();
        base = `http://127.0.0.1:${server.port}`;
    });
    after(async () => {
        await server.close();
        for (const x of upSockets) x.destroy();
        upstream.close();
    });

    test("Basic auth issues a session cookie; the cookie works instead of Basic", async () => {
        const r = await api("GET", "/api/locks");
        assert.equal(r.status, 200);
        const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
        assert.match(cookie, /^mb_session=[0-9a-f]{64}$/);
        assert.match(r.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Strict/);
        assert.equal((await api("GET", "/api/locks", undefined, { Cookie: cookie })).status, 200);
        assert.equal((await api("GET", "/api/locks", undefined, { Cookie: "mb_session=" + "0".repeat(64) })).status, 401);
    });

    test("unlock: wrong PIN 403 with 4 attempts left; correct PIN sends a timed unlockDoor; lock needs confirm", async () => {
        const l = await api("GET", "/api/locks");
        assert.equal(l.json.pinSet, true);
        const lock0 = (l.json.locks as Array<{ name: string; unlockEnabled: boolean; status: string }>)[0];
        assert.equal(lock0.name, "Front door");
        assert.equal(lock0.unlockEnabled, false, "admin PIN unlock does not depend on unlock_enabled");
        assert.equal(lock0.status, "Unknown");
        const w = await api("POST", "/api/locks/1/unlock", { pin: "111111" });
        assert.equal(w.status, 403);
        assert.equal(w.json.code, "pin_wrong");
        assert.equal((w.json.detail as { attemptsLeft: number }).attemptsLeft, 4);
        assert.equal(matter.commands.length, 0, "a wrong PIN sends nothing to the lock");
        const ok = await api("POST", "/api/locks/1/unlock", { pin: "246813" });
        assert.equal(ok.status, 200);
        assert.deepEqual(matter.commands.at(-1), { nodeId: 8, endpoint: 1, cluster: 257, name: "unlockDoor", timed: 10000 });
        assert.equal((await api("POST", "/api/locks/1/lock", {})).status, 400);
        assert.equal((await api("POST", "/api/locks/1/lock", { confirm: true })).status, 200);
        assert.equal(matter.commands.at(-1)?.name, "lockDoor");
        const log2 = (await api("GET", "/api/locks")).json.log as Array<{ result: string }>;
        assert.deepEqual(log2.map(e => e.result).slice(0, 2), ["unlocked", "wrong_pin"]);
        assert.match(readFileSync(join(dir, "audit.log"), "utf8"), /"unlocked"/);
    });

    test("changing the PIN needs the current PIN; the new PIN has 6 digits", async () => {
        assert.equal((await api("PUT", "/api/locks/pin", { current: "246813", next: "12" })).status, 422);
        assert.equal((await api("PUT", "/api/locks/pin", { current: "999999", next: "135790" })).status, 403);
        assert.equal((await api("PUT", "/api/locks/pin", { current: "246813", next: "135790" })).status, 200);
        assert.equal((await api("POST", "/api/locks/1/unlock", { pin: "135790" })).status, 200);
        assert.match(JSON.parse(readFileSync(configPath, "utf8")).admin.unlock_pin_hash, /^scrypt\$/);
    });

    test("WebSocket /matter/ws: needs login; unlockDoor is blocked with an error, other commands reach matter-server", async () => {
        const open = (headers: string) => new Promise<{ sock: net.Socket; first: string }>(resolve => {
            const sock = net.connect(server.port, "127.0.0.1");
            sock.once("data", d => resolve({ sock, first: d.toString() }));
            sock.write(`GET /matter/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${headers}\r\n`);
        });
        const noAuth = await open("");
        assert.match(noAuth.first, /^HTTP\/1.1 401/);
        noAuth.sock.destroy();

        const { sock, first } = await open(`Authorization: ${auth.Authorization}\r\n`);
        assert.match(first, /^HTTP\/1.1 101/);
        const send = (obj: unknown) => {
            const p = Buffer.from(JSON.stringify(obj));
            const key = Buffer.from([9, 8, 7, 6]);
            const len = p.length < 126 ? Buffer.from([0x81, 0x80 | p.length]) : Buffer.from([0x81, 0x80 | 126, p.length >> 8, p.length & 0xff]);
            sock.write(Buffer.concat([len, key, Buffer.from(p.map((b, i) => b ^ key[i & 3]))]));
        };
        const reply = new Promise<string>(resolve => sock.once("data", d => resolve(d.subarray(d[1] === 126 ? 4 : 2).toString())));
        send({ message_id: "7", command: "device_command", args: { node_id: 8, endpoint_id: 1, cluster_id: 257, command_name: "unlockDoor", payload: {} } });
        const err = JSON.parse(await reply);
        assert.equal(err.message_id, "7");
        assert.equal(err.error_code, 403);
        send({ message_id: "8", command: "device_command", args: { node_id: 5, endpoint_id: 1, cluster_id: 6, command_name: "toggle" } });
        await new Promise(r => setTimeout(r, 100));
        assert.match(upstreamGot, /"toggle"/);
        assert.doesNotMatch(upstreamGot, /unlockDoor/);
        // binary frame: matter-server parses it as JSON text too
        const binReply = new Promise<string>(resolve => sock.once("data", d => resolve(d.subarray(d[1] === 126 ? 4 : 2).toString())));
        const bin = Buffer.from(JSON.stringify({ message_id: "9", command: "device_command", args: { node_id: 8, endpoint_id: 1, cluster_id: 257, command_name: "unlockDoor" } }));
        const bkey = Buffer.from([1, 3, 5, 7]);
        sock.write(Buffer.concat([Buffer.from([0x82, 0x80 | 126, bin.length >> 8, bin.length & 0xff]), bkey, Buffer.from(bin.map((b, i) => b ^ bkey[i & 3]))]));
        assert.equal(JSON.parse(await binReply).message_id, "9");
        await new Promise(r => setTimeout(r, 50));
        assert.doesNotMatch(upstreamGot, /unlockDoor/);
        sock.destroy();
        const log2 = (await api("GET", "/api/locks")).json.log as Array<{ result: string }>;
        assert.equal(log2[0].result, "blocked_dashboard");

        // cross-site WebSocket (cached Basic credentials) is refused
        const xs = await open(`Authorization: ${auth.Authorization}\r\nOrigin: http://evil.example\r\n`);
        assert.match(xs.first, /^HTTP\/1.1 403/);
        xs.sock.destroy();
    });

    test("CSRF: a state-changing request from another origin is refused, same origin passes", async () => {
        const host = new URL(base).host;
        const x = await api("POST", "/api/locks/1/lock", { confirm: true }, { ...auth, Origin: "http://evil.example" });
        assert.equal(x.status, 403);
        const n = await api("POST", "/api/locks/1/lock", { confirm: true }, { ...auth, Origin: "null" });
        assert.equal(n.status, 403);
        const ok = await api("POST", "/api/locks/1/lock", { confirm: true }, { ...auth, Origin: `http://${host}` });
        assert.equal(ok.status, 200);
        assert.equal((await api("GET", "/api/locks", undefined, { ...auth, Origin: "http://evil.example" })).status, 200, "GET is not state-changing");
    });
});
