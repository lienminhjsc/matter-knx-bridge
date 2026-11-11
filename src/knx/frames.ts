// Encoding / decoding of KNXnet/IP packets (core + tunnelling) and cEMI L_Data group telegrams.
// Per KNX Standard 03_08_02 (Core), 03_08_04 (Tunnelling), 03_06_03 (cEMI). Only what the bridge needs.

export const SVC = {
    SEARCH_REQUEST: 0x0201,
    SEARCH_RESPONSE: 0x0202,
    DESCRIPTION_REQUEST: 0x0203,
    DESCRIPTION_RESPONSE: 0x0204,
    CONNECT_REQUEST: 0x0205,
    CONNECT_RESPONSE: 0x0206,
    CONNECTIONSTATE_REQUEST: 0x0207,
    CONNECTIONSTATE_RESPONSE: 0x0208,
    DISCONNECT_REQUEST: 0x0209,
    DISCONNECT_RESPONSE: 0x020a,
    TUNNELING_REQUEST: 0x0420,
    TUNNELING_ACK: 0x0421,
} as const;

export const STATUS = {
    NO_ERROR: 0x00,
    CONNECTION_ID: 0x21,
    CONNECTION_TYPE: 0x22,
    CONNECTION_OPTION: 0x23,
    NO_MORE_CONNECTIONS: 0x24,
} as const;

export const CEMI = { L_DATA_REQ: 0x11, L_DATA_CON: 0x2e, L_DATA_IND: 0x29, M_PROPREAD_REQ: 0xfc, M_PROPREAD_CON: 0xfb } as const;
export const APCI = { READ: 0x000, RESPONSE: 0x040, WRITE: 0x080 } as const;

export const KNX_MULTICAST = "224.0.23.12";
export const KNX_PORT = 3671;

export interface Hpai {
    ip: string;
    port: number;
}

export interface KnxPacket {
    service: number;
    body: Buffer;
}

export function parsePacket(buf: Buffer): KnxPacket | undefined {
    if (buf.length < 6 || buf[0] !== 0x06 || buf[1] !== 0x10) return undefined;
    const total = buf.readUInt16BE(4);
    if (total !== buf.length) return undefined;
    return { service: buf.readUInt16BE(2), body: buf.subarray(6) };
}

export function packet(service: number, body: Buffer): Buffer {
    const h = Buffer.alloc(6);
    h[0] = 0x06;
    h[1] = 0x10;
    h.writeUInt16BE(service, 2);
    h.writeUInt16BE(6 + body.length, 4);
    return Buffer.concat([h, body]);
}

export function readHpai(b: Buffer, off: number): Hpai {
    // len(1)=8, protocol(1) 01=UDP 02=TCP, IP(4), port(2)
    return { ip: `${b[off + 2]}.${b[off + 3]}.${b[off + 4]}.${b[off + 5]}`, port: b.readUInt16BE(off + 6) };
}

export function hpai(ip: string, port: number): Buffer {
    const b = Buffer.alloc(8);
    b[0] = 8;
    b[1] = 0x01;
    ip.split(".").forEach((p, i) => (b[2 + i] = Number(p)));
    b.writeUInt16BE(port, 6);
    return b;
}

export function parseIndividual(addr: string): number {
    const [a, l, d] = addr.split(".").map(Number);
    return ((a & 0x0f) << 12) | ((l & 0x0f) << 8) | (d & 0xff);
}

export function formatIndividual(v: number): string {
    return `${v >> 12}.${(v >> 8) & 0x0f}.${v & 0xff}`;
}

/** 3-level group address "main/middle/sub". */
export function parseGroup(addr: string): number {
    const p = addr.split("/").map(Number);
    if (p.length === 3 && p.every(Number.isInteger) && p[0] <= 31 && p[1] <= 7 && p[2] <= 255) {
        return (p[0] << 11) | (p[1] << 8) | p[2];
    }
    if (p.length === 2 && p[0] <= 31 && p[1] <= 2047) return (p[0] << 11) | p[1];
    throw new Error(`invalid group address: ${addr}`);
}

