// Suggests a circuit type from the Matter clusters of each endpoint.
import type { CircuitType } from "./planner/types.ts";
import type { NodeView } from "../mapping.ts";

const C = {
    IDENTIFY: 3,
    ON_OFF: 6,
    LEVEL: 8,
    DESCRIPTOR: 29,
    BASIC: 40,
    BOOLEAN_STATE: 69,
    DOOR_LOCK: 257,
    WINDOW_COVERING: 258,
    THERMOSTAT: 513,
    FAN: 514,
    COLOR: 768,
    ILLUMINANCE: 1024,
    TEMPERATURE: 1026,
    HUMIDITY: 1029,
    OCCUPANCY: 1030,
} as const;

/** Circuit types the bridge has channels for. */
export const BRIDGE_SUPPORTED: ReadonlySet<CircuitType> = new Set<CircuitType>([
    "lt.onoff", "lt.dim", "lt.cct", "hvac.unit", "pres.sensor", "sec.contact",
]);

export interface EndpointInfo {
    endpoint: number;
    clusters: number[];
    /** Matter device types (Descriptor), e.g. 266 OnOffPlugInUnit. */
    deviceTypes: number[];
    suggested?: CircuitType;
    /** Why this type was suggested, shown in the UI. */
    reason: string;
    bridgeSupported: boolean;
    hasIdentify: boolean;
}

export interface NodeInfo {
    nodeId: number;
    available: boolean;
    vendor?: string;
    product?: string;
    label?: string;
    /** "thread" | "wifi" | "ethernet" | undefined (from NetworkCommissioning when present). */
    network?: string;
    fabrics?: { used: number; supported: number };
    endpoints: EndpointInfo[];
}

function num(v: unknown): number | undefined {
    return typeof v === "number" ? v : undefined;
}

function str(v: unknown): string | undefined {
    return typeof v === "string" && v ? v : undefined;
}

export function endpointsOf(node: NodeView): Map<number, Set<number>> {
    const eps = new Map<number, Set<number>>();
    for (const key of Object.keys(node.attributes)) {
        const [ep, cl] = key.split("/").map(Number);
        if (!eps.has(ep)) eps.set(ep, new Set());
        eps.get(ep)!.add(cl);
    }
    return eps;
}

export function suggestCircuit(node: NodeView, ep: number, clusters: Set<number>): { type?: CircuitType; reason: string } {
    const a = (cl: number, at: number) => node.attributes[`${ep}/${cl}/${at}`];
    if (clusters.has(C.THERMOSTAT)) return { type: "hvac.unit", reason: "Thermostat" };
    if (clusters.has(C.WINDOW_COVERING)) {
        const f = num(a(C.WINDOW_COVERING, 65532)) ?? 0;
        return (f & 2) !== 0 ? { type: "sht.blind", reason: "WindowCovering lift + tilt" } : { type: "sht.roller", reason: "WindowCovering lift" };
    }
    if (clusters.has(C.DOOR_LOCK)) return { reason: "DoorLock: no planner circuit type yet (waiting for lock.door)" };
    if (clusters.has(C.COLOR)) {
        const f = num(a(C.COLOR, 65532)) ?? 0; // bit0 HS, bit3 XY, bit4 CT
        if ((f & 0b1001) !== 0) return { type: "lt.rgb", reason: "ColorControl Hue/Sat or XY" };
        if ((f & 0b10000) !== 0) return { type: "lt.cct", reason: "ColorControl color temperature" };
    }
    if (clusters.has(C.LEVEL) && clusters.has(C.ON_OFF)) return { type: "lt.dim", reason: "OnOff + LevelControl" };
    if (clusters.has(C.ON_OFF)) return { type: "lt.onoff", reason: "OnOff" };
    if (clusters.has(C.OCCUPANCY)) return { type: "pres.sensor", reason: "OccupancySensing" };
    if (clusters.has(C.BOOLEAN_STATE)) return { type: "sec.contact", reason: "BooleanState (contact sensor)" };
    return { reason: "No controllable cluster" };
}

export function describeNode(node: NodeView): NodeInfo {
    const eps = endpointsOf(node);
    const a0 = (cl: number, at: number) => node.attributes[`0/${cl}/${at}`];
    const hasThermostat = [...eps.values()].some(s => s.has(C.THERMOSTAT));
    const endpoints: EndpointInfo[] = [];
    for (const [ep, clusters] of [...eps.entries()].sort((x, y) => x[0] - y[0])) {
        if (ep === 0) continue;
        // Secondary endpoints of an air conditioner (fan, humidity) belong to hvac.unit, not separate circuits.
        if (hasThermostat && !clusters.has(C.THERMOSTAT) && (clusters.has(C.FAN) || clusters.has(C.HUMIDITY) || clusters.has(C.TEMPERATURE))) continue;
        const dtl = node.attributes[`${ep}/${C.DESCRIPTOR}/0`];
        const deviceTypes = Array.isArray(dtl) ? dtl.map(d => num((d as Record<string, unknown>)["0"]) ?? num((d as Record<string, unknown>).deviceType) ?? 0) : [];
        const s = suggestCircuit(node, ep, clusters);
        endpoints.push({
            endpoint: ep,
            clusters: [...clusters].sort((x, y) => x - y),
            deviceTypes,
            suggested: s.type,
            reason: s.reason,
            bridgeSupported: s.type !== undefined && BRIDGE_SUPPORTED.has(s.type),
            hasIdentify: clusters.has(C.IDENTIFY),
        });
    }
    const fabrics = num(a0(62, 3)) !== undefined ? { used: num(a0(62, 3)) as number, supported: num(a0(62, 2)) ?? 5 } : undefined;
    // NetworkCommissioning (49) feature map: bit0 Wi-Fi, bit1 Thread, bit2 Ethernet
    const nf = num(a0(49, 65532));
    const network = nf === undefined ? undefined : nf & 2 ? "thread" : nf & 1 ? "wifi" : nf & 4 ? "ethernet" : undefined;
    return {
        nodeId: node.node_id,
        available: node.available,
        vendor: str(a0(C.BASIC, 1)),
        product: str(a0(C.BASIC, 3)),
        label: str(a0(C.BASIC, 5)),
        network,
        fabrics,
        endpoints,
    };
}
