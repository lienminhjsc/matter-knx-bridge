// KNXnet/IP tunnelling server tests: a UDP client plays the KNX client (visualisation / ETS).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { KnxGateway } from "../src/knx/gateway.ts";
import type { ChannelValue } from "../src/channels.ts";
import {
    SVC, CEMI, APCI, packet, parsePacket, hpai, cemi, parseCemi, parseGroup, formatGroup, dpt5001,
    parseIndividual, formatIndividual,
} from "../src/knx/frames.ts";
import { log } from "../src/log.ts";

log.setLevel("error");

/** Fake KNXnet/IP client: sends packets and collects what it receives. */
class FakeClient {
    sock = dgram.createSocket("udp4");
    got: Array<{ service: number; body: Buffer }> = [];
    port = 0;
    channel = 0;
    seq = 0;
    server: number;
    constructor(server: number) {
        this.server = server;
    }
    async open() {
        await new Promise<void>(r => this.sock.bind(0, "127.0.0.1", () => r()));
        this.port = this.sock.address().port;
        this.sock.on("message", m => {
            const p = parsePacket(m);
            if (!p) return;
            this.got.push(p);
            // ACK every TUNNELING_REQUEST from the server, like a real client
            if (p.service === SVC.TUNNELING_REQUEST) this.send(SVC.TUNNELING_ACK, Buffer.from([4, p.body[1], p.body[2], 0]));
        });
    }
    send(service: number, body: Buffer) {
        this.sock.send(packet(service, body), this.server, "127.0.0.1");
    }
    me() {
        return hpai("127.0.0.1", this.port);
    }
    async wait(pred: (p: { service: number; body: Buffer }) => boolean, ms = 1500) {
        const t0 = Date.now();
        for (;;) {
            const i = this.got.findIndex(pred);
            if (i >= 0) return this.got.splice(i, 1)[0];
            if (Date.now() - t0 > ms) throw new Error("expected packet not received; got: " + this.got.map(g => g.service.toString(16)).join(","));
            await new Promise(r => setTimeout(r, 5));
        }
    }
    /** TUNNELING_REQUEST carrying cEMI from the server, decoded. */
    async waitCemi(mc: number, ga: string, apci?: number) {
        const p = await this.wait(q => {
            if (q.service !== SVC.TUNNELING_REQUEST) return false;
            const t = parseCemi(q.body.subarray(q.body[0]));
            return !!t && t.messageCode === mc && formatGroup(t.destination) === ga && (apci === undefined || t.apci === apci);
        });
        return parseCemi(p.body.subarray(p.body[0]))!;
    }
    tunnel(frame: Buffer) {
        this.send(SVC.TUNNELING_REQUEST, Buffer.concat([Buffer.from([4, this.channel, this.seq, 0]), frame]));
        this.seq = (this.seq + 1) & 0xff;
    }
    close() {
        this.sock.close();
    }
}

