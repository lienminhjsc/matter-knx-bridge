import { useEffect, useState } from "react";
import type { PlanState, ProjectState } from "../App.tsx";
import { api, ApiError, download, type Assignment, type GaEntry, type KnxObject, type NodeInfo, type Status } from "../api.ts";
import { useLang, type Dict } from "../i18n.tsx";
import { Button, ConfirmDialog, Notes, PageHead, Th, useColumnWidths, useFmtTime } from "../ui.tsx";
import { ChangeTable } from "./GroupAddress.tsx";

interface Row {
    ga: string;
    name: string;
    dpt: string;
    dir: "cmd" | "fb" | "";
    device: string;
    values: string;
    served: boolean;
}

/** Values to enter in the KNX system, per circuit object. */
function valuesOf(key: string | undefined, a: Assignment | undefined, t: Dict): string {
    const v = t.handover.v;
    switch (key) {
        case "SW": case "FB": return v.switch;
        case "VAL": case "VALFB": return v.percent;
        case "CCT": case "CCT_FB": return v.kelvin;
        case "ONOFF": return v.onoffHvac;
        case "ONOFF_FB": return v.onoffHvacFb;
        case "SETP": return v.setp;
        case "SETP_FB": return v.celsius;
        case "TEMP": return v.temp;
        case "MODE": case "MODE_FB": return v.mode;
        case "FAN": case "FAN_FB": return a?.fanFormat === "percent" ? v.fanPct((a.fanSteps ?? [33, 67, 100]).join("/")) : v.fanStage;
        case "OCC": return v.occ;
        case "LUX": return v.lux;
        case "CONTACT": return v.contact;
    }
    return "";
}

function dirOf(g: GaEntry, o: KnxObject | undefined): Row["dir"] {
    if (o) return o.dir;
    return g.deviceId ? (g.isStatus ? "fb" : "cmd") : "";
}

