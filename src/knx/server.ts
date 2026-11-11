// Minimal KNXnet/IP tunnelling server (UDP 3671). KNX clients (visualisations, ETS...) connect directly:
// SEARCH (multicast) / DESCRIPTION -> CONNECT -> CONNECTIONSTATE (heartbeat) -> TUNNELING_REQUEST (cEMI).
// The bridge acts as a "virtual KNX bus": client group writes become commands, state becomes group telegrams.
import dgram from "node:dgram";
import os from "node:os";
import crypto from "node:crypto";
import {
    SVC, STATUS, CEMI, APCI, KNX_MULTICAST, KNX_PORT,
    parsePacket, packet, readHpai, hpai, deviceDibs, parseCemi, cemi, toConfirmation,
    parseIndividual, formatGroup, type GroupTelegram, type Hpai,
} from "./frames.ts";
import { log } from "../log.ts";

export interface KnxServerOptions {
    /** IP of the bridge host, used in HPAI. Empty: pick the first non-loopback IPv4. */
    hostIp?: string;
    port?: number;
    friendlyName: string;
    /** Individual address of the bridge "interface". */
    individualAddress: string;
    /** Address of the first tunnel; further tunnels count up. */
    tunnelAddress: string;
    maxTunnels?: number;
    onGroupWrite: (ga: number, t: GroupTelegram) => void;
    /** Current value to answer GroupValue_Read, undefined when there is none. */
    onGroupRead: (ga: number) => number | Buffer | undefined;
}

interface Tunnel {
    channel: number;
    individual: number;
    control: Hpai;
    data: Hpai;
    seqIn: number; // next sequence number expected from the client
    seqOut: number;
    lastSeen: number;
    pending: Map<number, { frame: Buffer; timer: NodeJS.Timeout; tries: number }>;
}

const HEARTBEAT_TIMEOUT_MS = 120_000;

function pickIPv4(): string {
    for (const addrs of Object.values(os.networkInterfaces())) {
        for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
    }
    return "127.0.0.1";
}

export class KnxServer {
    #o: Required<Omit<KnxServerOptions, "hostIp">> & { hostIp: string };
    #sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    #tunnels = new Map<number, Tunnel>();
    #nextChannel = 1;
    #ia: number;
    #serial = crypto.randomBytes(6);
    #mac = Buffer.alloc(6);
    #sweep: NodeJS.Timeout | undefined;