describe("KNXnet/IP tunnelling", () => {
    let gw: KnxGateway;
    let sv: FakeClient;
    const lines: string[] = [];
    const states: Record<string, ChannelValue> = { "light.1.on": false, "light.2.level": 40 };

    before(async () => {
        gw = new KnxGateway(
            {
                enabled: true,
                port: 0,
                host_ip: "127.0.0.1",
                friendly_name: "Matter Bridge",
                individual_address: "15.15.250",
                tunnel_address: "15.15.240",
                objects: [
                    { ga: "1/1/1", dpt: "1.001", bind: "light.1.on", dir: "cmd" },
                    { ga: "1/1/2", dpt: "1.001", bind: "light.1.on", dir: "fb" },
                    { ga: "1/2/1", dpt: "5.001", bind: "light.2.level", dir: "cmd" },
                    { ga: "1/2/2", dpt: "5.001", bind: "light.2.level", dir: "fb" },
                    // One GA driving two channels, like a KNX group.
                    { ga: "1/0/0", dpt: "1.001", bind: "light.1.on", dir: "cmd" },
                    { ga: "1/0/0", dpt: "1.001", bind: "light.2.on", dir: "cmd" },
                ],
            },
            { command: (ch, v) => lines.push(`${ch}=${String(v)}`), value: ch => states[ch] },
        );
        await gw.listen();
        sv = new FakeClient(gw.server.port);
        await sv.open();
    });

    after(async () => {
        sv.close();
        await gw.close();
    });

    test("DESCRIPTION: has the Tunnelling service and the friendly name", async () => {
        sv.send(SVC.DESCRIPTION_REQUEST, sv.me());
        const p = await sv.wait(q => q.service === SVC.DESCRIPTION_RESPONSE);
        assert.equal(p.body[1], 0x01); // DEVICE_INFO
        assert.equal(p.body.subarray(24, 24 + 13).toString("latin1"), "Matter Bridge");
        const svc = p.body.subarray(54);
        assert.equal(svc[1], 0x02);
        const fams = [];
        for (let i = 2; i < svc[0]; i += 2) fams.push(svc[i]);
        assert.ok(fams.includes(0x04), "must list Tunnelling (0x04)");
    });

    test("SEARCH returns the control HPAI", async () => {
        sv.send(SVC.SEARCH_REQUEST, sv.me());
        const p = await sv.wait(q => q.service === SVC.SEARCH_RESPONSE);
        assert.equal(p.body.readUInt16BE(6), gw.server.port);
    });

    test("CONNECT tunnel link layer: assigns a channel and the first tunnel address", async () => {
        const cri = Buffer.from([4, 0x04, 0x02, 0x00]);
        sv.send(SVC.CONNECT_REQUEST, Buffer.concat([sv.me(), sv.me(), cri]));
        const p = await sv.wait(q => q.service === SVC.CONNECT_RESPONSE);
        assert.equal(p.body[1], 0, "status 0");
        sv.channel = p.body[0];
        assert.ok(sv.channel > 0);
        const crd = p.body.subarray(10);
        assert.equal(formatIndividual(crd.readUInt16BE(2)), "15.15.240");
        assert.equal(gw.server.tunnelCount, 1);
    });

    test("CONNECTIONSTATE heartbeat answers no error", async () => {
        sv.send(SVC.CONNECTIONSTATE_REQUEST, Buffer.concat([Buffer.from([sv.channel, 0]), sv.me()]));
        const p = await sv.wait(q => q.service === SVC.CONNECTIONSTATE_RESPONSE);
        assert.deepEqual([...p.body], [sv.channel, 0]);
    });

    test("client writes 1/1/1 = 1: ACK, L_Data.con, light.1.on = true to the bridge", async () => {
        sv.tunnel(cemi(CEMI.L_DATA_REQ, 0, parseGroup("1/1/1"), APCI.WRITE, 1));
        const ack = await sv.wait(q => q.service === SVC.TUNNELING_ACK);
        assert.equal(ack.body[3], 0);
        const con = await sv.waitCemi(CEMI.L_DATA_CON, "1/1/1");
        assert.equal(formatIndividual(con.source), "15.15.240", "the confirmation carries the tunnel address");
        assert.equal(lines.pop(), "light.1.on=true");
        sv.tunnel(cemi(CEMI.L_DATA_REQ, 0, parseGroup("1/1/1"), APCI.WRITE, 0));
        await sv.waitCemi(CEMI.L_DATA_CON, "1/1/1");
        assert.equal(lines.pop(), "light.1.on=false");
    });

    test("channel change: the bridge sends GroupValue_Write to 1/1/2", async () => {
        states["light.1.on"] = true;
        gw.channelChanged("light.1.on", true);
        const ind = await sv.waitCemi(CEMI.L_DATA_IND, "1/1/2", APCI.WRITE);
        assert.equal(ind.small, 1);
        assert.equal(formatIndividual(ind.source), "15.15.250");
    });

    test("client reads 1/1/2: GroupValue_Response with the current value", async () => {
        sv.tunnel(cemi(CEMI.L_DATA_REQ, 0, parseGroup("1/1/2"), APCI.READ, 0));
        const resp = await sv.waitCemi(CEMI.L_DATA_IND, "1/1/2", APCI.RESPONSE);
        assert.equal(resp.small, 1);
    });

    test("DPT 5.001: write 40 % -> light.2.level = 40, read -> 40 %", async () => {
        sv.tunnel(cemi(CEMI.L_DATA_REQ, 0, parseGroup("1/2/1"), APCI.WRITE, dpt5001.encode(40)));
        await sv.waitCemi(CEMI.L_DATA_CON, "1/2/1");
        assert.equal(lines.pop(), "light.2.level=40");
        sv.tunnel(cemi(CEMI.L_DATA_REQ, 0, parseGroup("1/2/2"), APCI.READ, 0));
        const r = await sv.waitCemi(CEMI.L_DATA_IND, "1/2/2", APCI.RESPONSE);
        assert.equal(dpt5001.decode(r), 40);
    });

    test("one GA bound to two channels commands both", async () => {
        lines.length = 0;
        sv.tunnel(cemi(CEMI.L_DATA_REQ, 0, parseGroup("1/0/0"), APCI.WRITE, 1));
        await sv.waitCemi(CEMI.L_DATA_CON, "1/0/0");
        assert.deepEqual(lines, ["light.1.on=true", "light.2.on=true"]);
    });

    test("a repeated packet (same seq) is only ACKed, the command does not run twice", async () => {
        const before = lines.length;
        sv.seq = (sv.seq - 1) & 0xff; // resend the previous seq
        sv.tunnel(cemi(CEMI.L_DATA_REQ, 0, parseGroup("1/1/1"), APCI.WRITE, 1));
        await sv.wait(q => q.service === SVC.TUNNELING_ACK);
        await new Promise(r => setTimeout(r, 50));
        assert.equal(lines.length, before);
    });

    test("M_PropRead.req (ETS asks MAX_APDULENGTH) answers M_PropRead.con", async () => {
        // [FC][IOT 0000][OI 01][PID 38][NoE 1 | SIX 001]
        sv.tunnel(Buffer.from([0xfc, 0x00, 0x00, 0x01, 56, 0x10, 0x01]));
        const p = await sv.wait(q => q.service === SVC.TUNNELING_REQUEST && q.body[q.body[0]] === 0xfb);
        const con = p.body.subarray(p.body[0]);
        assert.equal(con[4], 56);
        assert.equal(con.readUInt16BE(7), 254);
        // Unknown property: NoE = 0 + error code
        sv.tunnel(Buffer.from([0xfc, 0x00, 0x00, 0x01, 200, 0x10, 0x01]));
        const p2 = await sv.wait(q => q.service === SVC.TUNNELING_REQUEST && q.body[q.body[0]] === 0xfb);
        const c2 = p2.body.subarray(p2.body[0]);
        assert.equal(c2[5] >> 4, 0);
    });

    test("DISCONNECT closes the tunnel", async () => {
        sv.send(SVC.DISCONNECT_REQUEST, Buffer.concat([Buffer.from([sv.channel, 0]), sv.me()]));
        const p = await sv.wait(q => q.service === SVC.DISCONNECT_RESPONSE);
        assert.deepEqual([...p.body], [sv.channel, 0]);
        assert.equal(gw.server.tunnelCount, 0);
    });
});

