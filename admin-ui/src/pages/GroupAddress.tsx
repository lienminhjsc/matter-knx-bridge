import { useRef, useState } from "react";
import type { PlanState, ProjectState } from "../App.tsx";
import { api, codedText, errorLines, issueText, normalizeGa, readFileText, type AddressChange, type GaEntry, type GaOverride, type ImportResult, type Issue, type KnxObject, type PlanSummary, type Project } from "../api.ts";
import { useLang, type Dict } from "../i18n.tsx";
import { Button, Notes, PageHead, Th, useColumnWidths, useFmtTime } from "../ui.tsx";

export function objectText(o: KnxObject | undefined, t: Dict): string {
    if (!o) return "";
    return `${o.dir === "cmd" ? t.ga.cmd : t.ga.state} ${o.bind}${o.transform ? ` (${o.transform})` : ""}`;
}

export function ChangeTable({ changes }: { changes: AddressChange[] }) {
    const { t } = useLang();
    return (
        <div className="tablewrap" style={{ maxHeight: 200, overflowY: "auto" }}>
            <table>
                <thead><tr><th>GA</th><th>{t.ga.colFrom}</th><th>{t.ga.colTo}</th></tr></thead>
                <tbody>{changes.map(c => <tr key={c.key}><td>{c.name}</td><td className="mono">{c.from}</td><td className="mono err">{c.to}</td></tr>)}</tbody>
            </table>
        </div>
    );
}

/** Inline editable address of one GA (manual override). */
function AddressCell({ g, plan, project, disabled, issues, onSave }: {
    g: GaEntry;
    plan: PlanSummary;
    project: Project;
    disabled: boolean;
    issues: Issue[];
    onSave: (key: string, o: GaOverride | null) => Promise<void>;
}) {
    const { t } = useLang();
    const [editing, setEditing] = useState(false);
    const [value, setValue] = useState(g.ga);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string[]>([]);
    const [ask, setAsk] = useState<string | null>(null);

    const save = async (o: GaOverride | null) => {
        setBusy(true);
        setErr([]);
        try {
            await onSave(g.key, o);
            setEditing(false);
            setAsk(null);
        } catch (e) {
            setErr(errorLines(e, t));
        } finally {
            setBusy(false);
        }
    };
    const submit = (useImported = false) => {
        const ga = normalizeGa(value);
        if (!ga) return setErr([t.ga.ovFormat]);
        if (ga === g.generated && !g.overridden) return setEditing(false);
        if (ga === g.generated && g.overridden && !useImported) return save(null);
        const other = plan.gas.find(x => x.key !== g.key && x.ga === ga);
        if (other) return setErr([t.ga.ovDup(other.name)]);
        const r = project.reserved?.find(x => x.ga === ga);
        if (r && !useImported) {
            setErr([]);
            return setAsk(r.name);
        }
        return save(useImported ? { ga, useImported: true } : { ga });
    };

    if (!editing) {
        return (
            <>
                <span className={g.ga ? "mono nowrap" : "mono nowrap err"}>{g.ga || t.ga.noAddr}</span>
                {g.overridden && <span className="tag" style={{ marginLeft: 6 }} title={t.ga.manualTitle(g.generated)}>{t.ga.manual}</span>}
                {g.imported && <div className="muted small">{t.ga.importedTag(g.imported)}</div>}
                <div className="row small" style={{ gap: 4, marginTop: 2 }}>
                    <button type="button" className="linkbtn" disabled={disabled} onClick={() => { setValue(g.ga); setErr([]); setAsk(null); setEditing(true); }}>{t.ga.edit}</button>
                    {g.overridden && <button type="button" className="linkbtn" disabled={disabled || busy} onClick={() => void save(null)}>{t.ga.reset}</button>}
                </div>
                {issues.map((i, n) => <div key={n} className={i.level === "error" ? "err small" : "wait small"}>{issueText(i, t)}</div>)}
                {err.map((l, n) => <div key={n} className="err small">{l}</div>)}
            </>
        );
    }
    return (
        <form onSubmit={e => { e.preventDefault(); void submit(); }} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <input
                className="field mono"
                style={{ width: 110, height: 32 }}
                value={value}
                autoFocus
                aria-label={t.ga.editLabel(g.name)}
                aria-invalid={err.length > 0 || undefined}
                onChange={e => { setValue(e.target.value); setAsk(null); }}
                onKeyDown={e => { if (e.key === "Escape") setEditing(false); }}
            />
            <div className="row small" style={{ gap: 4 }}>
                <button type="submit" className="linkbtn" disabled={busy}>{t.ga.saveAddr}</button>
                <button type="button" className="linkbtn" disabled={busy} onClick={() => setEditing(false)}>{t.ga.cancelEdit}</button>
            </div>
            {ask !== null && (
                <div className="small">
                    <div className="wait">{t.ga.ovImported(ask)}</div>
                    <button type="button" className="linkbtn" disabled={busy} onClick={() => void submit(true)}>{t.ga.ovUseImported}</button>
                </div>
            )}
            {err.map((l, n) => <div key={n} className="err small">{l}</div>)}
        </form>
    );
}