export function formatGroup(v: number): string {
    return `${v >> 11}/${(v >> 8) & 0x07}/${v & 0xff}`;
}

export interface DeviceInfo {
    individualAddress: number;
    serial: Buffer; // 6 byte
    mac: Buffer; // 6 byte
    friendlyName: string;
}

/** DIB DEVICE_INFO (54 byte) + DIB SUPP_SVC_FAMILIES (core, device mgmt, tunnelling v1). */
export function deviceDibs(info: DeviceInfo): Buffer {
    const dev = Buffer.alloc(54);
    dev[0] = 54;
    dev[1] = 0x01; // DEVICE_INFO
    dev[2] = 0x20; // KNX medium: KNX IP
    dev[3] = 0x00; // device status
    dev.writeUInt16BE(info.individualAddress, 4);
    dev.writeUInt16BE(0x0000, 6); // project installation id
    info.serial.copy(dev, 8, 0, 6);
    [224, 0, 23, 12].forEach((v, i) => (dev[14 + i] = v));
    info.mac.copy(dev, 18, 0, 6);
    Buffer.from(info.friendlyName.slice(0, 29), "latin1").copy(dev, 24);
    const fams = [
        [0x02, 0x01], // core
        [0x03, 0x01], // device management
        [0x04, 0x01], // tunnelling
    ];
    const svc = Buffer.alloc(2 + fams.length * 2);
    svc[0] = svc.length;
    svc[1] = 0x02; // SUPP_SVC_FAMILIES
    fams.forEach(([f, v], i) => {
        svc[2 + i * 2] = f;
        svc[3 + i * 2] = v;
    });
    return Buffer.concat([dev, svc]);
}

export interface GroupTelegram {
    messageCode: number;
    source: number;
    destination: number;
    apci: number; // READ / RESPONSE / WRITE
    /** 6-bit value (DPT 1.x) when data is empty; otherwise the data bytes. */
    small?: number;
    data: Buffer;
    raw: Buffer;
}

/** Decodes cEMI L_Data, group telegrams only (bit 7 of ctrl2). */
export function parseCemi(b: Buffer): GroupTelegram | undefined {
    if (b.length < 2) return undefined;
    const mc = b[0];
    const addInfo = b[1];
    const o = 2 + addInfo;
    if (b.length < o + 9) return undefined;
    const ctrl2 = b[o + 1];
    if ((ctrl2 & 0x80) === 0) return undefined; // individual address: ignored
    const source = b.readUInt16BE(o + 2);
    const destination = b.readUInt16BE(o + 4);
    const npduLen = b[o + 6];
    const tpdu = b.subarray(o + 7, o + 8 + npduLen);
    if (tpdu.length < 2) return undefined;
    const apciFull = ((tpdu[0] & 0x03) << 8) | tpdu[1];
    const apci = apciFull & 0x3c0;
    const data = tpdu.subarray(2);
    return {
        messageCode: mc,
        source,
        destination,
        apci,
        small: data.length === 0 ? tpdu[1] & 0x3f : undefined,
        data,
        raw: b,
    };
}

/** cEMI L_Data group telegram. value: 6-bit number (DPT 1.x) or data Buffer. */
export function cemi(messageCode: number, source: number, destination: number, apci: number, value: number | Buffer): Buffer {
    // [mc][addInfoLen=0][ctrl1][ctrl2][src 2][dst 2][npduLen][TPCI|APCI hi][APCI lo | 6-bit data][data...]
    const isSmall = typeof value === "number";
    const data = isSmall ? Buffer.alloc(0) : (value as Buffer);
    const b = Buffer.alloc(11 + data.length);
    b[0] = messageCode;
    b[1] = 0x00; // no additional info
    b[2] = 0xbc; // standard frame, no repeat, broadcast, priority low
    b[3] = 0xe0; // destination is a group address, hop count 6
    b.writeUInt16BE(source, 4);
    b.writeUInt16BE(destination, 6);
    b[8] = 1 + data.length; // NPDU length = bytes after TPCI
    b[9] = (apci >> 8) & 0x03; // TPCI = 0 (UDT) + 2 high bits of APCI
    b[10] = (apci & 0xff) | (isSmall ? (value as number) & 0x3f : 0);
    data.copy(b, 11);
    return b;
}