function csvCell(s: string): string {
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function HandoverPage({ ps, pl, nodes, status, onChanged }: { ps: ProjectState; pl: PlanState; nodes: NodeInfo[] | null; status: Status | null; onChanged: () => Promise<void> }) {
    const { t, lang } = useLang();
    const fmt = useFmtTime();
    const { project: p, dirty } = ps;
    const { plan, planning, planErr, runPlan } = pl;
    const [all, setAll] = useState(false);
    const [dialog, setDialog] = useState(false);
    const [accept, setAccept] = useState(false);
    const [files, setFiles] = useState<Record<string, string> | null>(null);
    const [widths, setWidth] = useColumnWidths("handover");

    useEffect(() => {
        if (!plan && !planning && !dirty) void runPlan();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const byId = new Map(p.assignments.map(a => [a.id, a]));
    const nodeById = new Map((nodes ?? []).map(n => [n.nodeId, n]));
    const objByGa = new Map((plan?.objects ?? []).map(o => [o.ga, o]));
    const rooms = new Map(p.rooms.map(r => [r.code, r]));
    const floors = new Map(p.floors.map(f => [f.code, f]));

    // Group by the circuit floor/room; shared GAs at the end.
    const groups = new Map<string, { title: string; rows: Row[] }>();
    for (const g of plan?.gas ?? []) {
        const a = g.deviceId ? byId.get(g.deviceId) : undefined;
        const o = objByGa.get(g.ga);
        if (!all && !o) continue;
        const key = a ? `${a.floorCode}/${a.roomCode}` : "~shared";
        if (!groups.has(key)) {
            const title = a ? `${a.floorCode} ${floors.get(a.floorCode)?.label ?? ""} · ${rooms.get(a.roomCode)?.label ?? ""} (${a.roomCode})` : t.handover.shared;
            groups.set(key, { title, rows: [] });
        }
        const n = a ? nodeById.get(a.nodeId) : undefined;
        groups.get(key)!.rows.push({
            ga: g.ga,
            name: g.name,
            dpt: g.dpt ?? "",
            dir: dirOf(g, o),
            device: a ? `${n?.product ?? a.description ?? ""} · Node ${a.nodeId} EP${a.endpoint}`.replace(/^ · /, "") : "",
            values: o ? valuesOf(g.objectKey, a, t) : t.handover.notServed,
            served: Boolean(o),
        });
    }
    // Project order: floors by order, rooms by order; shared GAs last.
    const rank = (k: string): number => {
        if (k === "~shared") return Number.MAX_SAFE_INTEGER;
        const [fc, rc] = k.split("/");
        return (floors.get(fc)?.order ?? 999) * 1000 + (rooms.get(rc)?.order ?? 999);
    };
    const ordered = [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b));
    const mappedCount = plan?.objects.length ?? 0;
    const nextRev = p.rev + 1;

    const csv = () => {
        const head = ["GA", t.handover.colName, "DPT", t.handover.colDir, t.handover.colDevice, t.handover.colValues, lang === "vi" ? "Nhóm" : "Group"];
        const lines = [head.map(csvCell).join(",")];
        for (const [, gr] of ordered) {
            for (const r of gr.rows) lines.push([r.ga, r.name, r.dpt, r.dir ? t.handover[r.dir] : "", r.device, r.values, gr.title].map(csvCell).join(","));
        }
        const safe = p.name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "du-an";
        download(`${safe}-ga-rev${p.rev}.csv`, "﻿" + lines.join("\r\n") + "\r\n");
    };

    const blocked = dirty ? t.ga.saveFirst : !plan ? t.apply.needPlan : plan.issues.some(i => i.level === "error") ? t.apply.blocked : "";

    return (
        <>
            <div className="print-only">
                <h1 style={{ fontSize: 20 }}>{p.name} · {t.handover.tableTitle}</h1>
                <p className="small" style={{ margin: "4px 0 16px" }}>
                    rev {p.rev} · {status?.knx?.host ?? "?"}:{status?.knx?.port ?? 3671} · {t.handover.gateway} {status?.knx?.individualAddress ?? "?"} · {t.handover.printedAt(fmt(new Date().toISOString()))}
                </p>
            </div>
            <div className="noprint">
                <PageHead step={6} title={t.handover.title} sub={t.handover.sub} />
            </div>
            {blocked && <div className="noprint"><Notes tone="warn" lines={[blocked]} /></div>}
            <Notes tone="danger" lines={planErr} />

            <section className="card noprint" aria-labelledby="files" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center" }}>
                <div style={{ flex: "1 1 360px", display: "flex", flexDirection: "column", gap: 4 }}>
                    <h2 id="files">{t.handover.filesTitle}</h2>
                    <span className="muted">{t.handover.filesSub(nextRev)}</span>
                </div>
                <Button disabled={!plan} onClick={csv}>{t.handover.csv}</Button>
                <Button disabled={!plan} onClick={() => window.print()}>{t.handover.print}</Button>
                <Button kind="primary" disabled={Boolean(blocked)} onClick={() => { setAccept(false); setDialog(true); }}>{t.handover.ets(nextRev)}</Button>
            </section>

            {files && !dialog && (
                <div className="card noprint">
                    <div className="row">{Object.keys(files).map(n => <Button small key={n} onClick={() => download(n, files[n])}>{n}</Button>)}</div>
                </div>
            )}

            {plan ? (
                <section className="card" aria-labelledby="tong">
                    <div className="row noprint" style={{ justifyContent: "space-between" }}>
                        <div style={{ display: "flex", flexDirection: "column" }}>
                            <h2 id="tong">{t.handover.tableTitle}</h2>
                            <span className="muted small">
                                {p.name} · rev {p.rev} · {status?.knx?.host ?? "?"}:{status?.knx?.port ?? 3671} · {t.handover.gateway} {status?.knx?.individualAddress ?? "?"}
                            </span>
                        </div>
                        <div role="group" aria-label={t.handover.filter} className="row">
                            <button type="button" className="chip" aria-pressed={!all} onClick={() => setAll(false)}>{t.handover.served} · {mappedCount}</button>
                            <button type="button" className="chip" aria-pressed={all} onClick={() => setAll(true)}>{t.handover.all} · {plan.stats.total}</button>
                        </div>
                    </div>
                    <div className="tablewrap">
                        <table>
                            <thead>
                                <tr>
                                    <Th col="ga" widths={widths} setWidth={setWidth} min={80}>GA</Th>
                                    <Th col="name" widths={widths} setWidth={setWidth} min={200}>{t.handover.colName}</Th>
                                    <Th col="dpt" widths={widths} setWidth={setWidth} min={72}>DPT</Th>
                                    <Th col="dir" widths={widths} setWidth={setWidth} min={88}>{t.handover.colDir}</Th>
                                    <Th col="device" widths={widths} setWidth={setWidth} min={160}>{t.handover.colDevice}</Th>
                                    <Th col="values" widths={widths} setWidth={setWidth} min={200}>{t.handover.colValues}</Th>
                                </tr>
                            </thead>
                            <tbody>
                                {ordered.map(([key, gr]) => [
                                    <tr className="grp" key={key}><td colSpan={6}>{gr.title}</td></tr>,
                                    ...gr.rows.map(r => (
                                        <tr key={r.ga + r.name} className={r.served ? undefined : "off"}>
                                            <td className="mono nowrap">{r.ga}</td>
                                            <td className="mono">{r.name}</td>
                                            <td className="mono nowrap">{r.dpt}</td>
                                            <td>{r.dir && <span className={`dir ${r.dir}`}>{t.handover[r.dir]}</span>}</td>
                                            <td>{r.device}</td>
                                            <td>{r.values}</td>
                                        </tr>
                                    )),
                                ])}
                            </tbody>
                        </table>
                    </div>
                    <p className="muted small noprint" style={{ margin: 0 }}>{t.handover.foot}</p>
                </section>
            ) : (
                !planning && <p className="muted">{t.handover.needPlan}</p>
            )}

            {dialog && plan && (
                <ConfirmDialog
                    title={t.handover.etsDialog}
                    action={plan.addressChanges.length ? t.handover.etsActionChanged : t.handover.etsAction}
                    blocker={plan.addressChanges.length && !accept ? t.handover.etsAcceptBlock : ""}
                    summary={
                        <dl>
                            <dt>{t.handover.etsRev}</dt><dd>{t.handover.etsRevV(nextRev)}</dd>
                            <dt>GA</dt><dd>{plan.stats.total}</dd>
                            <dt>{t.handover.etsFiles}</dt><dd className="mono small">matter-bridge-rev{nextRev}-ets.xml, -ga.csv</dd>
                        </dl>
                    }
                    extra={
                        plan.addressChanges.length > 0 && (
                            <div className="note danger">
                                <p style={{ margin: "0 0 8px" }} className="strong">{t.handover.etsChanged(plan.addressChanges.length, p.exported?.rev ?? 0)}</p>
                                <ChangeTable changes={plan.addressChanges} />
                                <label className="row" style={{ marginTop: 8 }}>
                                    <input type="checkbox" checked={accept} onChange={e => setAccept(e.target.checked)} /> {t.handover.etsAccept}
                                </label>
                            </div>
                        )
                    }
                    onError={e => (e instanceof ApiError && e.status === 409 ? <Notes tone="danger" lines={[t.handover.etsConflict]} /> : undefined)}
                    run={async () => {
                        const r = await api.exportEts(accept);
                        setFiles(r.files);
                        for (const [name, content] of Object.entries(r.files)) download(name, content);
                        await onChanged();
                        await runPlan();
                        return (
                            <div className="note okb">
                                <p style={{ margin: "0 0 8px" }}>{t.handover.etsDone(r.rev)}</p>
                                <div className="row">{Object.keys(r.files).map(n => <Button small key={n} onClick={() => download(n, r.files[n])}>{n}</Button>)}</div>
                            </div>
                        );
                    }}
                    onClose={() => setDialog(false)}
                />
            )}
        </>
    );
}