/** ETS import: addresses already used on site become reserved. */
function ImportCard({ project, disabled, onChanged }: { project: Project; disabled: boolean; onChanged: () => Promise<void> }) {
    const { t } = useLang();
    const fmt = useFmtTime();
    const input = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<ImportResult | null>(null);
    const [err, setErr] = useState<string[]>([]);
    const n = project.reserved?.length ?? 0;

    const run = async (fn: () => Promise<void>) => {
        setBusy(true);
        setErr([]);
        try {
            await fn();
            await onChanged();
        } catch (e) {
            setErr(errorLines(e, t));
        } finally {
            setBusy(false);
            if (input.current) input.current.value = "";
        }
    };
    const pick = (f: File | undefined) => {
        if (!f) return;
        void run(async () => {
            setResult(null);
            setResult(await api.importEts(await readFileText(f), f.name));
        });
    };

    const lines: string[] = [];
    if (result) {
        lines.push(t.ga.impResult(result.found, result.imported, result.own));
        if (result.duplicates.length) lines.push(t.ga.impDup(result.duplicates.slice(0, 10).join(", ") + (result.duplicates.length > 10 ? ", ..." : "")));
    }
    const errLines = result?.errors.length ? [t.ga.impErrTitle(result.errors.length), ...result.errors.slice(0, 8).map(e => t.ga.impLine(e.line, e.code, e.address))] : [];

    return (
        <div className="card">
            <h3>{t.ga.impTitle}</h3>
            <p className="muted" style={{ margin: 0 }}>{t.ga.impSub}</p>
            <div className="row">
                <input ref={input} type="file" accept=".csv,.xml,.txt,text/csv,text/xml,application/xml" style={{ display: "none" }} onChange={e => pick(e.target.files?.[0])} />
                <Button busy={busy} disabled={disabled} onClick={() => input.current?.click()}>{t.ga.impFile}</Button>
                {n > 0 && <Button disabled={disabled || busy} onClick={() => void run(async () => { setResult(null); await api.clearImport(); })}>{t.ga.impClear}</Button>}
                <span className="muted small">{n ? t.ga.impCurrent(n, project.reservedSource?.file ?? "", fmt(project.reservedSource?.at)) : t.ga.impNone}</span>
            </div>
            <Notes tone="okb" lines={lines.length ? [lines.join(" ")] : []} />
            <Notes tone="warn" lines={errLines} />
            <Notes tone="danger" lines={err} />
        </div>
    );
}

