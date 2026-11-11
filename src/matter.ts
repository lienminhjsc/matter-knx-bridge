// WebSocket connection to matterjs-server via @matter-server/ws-client, reconnects automatically.
import { MatterClient, type WebSocketLike } from "@matter-server/ws-client";
import type { NodeView } from "./mapping.ts";
import { log } from "./log.ts";

export interface NodeEventView {
    node_id: number;
    endpoint_id: number;
    cluster_id: number;
    event_id: number;
    data: unknown;
}

export interface CommandOptions {
    /** Required for timed commands (DoorLock lockDoor / unlockDoor). */
    timedRequestTimeoutMs?: number;
    timeoutMs?: number;
}

/** What the bridge needs from Matter. The real one is MatterGateway, tests use a fake. */
export interface MatterPort {
    start(): void;
    stop(): void;
    readonly connected: boolean;
    node(nodeId: number): NodeView | undefined;
    /** All known nodes (for admin). */
    listNodes(): NodeView[];
    command(nodeId: number, endpoint: number, cluster: number, name: string, payload?: Record<string, unknown>, opts?: CommandOptions): Promise<void>;
    /** Writes an attribute (path "ep/cluster/attr"). Throws when the device rejects it. */
    write(nodeId: number, path: string, value: unknown, opts?: CommandOptions): Promise<void>;
    /** Re-reads attributes (path "ep/cluster/attr", "*" allowed). */
    read(nodeId: number, paths: string[]): Promise<void>;
    onNodeChanged(cb: (nodeId: number) => void): void;
    onNodeEvent(cb: (e: NodeEventView) => void): void;
    onConnection(cb: (connected: boolean) => void): void;
}

const toNum = (v: number | bigint): number => (typeof v === "bigint" ? Number(v) : v);

export class MatterGateway implements MatterPort {
    #url: string;
    #client: MatterClient | undefined;
    #connected = false;
    #stopped = false;
    #retryMs = 1000;
    #retryTimer: NodeJS.Timeout | undefined;
    #nodes = new Map<number, NodeView>();
    #nodeCbs: Array<(nodeId: number) => void> = [];
    #eventCbs: Array<(e: NodeEventView) => void> = [];
    #connCbs: Array<(c: boolean) => void> = [];

    constructor(url: string) {
        this.#url = url;
    }

    get connected(): boolean {
        return this.#connected;
    }

    onNodeChanged(cb: (nodeId: number) => void): void {
        this.#nodeCbs.push(cb);
    }
    onNodeEvent(cb: (e: NodeEventView) => void): void {
        this.#eventCbs.push(cb);
    }
    onConnection(cb: (c: boolean) => void): void {
        this.#connCbs.push(cb);
    }

    node(nodeId: number): NodeView | undefined {
        return this.#nodes.get(nodeId);
    }

    listNodes(): NodeView[] {
        return [...this.#nodes.values()];
    }

    start(): void {
        this.#stopped = false;
        void this.#connect();
    }

    stop(): void {
        this.#stopped = true;
        clearTimeout(this.#retryTimer);
        this.#client?.disconnect();
        this.#setConnected(false);
    }

    async command(nodeId: number, endpoint: number, cluster: number, name: string, payload?: Record<string, unknown>, opts?: CommandOptions): Promise<void> {
        const client = this.#requireClient();
        await client.deviceCommand(nodeId, endpoint, cluster, name, payload ?? {}, {
            timedRequestTimeoutMs: opts?.timedRequestTimeoutMs,
            timeout: opts?.timeoutMs,
        });
    }

    async write(nodeId: number, path: string, value: unknown, opts?: CommandOptions): Promise<void> {
        const client = this.#requireClient();
        const result = (await client.writeAttribute(nodeId, path, value, { timeout: opts?.timeoutMs })) as unknown;
        const entries = Array.isArray(result) ? (result as Array<{ status?: number }>) : [];
        const bad = entries.find(e => typeof e?.status === "number" && e.status !== 0);
        if (bad) throw new Error(`write ${path} status ${bad.status}`);
    }

    async read(nodeId: number, paths: string[]): Promise<void> {
        const client = this.#requireClient();
        const result = (await client.readAttribute(nodeId, paths)) as Record<string, unknown> | undefined;
        const node = this.#nodes.get(nodeId);
        if (node && result && typeof result === "object") {
            Object.assign(node.attributes, result);
            this.#emitNode(nodeId);
        }
    }

    #requireClient(): MatterClient {
        if (!this.#client || !this.#connected) throw new Error("matter-server not connected");
        return this.#client;
    }

    async #connect(): Promise<void> {
        if (this.#stopped) return;
        const client = new MatterClient(this.#url, {
            wsFactory: (url: string) => new WebSocket(url) as unknown as WebSocketLike,
            logger: {
                debug: () => {},
                info: () => {},
                warn: (m: string) => log.warn("ws-client", m),
                error: (m: string) => log.error("ws-client", m),
            },
        });
        this.#client = client;
        client.addEventListener("nodes_changed", (detail?: unknown) => {
            const d = detail as { reason: string; nodeId: number | bigint; attributeKey?: string } | undefined;
            if (!d) return;
            const id = toNum(d.nodeId);
            if (d.reason === "node_removed") this.#nodes.delete(id);
            else this.#syncNode(client, id);
            this.#emitNode(id);
        });
        client.addNodeEventListener(e => {
            const ev: NodeEventView = {
                node_id: toNum(e.node_id),
                endpoint_id: e.endpoint_id,
                cluster_id: e.cluster_id,
                event_id: e.event_id,
                data: e.data,
            };
            for (const cb of this.#eventCbs) cb(ev);
        });
        client.addEventListener("connection_lost", () => this.#lost("connection lost"));
        client.addEventListener("server_shutdown", () => this.#lost("server shutdown"));
        try {
            await client.startListening();
            this.#retryMs = 1000;
            this.#nodes.clear();
            for (const key of Object.keys(client.nodes)) this.#syncNode(client, Number(key));
            log.info("matter", `connected to ${this.#url}, ${this.#nodes.size} nodes`);
            this.#setConnected(true);
            for (const id of this.#nodes.keys()) this.#emitNode(id);
        } catch (err) {
            this.#lost(`cannot connect: ${(err as Error).message}`);
        }
    }

    #syncNode(client: MatterClient, id: number): void {
        const n = client.nodes[String(id)];
        if (!n) return;
        this.#nodes.set(id, { node_id: id, available: n.available, attributes: { ...n.attributes } });
    }

    #lost(reason: string): void {
        if (this.#stopped) return;
        if (this.#connected) log.warn("matter", `connection lost: ${reason}`);
        this.#setConnected(false);
        try {
            this.#client?.disconnect();
        } catch {
            /* already closed */
        }
        clearTimeout(this.#retryTimer);
        this.#retryTimer = setTimeout(() => void this.#connect(), this.#retryMs);
        this.#retryMs = Math.min(this.#retryMs * 2, 30000);
    }

    #setConnected(c: boolean): void {
        if (c === this.#connected) return;
        this.#connected = c;
        for (const cb of this.#connCbs) cb(c);
    }

    #emitNode(id: number): void {
        for (const cb of this.#nodeCbs) cb(id);
    }
}