/** Turns a client L_Data.req into L_Data.con (positive confirmation). */
export function toConfirmation(req: Buffer, source: number): Buffer {
    const c = Buffer.from(req);
    c[0] = CEMI.L_DATA_CON;
    const o = 2 + c[1];
    c[o] &= 0xfe; // confirm bit = 0: success
    if (c.readUInt16BE(o + 2) === 0) c.writeUInt16BE(source, o + 2);
    return c;
}

// ------------------------------------------------------------ DPT

/** DPT 1.001 Switch. */
export const dpt1 = {
    encode: (v: boolean): number => (v ? 1 : 0),
    decode: (t: GroupTelegram): boolean | undefined => (t.small !== undefined ? (t.small & 1) === 1 : t.data.length ? (t.data[0] & 1) === 1 : undefined),
};

/** DPT 7.xxx: 2-byte unsigned (7.600 colour temperature K). */
export const dpt7 = {
    encode: (v: number): Buffer => {
        const b = Buffer.alloc(2);
        b.writeUInt16BE(Math.min(65535, Math.max(0, Math.round(v))));
        return b;
    },
    decode: (t: GroupTelegram): number | undefined => (t.data.length >= 2 ? t.data.readUInt16BE(0) : undefined),
};

/**
 * DPT 9.xxx: KNX 2-byte float. value = 0.01 * M * 2^E, M 12-bit two's complement (incl. sign bit), E 4 bit.
 * Range -671 088.64 to 670 433.28 (0x7FFF is reserved for "invalid"). 9.001 temperature, 9.004 lux, 9.007 humidity.
 */
export const dpt9 = {
    encode: (v: number): Buffer => {
        let m = Math.round(v * 100);
        let e = 0;
        while ((m < -2048 || m > 2047) && e < 15) {
            m = Math.round(m / 2);
            e++;
        }
        m = Math.min(2047, Math.max(-2048, m));
        let raw = (m < 0 ? 0x8000 : 0) | ((e & 0x0f) << 11) | (m & 0x07ff);
        if (raw === 0x7fff) raw = 0x7ffe; // 0x7FFF means "invalid"; the largest valid value is 670 433.28
        const b = Buffer.alloc(2);
        b.writeUInt16BE(raw);
        return b;
    },
    decode: (t: GroupTelegram): number | undefined => {
        if (t.data.length < 2) return undefined;
        const raw = t.data.readUInt16BE(0);
        if (raw === 0x7fff) return undefined; // invalid value per spec
        const e = (raw >> 11) & 0x0f;
        let m = raw & 0x07ff;
        if (raw & 0x8000) m -= 2048;
        return Math.round(m * 2 ** e) / 100;
    },
};

/** DPT 20.xxx: 1-byte enumeration (20.105 HVACContrMode). */
export const dpt20 = {
    encode: (v: number): Buffer => Buffer.from([Math.min(255, Math.max(0, Math.round(v)))]),
    decode: (t: GroupTelegram): number | undefined => (t.data.length >= 1 ? t.data[0] : undefined),
};

/** DPT 5.001 Scaling 0-100 %. */
export const dpt5001 = {
    encode: (pct: number): Buffer => Buffer.from([Math.round((Math.min(100, Math.max(0, pct)) * 255) / 100)]),
    decode: (t: GroupTelegram): number | undefined => (t.data.length >= 1 ? Math.round((t.data[0] * 100) / 255) : undefined),
};