export function GroupAddressPage({ ps, pl, onChanged }: { ps: ProjectState; pl: PlanState; onChanged: () => Promise<void> }) {
    const { t } = useLang();
    const fmt = useFmtTime();
    const { project: p, dirty } = ps;
    const { plan, planning, planErr, runPlan } = pl;
    const [onlyMapped, setOnlyMapped] = useState(false);
    const [widths, setWidth] = useColumnWidths("ga");

    // Issues tied to one GA are shown in its row; the others in the lists above the table.
    const rowIssues = new Map<string, Issue[]>();
    for (const i of plan?.issues ?? []) {
        if (!i.key) continue;
        if (!rowIssues.has(i.key)) rowIssues.set(i.key, []);
        rowIssues.get(i.key)!.push(i);
    }
    const errors = plan?.issues.filter(i => i.level === "error") ?? [];
    const warns = [...(plan?.issues.filter(i => i.level === "warning").map(i => issueText(i, t)) ?? []), ...(plan?.warnings.map(w => codedText(w, t.warn)) ?? [])];
    const objByGa = new Map((plan?.objects ?? []).map(o => [o.ga, o]));
    const rows = (plan?.gas ?? []).filter(g => !onlyMapped || (g.ga && objByGa.has(g.ga)));

    const saveOverride = async (key: string, o: GaOverride | null) => {
        const overrides = { ...(p.overrides ?? {}) };
        if (o) overrides[key] = o;
        else delete overrides[key];
        await api.saveProject({ ...p, overrides });
        await onChanged();
        await runPlan();
    };
    const afterImport = async () => {
        await onChanged();
        await runPlan();
    };
    const exp = p.exported ? t.ga.exported(p.exported.rev, fmt(p.exported.at)) : t.ga.none;

    return (
        <>
            <PageHead step={4} title={t.ga.title} sub={t.ga.sub(exp, fmt(p.applied?.at))}>
                <Button busy={planning} disabled={dirty} onClick={runPlan}>{plan ? t.ga.replan : t.ga.plan}</Button>
                <a className="btn btn-primary" href="#/apply">{t.ga.next}</a>
            </PageHead>
            {dirty && <Notes tone="warn" lines={[t.ga.saveFirst]} />}
            <Notes tone="danger" lines={planErr} />

            <ImportCard project={p} disabled={dirty} onChanged={afterImport} />

            {plan && (
                <>
                    <div className="grid4">
                        <div className="card stat"><span className="muted small">{t.ga.total}</span><strong>{plan.stats.total}</strong><span className="muted small">{t.ga.scheme(plan.scheme)}</span></div>
                        <div className="card stat"><span className="muted small">{t.ga.served}</span><strong>{plan.served.mapped}<span className="muted" style={{ fontSize: 14 }}> / {plan.served.deviceGas}</span></strong><span className="muted small">{t.ga.servedSub}</span></div>
                        <div className="card stat"><span className="muted small">{t.ga.issues}</span><strong className={errors.length ? "err" : ""}>{errors.length} / {warns.length}</strong><span className="muted small">{t.ga.issuesSub}</span></div>
                        <div className="card stat"><span className="muted small">{t.ga.changes}</span><strong className={plan.addressChanges.length ? "wait" : ""}>{plan.addressChanges.length}</strong><span className="muted small">{t.ga.changesSub}</span></div>
                    </div>
                    <Notes tone="danger" lines={errors.length ? [t.ga.errorsTitle, ...errors.map(i => issueText(i, t))] : []} />
                    <Notes tone="warn" lines={warns.length ? [t.ga.warnTitle, ...warns] : []} />
                    {plan.addressChanges.length > 0 && (
                        <div className="card">
                            <h3>{t.ga.changesTitle}</h3>
                            <p className="muted" style={{ margin: 0 }}>{t.ga.changesBody}</p>
                            <ChangeTable changes={plan.addressChanges} />
                        </div>
                    )}
                    <div className="card">
                        <div className="row" style={{ justifyContent: "space-between" }}>
                            <h3>{t.ga.list}</h3>
                            <label className="row small muted">
                                <input type="checkbox" checked={onlyMapped} onChange={e => setOnlyMapped(e.target.checked)} /> {t.ga.onlyServed}
                            </label>
                        </div>
                        <div className="tablewrap">
                            <table>
                                <thead>
                                    <tr>
                                        <Th col="ga" widths={widths} setWidth={setWidth} min={130}>GA</Th>
                                        <Th col="name" widths={widths} setWidth={setWidth} min={200}>{t.ga.colName}</Th>
                                        <Th col="dpt" widths={widths} setWidth={setWidth} min={72}>DPT</Th>
                                        <Th col="group" widths={widths} setWidth={setWidth} min={120}>{t.ga.colGroup}</Th>
                                        <Th col="bridge" widths={widths} setWidth={setWidth} min={160}>{t.ga.colBridge}</Th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {rows.map(g => {
                                        const o = g.ga ? objByGa.get(g.ga) : undefined;
                                        return (
                                            <tr key={g.key}>
                                                <td>
                                                    <AddressCell g={g} plan={plan} project={p} disabled={dirty || planning} issues={rowIssues.get(g.key) ?? []} onSave={saveOverride} />
                                                </td>
                                                <td>{g.name}{g.isStatus && <span className="tag" style={{ marginLeft: 8 }}>FB</span>}</td>
                                                <td className="mono nowrap">{g.dpt ?? "?"}</td>
                                                <td className="muted small">{g.rangePath.join(" › ")}</td>
                                                <td className="mono small">{o ? objectText(o, t) : <span className="muted">-</span>}</td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </>
            )}
            {!plan && !planning && !planErr.length && <p className="muted">{t.ga.hint(p.assignments.length)}</p>}
        </>
    );
}
