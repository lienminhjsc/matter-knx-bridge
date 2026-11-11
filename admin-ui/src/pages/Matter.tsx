import type { NodeInfo, Project } from "../api.ts";
import { unassignedEndpoints } from "../App.tsx";
import { useLang } from "../i18n.tsx";
import { PageHead } from "../ui.tsx";

function nodeName(n: NodeInfo): string {
    return `Node ${n.nodeId} ${n.product ?? n.vendor ?? ""}`.trim();
}

export function MatterPage({ nodes, project }: { nodes: NodeInfo[] | null; project: Project | null }) {
    const { t } = useLang();
    const list = nodes ?? [];
    const byNet = (k: string) => list.filter(n => n.network === k).length;
    const full = list.filter(n => n.fabrics && n.fabrics.used >= n.fabrics.supported);
    const offline = list.filter(n => !n.available);
    const unassigned = unassignedEndpoints(nodes, project);
    const unassignedNodes = [...new Map(unassigned.map(u => [u.node.nodeId, u.node])).values()];

    return (
        <>
            <PageHead step={2} title={t.matter.title}>
                <a className="btn btn-primary" href="#/assign">{t.matter.next}</a>
            </PageHead>

            <section className="grid4" aria-label={t.matter.title}>
                <div className="card stat">
                    <span className="muted small">{t.matter.nodes}</span>
                    <strong>{nodes ? list.length : "..."}</strong>
                    <span className="muted small">Wi-Fi {byNet("wifi")} · Thread {byNet("thread")}{byNet("ethernet") ? ` · Ethernet ${byNet("ethernet")}` : ""}</span>
                </div>
                <div className="card stat" style={full.length ? { borderColor: "#E9C98F" } : undefined}>
                    <span className="muted small">{t.matter.fabricFull}</span>
                    <strong className={full.length ? "wait" : ""}>{full.length}</strong>
                    <span className="muted small">{full.length ? full.map(n => `Node ${n.nodeId}`).join(", ") + " · 5/5" : t.matter.none}</span>
                </div>
                <div className="card stat">
                    <span className="muted small">{t.matter.unassigned}</span>
                    <strong>{unassigned.length}</strong>
                    <span className="muted small">{unassignedNodes.length ? unassignedNodes.map(nodeName).join(", ") : t.matter.none}</span>
                </div>
                <div className="card stat">
                    <span className="muted small">{t.matter.offline}</span>
                    <strong className={offline.length ? "err" : ""}>{offline.length}</strong>
                    <span className="muted small">{offline.length ? offline.map(n => `Node ${n.nodeId}`).join(", ") : t.matter.none}</span>
                </div>
            </section>

            {unassignedNodes.length > 0 && (
                <div role="status" className="note okb row" style={{ justifyContent: "space-between" }}>
                    <span style={{ flex: "1 1 360px" }}>
                        <span className="strong">{t.matter.newTitle(unassignedNodes.map(nodeName).join(", "))}</span> {t.matter.newBody}
                    </span>
                    <a className="btn btn-secondary" href="#/assign">{t.matter.toStep3}</a>
                </div>
            )}

            <div className="row" style={{ alignItems: "stretch", gap: 16 }}>
                <p className="note info" style={{ flex: "1 1 360px" }}>
                    <span className="strong">{t.matter.howTitle}</span> {t.matter.howBody}
                </p>
                <p className="note" style={{ flex: "1 1 360px" }}>
                    <span className="strong">{t.matter.lockTitle}</span> {t.matter.lockBody} <a href="#/locks">{t.matter.lockLink}</a>
                </p>
            </div>

            <section className="dash" aria-labelledby="dash-t">
                <div className="bar">
                    <span id="dash-t">{t.matter.embed}</span>
                    <a href="/matter/" target="_blank" rel="noopener">{t.matter.newTab}</a>
                </div>
                <iframe src="/matter/" title={t.matter.dashTitle} />
            </section>
        </>
    );
}
