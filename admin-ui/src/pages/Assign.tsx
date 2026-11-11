import { useState } from "react";
import type { ProjectState } from "../App.tsx";
import { api, errorLines, type Assignment, type EndpointInfo, type NodeInfo, type Project } from "../api.ts";
import { useLang } from "../i18n.tsx";
import { Button, Notes, PageHead, SUPPORTED, Th, useColumnWidths } from "../ui.tsx";

const NAME_RE = /^[\x21-\x7e]+$/;
const PREFIX: Record<string, string> = { "lt.onoff": "L", "lt.dim": "D", "lt.cct": "T", "hvac.unit": "AC", "pres.sensor": "PS", "sec.contact": "CT" };
const DEFAULT_STEPS: [number, number, number] = [33, 67, 100];

/** Next circuit name in the room: {floor}.{room}.{prefix}{nn}, not clashing with existing names. */
function nextName(p: Project, floor: string, room: string, type: string, self: string): string {
    const base = `${floor}.${room}.${PREFIX[type] ?? "X"}`;
    const used = new Set(p.assignments.filter(a => a.id !== self).map(a => a.name));
    for (let i = 1; ; i++) {
        const n = `${base}${String(i).padStart(2, "0")}`;
        if (!used.has(n)) return n;
    }
}

/** KNX fan GA format: stage 0-3 (DPT 5.100, default) or % (5.001) to match existing KNX devices. */
function FanFormat({ a, onChange }: { a: Assignment; onChange: (a: Assignment) => void }) {
    const { t } = useLang();
    const pct = a.fanFormat === "percent";
    const steps = a.fanSteps ?? DEFAULT_STEPS;
    const ok = steps[0] >= 1 && steps[0] < steps[1] && steps[1] < steps[2] && steps[2] <= 100;
    return (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
            <select
                className="field"
                aria-label={t.assign.fanKind}
                value={pct ? "percent" : "stage"}
                onChange={e => {
                    const { fanFormat: _f, fanSteps: _s, ...rest } = a;
                    onChange(e.target.value === "percent" ? { ...rest, fanFormat: "percent" } : rest);
                }}
            >
                <option value="stage">{t.assign.fanStage}</option>
                <option value="percent">{t.assign.fanPercent}</option>
            </select>
            {pct && (
                <div className="row small muted" style={{ gap: 4 }}>
                    {(["Low", "Med", "High"] as const).map((l, i) => (
                        <label key={l} className="row" style={{ gap: 4 }}>
                            {l}
                            <input
                                className="field mono"
                                style={{ width: 56, height: 32 }}
                                type="number"
                                min={1}
                                max={100}
                                aria-invalid={!ok || undefined}
                                value={steps[i]}
                                onChange={e => {
                                    const next = [...steps] as [number, number, number];
                                    next[i] = Number(e.target.value);
                                    onChange({ ...a, fanFormat: "percent", fanSteps: next });
                                }}
                            />
                            %
                        </label>
                    ))}
                </div>
            )}
        </div>
    );
}