    constructor(opts: KnxServerOptions) {
        // No spread for defaults: config may pass port: undefined.
        this.#o = { ...opts, port: opts.port ?? KNX_PORT, maxTunnels: opts.maxTunnels ?? 8, hostIp: opts.hostIp || pickIPv4() };
        this.#ia = parseIndividual(opts.individualAddress);
        const mac = Object.values(os.networkInterfaces()).flat().find(a => a && !a.internal && a.mac !== "00:00:00:00:00:00")?.mac;
        if (mac) Buffer.from(mac.replace(/:/g, ""), "hex").copy(this.#mac);
    }

    get tunnelCount(): number {
        return this.#tunnels.size;
    }

    listen(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.#sock.once("error", reject);
            this.#sock.on("message", (msg, rinfo) => this.#onMessage(msg, rinfo));
            this.#sock.bind(this.#o.port, () => {
                this.#sock.off("error", reject);
                this.#sock.on("error", e => log.warn("knx", e.message));
                try {
                    this.#sock.addMembership(KNX_MULTICAST, this.#o.hostIp);
                } catch (e) {
                    log.warn("knx", `cannot join multicast ${KNX_MULTICAST}: ${(e as Error).message} (search will not find the bridge, direct connections still work)`);
                }
                this.#sweep = setInterval(() => this.#expire(), 10_000);
                log.info("knx", `KNXnet/IP tunneling server ${this.#o.hostIp}:${this.port} "${this.#o.friendlyName}" (${this.#o.individualAddress})`);
                resolve();
            });
        });
    }

    get port(): number {
        try {
            return this.#sock.address().port;
        } catch {
            return this.#o.port;
        }
    }

    close(): Promise<void> {
        clearInterval(this.#sweep);
        for (const t of this.#tunnels.values()) this.#dropTunnel(t, "server stopped");
        return new Promise(r => this.#sock.close(() => r()));
    }

    /** Sends a group telegram to every tunnel (like a device on the bus). */
    sendGroup(ga: number, apci: number, value: number | Buffer): void {
        for (const t of this.#tunnels.values()) this.#sendCemi(t, cemi(CEMI.L_DATA_IND, this.#ia, ga, apci, value));
    }

    // ------------------------------------------------------------ receive

    #send(buf: Buffer, to: Hpai): void {
        this.#sock.send(buf, to.port, to.ip);
    }

    /** HPAI 0.0.0.0:0 (NAT / route back): reply to the source address. */
    #endpoint(h: Hpai, rinfo: dgram.RemoteInfo): Hpai {
        return h.ip === "0.0.0.0" || h.port === 0 ? { ip: rinfo.address, port: rinfo.port } : h;
    }

    #onMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
        const p = parsePacket(msg);
        if (!p) return;
        const b = p.body;
        try {
            switch (p.service) {
                case SVC.SEARCH_REQUEST: {
                    const to = this.#endpoint(readHpai(b, 0), rinfo);
                    this.#send(packet(SVC.SEARCH_RESPONSE, Buffer.concat([hpai(this.#o.hostIp, this.port), this.#dibs()])), to);
                    log.debug("knx", `search from ${rinfo.address}`);
                    return;
                }
                case SVC.DESCRIPTION_REQUEST: {
                    const to = this.#endpoint(readHpai(b, 0), rinfo);
                    this.#send(packet(SVC.DESCRIPTION_RESPONSE, this.#dibs()), to);
                    log.debug("knx", `description from ${rinfo.address}`);
                    return;
                }
                case SVC.CONNECT_REQUEST:
                    return this.#connect(b, rinfo);
                case SVC.CONNECTIONSTATE_REQUEST: {
                    const ch = b[0];
                    const t = this.#tunnels.get(ch);
                    const to = this.#endpoint(readHpai(b, 2), rinfo);
                    if (t) t.lastSeen = Date.now();
                    this.#send(packet(SVC.CONNECTIONSTATE_RESPONSE, Buffer.from([ch, t ? STATUS.NO_ERROR : STATUS.CONNECTION_ID])), to);
                    return;
                }
                case SVC.DISCONNECT_REQUEST: {
                    const ch = b[0];
                    const to = this.#endpoint(readHpai(b, 2), rinfo);
                    this.#send(packet(SVC.DISCONNECT_RESPONSE, Buffer.from([ch, STATUS.NO_ERROR])), to);
                    const t = this.#tunnels.get(ch);
                    if (t) this.#dropTunnel(t, "client disconnected");
                    return;
                }
                case SVC.DISCONNECT_RESPONSE:
                    return;
                case SVC.TUNNELING_REQUEST:
                    return this.#tunnelingRequest(b);
                case SVC.TUNNELING_ACK: {
                    const t = this.#tunnels.get(b[1]);
                    const p2 = t?.pending.get(b[2]);
                    if (t && p2) {
                        clearTimeout(p2.timer);
                        t.pending.delete(b[2]);
                    }
                    return;
                }
            }
        } catch (e) {
            log.warn("knx", `bad packet from ${rinfo.address}: ${(e as Error).message}`);
        }
    }

    #dibs(): Buffer {
        return deviceDibs({ individualAddress: this.#ia, serial: this.#serial, mac: this.#mac, friendlyName: this.#o.friendlyName });
    }

    #connect(b: Buffer, rinfo: dgram.RemoteInfo): void {
        const control = this.#endpoint(readHpai(b, 0), rinfo);
        const data = this.#endpoint(readHpai(b, 8), rinfo);
        const cri = b.subarray(16);
        const reply = (status: number, body = Buffer.alloc(0)) => {
            log.info("knx", `rejected CONNECT from ${rinfo.address}: status 0x${status.toString(16)} (CRI ${cri.toString("hex")}, ${this.#tunnels.size} tunnels)`);
            this.#send(packet(SVC.CONNECT_RESPONSE, Buffer.concat([Buffer.from([0, status]), body])), control);
        };
        if (cri[1] !== 0x04) return reply(STATUS.CONNECTION_TYPE); // TUNNEL_CONNECTION only
        if (cri[2] !== 0x02) return reply(STATUS.CONNECTION_OPTION); // TUNNEL_LINKLAYER only
        if (this.#tunnels.size >= this.#o.maxTunnels) {
            // A client that vanished (no DISCONNECT) holds its slot for up to 120 s. When full, free the tunnel silent
            // for the longest time if > 65 s (standard heartbeat is 60 s, a live client would have sent one).
            const idle = [...this.#tunnels.values()].filter(t => Date.now() - t.lastSeen > 65_000).sort((a, b) => a.lastSeen - b.lastSeen)[0];
            if (idle) this.#dropTunnel(idle, "slot released: silent > 65 s");
            else return reply(STATUS.NO_MORE_CONNECTIONS);
        }

        let channel = this.#nextChannel;
        while (this.#tunnels.has(channel)) channel = (channel % 255) + 1;
        this.#nextChannel = (channel % 255) + 1;
        const used = new Set([...this.#tunnels.values()].map(t => t.individual));
        // Allocate ascending addresses within the same line (x.y.0-255), never into another line.
        const base = parseIndividual(this.#o.tunnelAddress);
        let individual = base;
        while (used.has(individual) && (individual & 0xff) < 0xff) individual++;
        if (used.has(individual)) return reply(STATUS.NO_MORE_CONNECTIONS);
        const t: Tunnel = { channel, individual, control, data, seqIn: 0, seqOut: 0, lastSeen: Date.now(), pending: new Map() };
        this.#tunnels.set(channel, t);

        const crd = Buffer.from([4, 0x04, (individual >> 8) & 0xff, individual & 0xff]);
        const body = Buffer.concat([Buffer.from([channel, STATUS.NO_ERROR]), hpai(this.#o.hostIp, this.port), crd]);
        this.#send(packet(SVC.CONNECT_RESPONSE, body), control);
        log.info("knx", `tunnel ${channel} connected from ${rinfo.address} (data ${data.ip}:${data.port}), address ${individual >> 12}.${(individual >> 8) & 15}.${individual & 255}`);
    }

    #tunnelingRequest(b: Buffer): void {
        const ch = b[1];
        const seq = b[2];
        const t = this.#tunnels.get(ch);
        if (!t) return;
        t.lastSeen = Date.now();
        const ack = (status: number) => this.#send(packet(SVC.TUNNELING_ACK, Buffer.from([4, ch, seq, status])), t.data);
        // Repeated packet (client missed the ACK): ACK again, do not process twice.
        if (seq === ((t.seqIn - 1) & 0xff)) return ack(STATUS.NO_ERROR);
        if (seq !== t.seqIn) return; // out of order: drop, the client will resend
        t.seqIn = (t.seqIn + 1) & 0xff;
        ack(STATUS.NO_ERROR);

        const frame = b.subarray(b[0]);
        log.debug("knx", `tunnel ${ch} seq ${seq} cEMI ${frame.toString("hex")}`);
        if (frame[0] === CEMI.M_PROPREAD_REQ) return this.#propRead(t, frame);
        if (frame[0] !== CEMI.L_DATA_REQ) {
            log.info("knx", `tunnel ${ch}: cEMI message code 0x${frame[0].toString(16)} not supported, ignored`);
            return;
        }
        // Confirm with L_Data.con like a real interface, then hand over to the virtual bus.
        this.#sendCemi(t, toConfirmation(frame, t.individual));
        const tel = parseCemi(frame);
        if (!tel) {
            log.info("knx", `tunnel ${ch}: L_Data is not a group telegram (individual destination?), confirmed anyway: ${frame.toString("hex")}`);
            return;
        }
        // Other tunnels see the telegram as on a bus.
        const ind = Buffer.from(frame);
        ind[0] = CEMI.L_DATA_IND;
        const o = 2 + ind[1];
        if (ind.readUInt16BE(o + 2) === 0) ind.writeUInt16BE(t.individual, o + 2);
        for (const other of this.#tunnels.values()) if (other !== t) this.#sendCemi(other, ind);

        if (tel.apci === APCI.WRITE) {
            log.debug("knx", `write ${formatGroup(tel.destination)} ${tel.small ?? tel.data.toString("hex")}`);
            this.#o.onGroupWrite(tel.destination, tel);
        } else if (tel.apci === APCI.READ) {
            const v = this.#o.onGroupRead(tel.destination);
            log.debug("knx", `read ${formatGroup(tel.destination)} -> ${v === undefined ? "(none)" : String(v instanceof Buffer ? v.toString("hex") : v)}`);
            if (v !== undefined) this.#sendCemi(t, cemi(CEMI.L_DATA_IND, this.#ia, tel.destination, APCI.RESPONSE, v));
        }
    }

    /**
     * cEMI M_PropRead.req (cEMI server): [FC][IOT 2][OI][PID][NoE 4 bit | SIX 12 bit]. Answers M_PropRead.con.
     * Supports the few properties clients (ETS) usually ask for; others get "not found" (NoE = 0 + error code) so the client does not wait.
     */
    #propRead(t: Tunnel, req: Buffer): void {
        const iot = req.readUInt16BE(1);
        const pid = req[4];
        const noe = req[5] >> 4;
        const six = ((req[5] & 0x0f) << 8) | req[6];
        const head = Buffer.from(req.subarray(0, 7));
        head[0] = CEMI.M_PROPREAD_CON;
        let data: Buffer | undefined;
        // IOT 0 = Device object, IOT 8 = cEMI server object
        if (six === 1 || six === 0) {
            if (pid === 56) data = Buffer.from([0x00, 0xfe]); // PID_MAX_APDULENGTH = 254
            else if (pid === 11) data = Buffer.from(this.#serial); // PID_SERIAL_NUMBER
            else if (pid === 12) data = Buffer.from([0x00, 0x00]); // PID_MANUFACTURER_ID
            else if (pid === 83) data = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]); // PID_DEVICE_DESCRIPTOR / mask
            else if (pid === 52 && iot === 8) data = Buffer.from([0x00]); // PID_COMM_MODE: data link layer
        }
        if (six === 0 && data) data = Buffer.from([0x00, 0x01]); // number of elements
        let con: Buffer;
        if (data) {
            con = Buffer.concat([head, data]);
        } else {
            head[5] = (head[5] & 0x0f); // NoE = 0: error
            con = Buffer.concat([head, Buffer.from([0x07])]); // 0x07: void DP / does not exist
        }
        log.debug("knx", `M_PropRead IOT ${iot} PID ${pid} NoE ${noe} SIX ${six} -> ${data ? data.toString("hex") : "error"}`);
        this.#sendCemi(t, con);
    }

    #sendCemi(t: Tunnel, frame: Buffer): void {
        const seq = t.seqOut;
        t.seqOut = (t.seqOut + 1) & 0xff;
        const pkt = packet(SVC.TUNNELING_REQUEST, Buffer.concat([Buffer.from([4, t.channel, seq, 0]), frame]));
        this.#send(pkt, t.data);
        // Resend once when no ACK arrives within 1 s (KNXnet/IP tunnelling); still none: drop the tunnel.
        const timer = setTimeout(() => {
            const p = t.pending.get(seq);
            if (!p) return;
            if (p.tries >= 1) {
                t.pending.delete(seq);
                this.#dropTunnel(t, "no ACK");
                return;
            }
            p.tries++;
            this.#send(pkt, t.data);
            p.timer = setTimeout(() => {
                if (t.pending.has(seq)) {
                    t.pending.delete(seq);
                    this.#dropTunnel(t, "no ACK");
                }
            }, 1000);
        }, 1000);
        t.pending.set(seq, { frame, timer, tries: 0 });
    }

    #dropTunnel(t: Tunnel, reason: string): void {
        if (!this.#tunnels.has(t.channel)) return;
        for (const p of t.pending.values()) clearTimeout(p.timer);
        this.#tunnels.delete(t.channel);
        this.#send(packet(SVC.DISCONNECT_REQUEST, Buffer.concat([Buffer.from([t.channel, 0]), hpai(this.#o.hostIp, this.port)])), t.control);
        log.info("knx", `tunnel ${t.channel} closed: ${reason}`);
    }

    #expire(): void {
        const now = Date.now();
        for (const t of [...this.#tunnels.values()]) {
            if (now - t.lastSeen > HEARTBEAT_TIMEOUT_MS) this.#dropTunnel(t, "no heartbeat for 120 s");
        }
    }
}