describe("frames", () => {
    test("group / individual address", () => {
        assert.equal(formatGroup(parseGroup("1/1/1")), "1/1/1");
        assert.equal(parseGroup("31/7/255"), 0xffff);
        assert.equal(formatIndividual(parseIndividual("15.15.250")), "15.15.250");
        assert.throws(() => parseGroup("32/0/0"));
    });
    test("cEMI DPT 1 and DPT 5 encode / decode", () => {
        const a = parseCemi(cemi(CEMI.L_DATA_REQ, 0x1101, parseGroup("2/3/4"), APCI.WRITE, 1))!;
        assert.equal(formatGroup(a.destination), "2/3/4");
        assert.equal(a.apci, APCI.WRITE);
        assert.equal(a.small, 1);
        const b = parseCemi(cemi(CEMI.L_DATA_IND, 0x1101, parseGroup("2/3/5"), APCI.RESPONSE, dpt5001.encode(100)))!;
        assert.equal(b.apci, APCI.RESPONSE);
        assert.equal(b.data[0], 255);
    });
});

describe("tunnel limit", () => {
    test("max_tunnels = 2: the third tunnel is rejected with 0x24 while no tunnel is idle", async () => {
        const gw = new KnxGateway(
            { enabled: true, port: 0, host_ip: "127.0.0.1", friendly_name: "T", individual_address: "15.15.250", tunnel_address: "15.15.240", max_tunnels: 2, objects: [] },
            { command: () => {}, value: () => undefined },
        );
        await gw.listen();
        const sv = new FakeClient(gw.server.port);
        await sv.open();
        const cri = Buffer.from([4, 0x04, 0x02, 0x00]);
        const statuses: number[] = [];
        const addrs: string[] = [];
        for (let i = 0; i < 3; i++) {
            sv.send(SVC.CONNECT_REQUEST, Buffer.concat([sv.me(), sv.me(), cri]));
            const p = await sv.wait(q => q.service === SVC.CONNECT_RESPONSE);
            statuses.push(p.body[1]);
            if (p.body[1] === 0) addrs.push(formatIndividual(p.body.subarray(10).readUInt16BE(2)));
        }
        assert.deepEqual(statuses, [0, 0, 0x24]);
        assert.deepEqual(addrs, ["15.15.240", "15.15.241"]);
        sv.close();
        await gw.close();
    });
});
