import { useCallback, useEffect, useState } from "react";
import { api, errorLines, type NodeInfo, type PlanSummary, type Project, type Status } from "./api.ts";
import { LangSwitch, useLang } from "./i18n.tsx";
import { Button, Notes, SUPPORTED } from "./ui.tsx";
import { ProjectPage } from "./pages/Project.tsx";
import { MatterPage } from "./pages/Matter.tsx";
import { AssignPage } from "./pages/Assign.tsx";
import { GroupAddressPage } from "./pages/GroupAddress.tsx";
import { ApplyPage } from "./pages/Apply.tsx";
import { HandoverPage } from "./pages/Handover.tsx";
import { LocksPage } from "./pages/Locks.tsx";

const PAGES = ["project", "matter", "assign", "ga", "apply", "handover", "locks"] as const;
type PageKey = (typeof PAGES)[number];

function pageFromHash(): PageKey {
    const h = location.hash.replace(/^#\/?/, "");
    return (PAGES as readonly string[]).includes(h) ? (h as PageKey) : "project";
}

export interface ProjectState {
    project: Project;
    dirty: boolean;
    update: (fn: (p: Project) => Project) => void;
    save: () => Promise<void>;
    saving: boolean;
}

/** GA plan shared by steps 4, 5 and 6. */
export interface PlanState {
    plan: PlanSummary | null;
    planning: boolean;
    planErr: string[];
    runPlan: () => Promise<void>;
    setPlan: (p: PlanSummary) => void;
}

/** Endpoints the bridge supports that are not assigned in the project yet. */
export function unassignedEndpoints(nodes: NodeInfo[] | null, p: Project | null): { node: NodeInfo; endpoint: number }[] {
    if (!nodes || !p) return [];
    const ids = new Set(p.assignments.map(a => a.id));
    return nodes.flatMap(n => n.endpoints.filter(e => e.bridgeSupported && e.suggested && SUPPORTED.includes(e.suggested) && !ids.has(`n${n.nodeId}e${e.endpoint}`)).map(e => ({ node: n, endpoint: e.endpoint })));
}

export function App() {
    const { t } = useLang();
    const [page, setPage] = useState<PageKey>(pageFromHash);
    const [status, setStatus] = useState<Status | null>(null);
    const [nodes, setNodes] = useState<NodeInfo[] | null>(null);
    const [saved, setSaved] = useState<Project | null>(null);
    const [draft, setDraft] = useState<Project | null>(null);
    const [loadErr, setLoadErr] = useState<unknown>(null);
    const [saving, setSaving] = useState(false);
    const [saveErr, setSaveErr] = useState<unknown>(null);
    const [plan, setPlan] = useState<PlanSummary | null>(null);
    const [planning, setPlanning] = useState(false);
    const [planErr, setPlanErr] = useState<unknown>(null);

    useEffect(() => {
        const f = () => {
            setPage(pageFromHash());
            window.scrollTo(0, 0);
        };
        window.addEventListener("hashchange", f);
        return () => window.removeEventListener("hashchange", f);
    }, []);

    const refreshStatus = useCallback(() => api.status().then(s => { setStatus(s); setLoadErr(null); }, setLoadErr), []);
    const refreshNodes = useCallback(() => api.nodes().then(setNodes, setLoadErr), []);

    useEffect(() => {
        refreshStatus();
        refreshNodes();
        api.project().then(p => {
            setSaved(p);
            setDraft(p);
        }, setLoadErr);
        const t1 = setInterval(refreshStatus, 5000);
        // Nodes commissioned in step 2 show up in step 3 without reloading the page.
        const t2 = setInterval(refreshNodes, 10000);
        return () => {
            clearInterval(t1);
            clearInterval(t2);
        };
    }, [refreshStatus, refreshNodes]);

    const dirty = Boolean(draft && saved && JSON.stringify(draft) !== JSON.stringify(saved));
    useEffect(() => {
        const f = (e: BeforeUnloadEvent) => {
            if (dirty) e.preventDefault();
        };
        window.addEventListener("beforeunload", f);
        return () => window.removeEventListener("beforeunload", f);
    }, [dirty]);

    const runPlan = useCallback(async () => {
        setPlanning(true);
        setPlanErr(null);
        try {
            setPlan(await api.plan());
        } catch (e) {
            setPlan(null);
            setPlanErr(e);
        } finally {
            setPlanning(false);
        }
    }, []);

    const reloadProject = useCallback(async () => {
        const p = await api.project();
        setSaved(p);
        setDraft(p);
        refreshStatus();
    }, [refreshStatus]);

    const save = async () => {
        if (!draft) return;
        setSaving(true);
        setSaveErr(null);
        try {
            const p = await api.saveProject(draft);
            setSaved(p);
            setDraft(p);
            setPlan(null); // the old GA plan no longer matches the project
        } catch (e) {
            setSaveErr(e);
        } finally {
            setSaving(false);
        }
    };

    const ps: ProjectState | null = draft ? { project: draft, dirty, update: fn => setDraft(d => (d ? fn(d) : d)), save, saving } : null;
    const pl: PlanState = { plan, planning, planErr: planErr ? errorLines(planErr, t) : [], runPlan, setPlan };

    const unassigned = unassignedEndpoints(nodes, draft);
    const planErrors = plan?.issues.filter(i => i.level === "error").length ?? 0;
    type Badge = { text: string; tone: "ok" | "wait" | "n" } | null;
    const badge: Record<PageKey, Badge> = {
        project: draft?.floors.length && draft.rooms.length ? { text: "✓", tone: "ok" } : null,
        matter: nodes ? { text: String(nodes.length), tone: "n" } : null,
        assign: unassigned.length ? { text: String(unassigned.length), tone: "wait" } : draft?.assignments.length ? { text: "✓", tone: "ok" } : null,
        ga: plan ? (planErrors ? { text: String(planErrors), tone: "wait" } : { text: "✓", tone: "ok" }) : null,
        apply: draft?.applied && !dirty ? { text: "✓", tone: "ok" } : null,
        handover: draft?.exported ? { text: "✓", tone: "ok" } : null,
        locks: null,
    };
    const label: Record<PageKey, string> = {
        project: t.nav.project, matter: t.nav.matter, assign: t.nav.assign, ga: t.nav.ga, apply: t.nav.apply, handover: t.nav.handover, locks: t.nav.locks,
    };

    return (
        <div className="layout">
            <nav className="nav" aria-label={t.nav.steps}>
                <div className="brand">
                    <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
                        <rect x="2" y="2" width="28" height="28" rx="8" fill="none" stroke="#7FB0E8" strokeWidth="2" />
                        <path d="M10 16h12M16 10v12" stroke="#7FB0E8" strokeWidth="2" />
                    </svg>
                    <div>
                        <strong>Matter Bridge</strong>
                        <br />
                        <span>{status?.knx?.host ? `KNX · ${status.knx.host}` : "Matter to KNX"}</span>
                    </div>
                </div>
                {PAGES.map((k, i) => (
                    <a key={k} href={`#/${k}`} className={k === "locks" ? "locks" : undefined} aria-current={page === k ? "page" : undefined}>
                        {k === "locks" ? label[k] : `${i + 1} · ${label[k]}`}
                        {badge[k] && <span className={`st ${badge[k]!.tone}`}>{badge[k]!.text}</span>}
                    </a>
                ))}
                <div className="foot">
                    {status ? (
                        <>
                            <span className="dot" style={{ background: status.matter.connected ? "#4ADE80" : "#F87171" }} />
                            {status.matter.connected ? t.nav.matterOn : t.nav.matterOff}
                            <br />
                            {draft && <>{draft.name}<br />{draft.exported ? t.nav.frozen(draft.rev) : t.nav.notFrozen(draft.rev)}<br /></>}
                            v{status.version}
                        </>
                    ) : (
                        t.loading
                    )}
                </div>
            </nav>
            <main className="main">
                <div className="topbar noprint"><LangSwitch /></div>
                <Notes tone="danger" lines={loadErr ? errorLines(loadErr, t) : []} />
                {ps && dirty && (
                    <div className="note warn row" style={{ justifyContent: "space-between" }} role="status">
                        <span>{t.unsaved}</span>
                        <div className="row">
                            <Button small disabled={saving} onClick={() => saved && setDraft(saved)}>{t.discard}</Button>
                            <Button small kind="primary" busy={saving} onClick={save}>{t.save}</Button>
                        </div>
                    </div>
                )}
                <Notes tone="danger" lines={saveErr ? errorLines(saveErr, t) : []} />
                {page === "project" && ps && <ProjectPage ps={ps} />}
                {page === "matter" && <MatterPage nodes={nodes} project={draft} />}
                {page === "assign" && ps && <AssignPage ps={ps} nodes={nodes} onRefresh={refreshNodes} />}
                {page === "ga" && ps && <GroupAddressPage ps={ps} pl={pl} onChanged={reloadProject} />}
                {page === "apply" && ps && <ApplyPage ps={ps} pl={pl} onChanged={reloadProject} />}
                {page === "handover" && ps && <HandoverPage ps={ps} pl={pl} nodes={nodes} status={status} onChanged={reloadProject} />}
                {page === "locks" && <LocksPage />}
                {!ps && !loadErr && page !== "matter" && page !== "locks" && <p className="muted">{t.loading}</p>}
            </main>
        </div>
    );
}
