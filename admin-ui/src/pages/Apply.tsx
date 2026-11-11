import { useEffect, useState } from "react";
import type { PlanState, ProjectState } from "../App.tsx";
import { api } from "../api.ts";
import { useLang } from "../i18n.tsx";
import { Button, ConfirmDialog, Notes, PageHead, useFmtTime } from "../ui.tsx";

export function ApplyPage({ ps, pl, onChanged }: { ps: ProjectState; pl: PlanState; onChanged: () => Promise<void> }) {
    const { t } = useLang();
    const fmt = useFmtTime();
    const { project: p, dirty } = ps;
    const { plan, planning, runPlan, setPlan } = pl;
    const [open, setOpen] = useState(false);

    // Opened step 5 directly: generate GAs from the saved project to have numbers.
    useEffect(() => {
        if (!plan && !planning && !dirty) void runPlan();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const errors = plan?.issues.filter(i => i.level === "error").length ?? 0;
    const blocked = dirty ? t.ga.saveFirst : !plan ? t.apply.needPlan : errors ? t.apply.blocked : "";

    const summary = plan && (
        <dl>
            <dt>{t.apply.objects}</dt><dd>{t.apply.objectsV(plan.objects.length)}</dd>
            <dt>{t.apply.slots}</dt><dd>{t.apply.slotsV(Object.keys(plan.slots).length)}</dd>
            <dt>{t.apply.writes}</dt><dd>{t.apply.writesV}</dd>
            <dt>{t.apply.effect}</dt><dd>{t.apply.effectV}</dd>
        </dl>
    );

    return (
        <>
            <PageHead step={5} title={t.apply.title} sub={t.apply.sub}>
                <Button kind="primary" disabled={Boolean(blocked)} busy={planning} onClick={() => setOpen(true)}>{t.apply.button}</Button>
                <a className="btn btn-secondary" href="#/handover">{t.apply.next}</a>
            </PageHead>
            {blocked && <Notes tone="warn" lines={[blocked]} />}
            <section className="card">
                <p className="muted" style={{ margin: 0 }}>{t.apply.last(fmt(p.applied?.at))}</p>
                {summary && <div className="dialog-like">{summary}</div>}
            </section>
            {open && plan && (
                <ConfirmDialog
                    title={t.apply.dialog}
                    action={t.apply.button}
                    summary={summary}
                    run={async () => {
                        const r = await api.apply();
                        setPlan(r);
                        await onChanged();
                        return <Notes tone="okb" lines={[t.apply.done(fmt(r.applied), r.objects.length)]} />;
                    }}
                    onClose={() => setOpen(false)}
                />
            )}
        </>
    );
}