export function AssignPage({ ps, nodes, onRefresh }: { ps: ProjectState; nodes: NodeInfo[] | null; onRefresh: () => Promise<void> | void }) {
    const { t } = useLang();
    const { project: p, update } = ps;
    const [identifying, setIdentifying] = useState<string | null>(null);
    const [msg, setMsg] = useState<{ tone: "danger" | "okb"; lines: string[] } | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [widths, setWidth] = useColumnWidths("assign");
    const roomOptions = [...p.floors]
        .sort((a, b) => a.order - b.order)
        .map(f => ({ floor: f, rooms: p.rooms.filter(r => r.floorCode === f.code).sort((a, b) => a.order - b.order) }));

    const byId = new Map(p.assignments.map(a => [a.id, a]));
    const known = new Set((nodes ?? []).flatMap(n => n.endpoints.map(e => `n${n.nodeId}e${e.endpoint}`)));
    const orphans = p.assignments.filter(a => nodes && !known.has(a.id));

    const set = (id: string, fn: (a: Assignment | undefined) => Assignment | undefined) =>
        update(x => {
            const cur = x.assignments.find(a => a.id === id);
            const next = fn(cur);
            const rest = x.assignments.filter(a => a.id !== id);
            return { ...x, assignments: next ? [...rest, next].sort((a, b) => a.nodeId - b.nodeId || a.endpoint - b.endpoint) : rest };
        });

    const assignRoom = (node: NodeInfo, ep: EndpointInfo, value: string) => {
        const id = `n${node.nodeId}e${ep.endpoint}`;
        if (!value) return set(id, () => undefined);
        const [floorCode, roomCode] = value.split("/");
        set(id, cur => {
            const circuitType = cur?.circuitType ?? (ep.suggested && SUPPORTED.includes(ep.suggested) ? ep.suggested : "lt.onoff");
            const keepName = cur && cur.floorCode === floorCode && cur.roomCode === roomCode;
            return {
                ...(cur ?? {}),
                id,
                nodeId: node.nodeId,
                endpoint: ep.endpoint,
                circuitType,
                floorCode,
                roomCode,
                name: keepName ? cur.name : nextName(p, floorCode, roomCode, circuitType, id),
                description: cur?.description ?? [node.product, node.label].filter(Boolean).join(" ").slice(0, 60),
            };
        });
    };

    const identify = async (nodeId: number, endpoint: number) => {
        setIdentifying(`${nodeId}/${endpoint}`);
        setMsg(null);
        try {
            await api.identify(nodeId, endpoint);
            setMsg({ tone: "okb", lines: [t.assign.identifyOk(nodeId, endpoint)] });
        } catch (e) {
            setMsg({ tone: "danger", lines: [t.assign.identifyFail(nodeId), ...errorLines(e, t)] });
        } finally {
            setIdentifying(null);
        }
    };

    return (
        <>
            <PageHead step={3} title={t.assign.title} sub={t.assign.sub}>
                <Button busy={refreshing} onClick={async () => { setRefreshing(true); try { await onRefresh(); } finally { setRefreshing(false); } }}>{t.refresh}</Button>
                <a className="btn btn-primary" href="#/ga">{t.assign.next}</a>
            </PageHead>
            {!p.rooms.length && <Notes tone="info" lines={[t.assign.noRooms]} />}
            {msg && <Notes tone={msg.tone} lines={msg.lines} />}
            {orphans.length > 0 && <Notes tone="warn" lines={[t.assign.orphans(orphans.length), ...orphans.map(a => `${a.name} (node ${a.nodeId} ep ${a.endpoint})`)]} />}
            {nodes === null && <p className="muted">{t.assign.loadingNodes}</p>}
            {nodes?.length === 0 && <p className="muted">{t.assign.noNodes}</p>}
            {nodes && nodes.length > 0 && (
                <section className="card">
                    <div className="tablewrap">
                        <table>
                            <thead>
                                <tr>
                                    <Th col="ep" widths={widths} setWidth={setWidth} min={88}>{t.assign.colEp}</Th>
                                    <Th col="device" widths={widths} setWidth={setWidth} min={160}>{t.assign.colSuggest}</Th>
                                    <Th col="type" widths={widths} setWidth={setWidth} min={160}>{t.assign.colType}</Th>
                                    <Th col="room" widths={widths} setWidth={setWidth} min={140}>{t.assign.colRoom}</Th>
                                    <Th col="name" widths={widths} setWidth={setWidth} min={160}>{t.assign.colName}</Th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                {nodes.map(node =>
                                    node.endpoints.map((ep, i) => {
                                        const id = `n${node.nodeId}e${ep.endpoint}`;
                                        const a = byId.get(id);
                                        const nameBad = a && (!NAME_RE.test(a.name) || !a.name.startsWith(`${a.floorCode}.${a.roomCode}.`) || p.assignments.some(o => o.id !== id && o.name === a.name));
                                        const key = `${node.nodeId}/${ep.endpoint}`;
                                        return (
                                            <tr key={id}>
                                                <td className="mono nowrap">{node.nodeId} / {ep.endpoint}</td>
                                                <td>
                                                    {i === 0 && (
                                                        <div className="strong">
                                                            {node.vendor ?? "?"} {node.product ?? ""}
                                                            <div className="small" style={{ fontWeight: 400 }}>
                                                                {node.network && <span className="tag" style={{ marginRight: 8 }}>{node.network}</span>}
                                                                {node.available ? <span className="ok">{t.assign.online}</span> : <span className="err">{t.assign.offline}</span>}
                                                                {node.fabrics && <span className={node.fabrics.used >= node.fabrics.supported ? "wait" : "muted"} style={{ marginLeft: 8 }}>{t.assign.fabric(node.fabrics.used, node.fabrics.supported)}</span>}
                                                            </div>
                                                        </div>
                                                    )}
                                                    <div>{ep.suggested ? t.circuit[ep.suggested] ?? ep.suggested : "?"}</div>
                                                    <div className="muted small">
                                                        {ep.reason}
                                                        {!ep.bridgeSupported && <span className="wait"> · {t.assign.unsupported}</span>}
                                                    </div>
                                                </td>
                                                <td>
                                                    <select className="field" style={{ width: "100%" }} aria-label={`${t.assign.colType} ${key}`} disabled={!a} value={a?.circuitType ?? ""} onChange={e => set(id, cur => cur && { ...cur, circuitType: e.target.value })}>
                                                        {!a && <option value="">-</option>}
                                                        {SUPPORTED.map(ty => <option key={ty} value={ty}>{t.circuit[ty]}</option>)}
                                                    </select>
                                                    {a?.circuitType === "hvac.unit" && <FanFormat a={a} onChange={next => set(id, () => next)} />}
                                                </td>
                                                <td>
                                                    <select className="field" style={{ width: "100%" }} aria-label={`${t.assign.colRoom} ${key}`} disabled={!p.rooms.length || (!ep.bridgeSupported && !a)} value={a ? `${a.floorCode}/${a.roomCode}` : ""} onChange={e => assignRoom(node, ep, e.target.value)}>
                                                        <option value="">{t.assign.notAssigned}</option>
                                                        {roomOptions.map(g => (
                                                            <optgroup key={g.floor.code} label={`${g.floor.code} ${g.floor.label}`}>
                                                                {g.rooms.map(r => <option key={r.code} value={`${g.floor.code}/${r.code}`}>{r.code} {r.label}</option>)}
                                                            </optgroup>
                                                        ))}
                                                    </select>
                                                </td>
                                                <td>
                                                    {a ? (
                                                        <input className="field mono" style={{ width: "100%" }} aria-label={`${t.assign.colName} ${key}`} aria-invalid={nameBad || undefined} value={a.name} onChange={e => set(id, cur => cur && { ...cur, name: e.target.value.replace(/\s/g, "") })} />
                                                    ) : (
                                                        <span className="muted">-</span>
                                                    )}
                                                    {a?.slot !== undefined && <div className="muted small">slot {a.slot}</div>}
                                                </td>
                                                <td>
                                                    {ep.hasIdentify && (
                                                        <Button small busy={identifying === key} disabled={!node.available || (identifying !== null && identifying !== key)} onClick={() => identify(node.nodeId, ep.endpoint)}>
                                                            {t.assign.identify}
                                                        </Button>
                                                    )}
                                                </td>
                                            </tr>
                                        );
                                    }),
                                )}
                            </tbody>
                        </table>
                    </div>
                </section>
            )}
        </>
    );
}
