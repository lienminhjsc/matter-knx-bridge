import { useCallback, useEffect, useState } from "react";
import { api, ApiError, errorLines, type LockInfo, type LocksInfo } from "../api.ts";
import { useLang } from "../i18n.tsx";
import { Button, ConfirmDialog, Notes, PageHead, Th, useColumnWidths, useFmtTime } from "../ui.tsx";

const PIN_RE = /^\d{6}$/;

function PinInput({ id, label, value, onChange, help }: { id: string; label: string; value: string; onChange: (v: string) => void; help?: string }) {
    return (
        <label htmlFor={id} className="lbl" style={{ gap: 8 }}>
            {label}
            <input
                id={id}
                className="pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={value}
                onChange={e => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
                aria-describedby={help ? `${id}-help` : undefined}
            />
            {help && <span id={`${id}-help`} className="muted small">{help}</span>}
        </label>
    );
}

export function LocksPage() {
    const { t } = useLang();
    const fmt = useFmtTime();
    const [info, setInfo] = useState<LocksInfo | null>(null);
    const [err, setErr] = useState<unknown>(null);
    const [unlockOf, setUnlockOf] = useState<LockInfo | null>(null);
    const [lockOf, setLockOf] = useState<LockInfo | null>(null);
    const [changing, setChanging] = useState(false);
    const [pin, setPin] = useState("");
    const [cur, setCur] = useState("");
    const [next, setNext] = useState("");
    const [widths, setWidth] = useColumnWidths("unlock-log");

    const load = useCallback(() => api.locks().then(i => { setInfo(i); setErr(null); }, setErr), []);
    useEffect(() => {
        void load();
        const id = setInterval(load, 3000);
        return () => clearInterval(id);
    }, [load]);

    const lockedMin = info && info.lockedForMs > 0 ? Math.ceil(info.lockedForMs / 60000) : 0;
    // Wrong PIN: keep the dialog and show the attempts left. Locked out: close the dialog, show it on the page.
    const pinInline = (e: unknown) => {
        if (e instanceof ApiError && e.code === "pin_wrong") {
            setPin("");
            void load();
            return <div role="alert" className="note danger">{t.locks.attempts(Number(e.detail?.attemptsLeft ?? 0))}</div>;
        }
        if (e instanceof ApiError && e.code === "pin_locked_out") {
            void load();
            setUnlockOf(null);
            setChanging(false);
        }
        return undefined;
    };

    return (
        <>
            <PageHead title={t.locks.title} sub={t.locks.sub} />
            <Notes tone="danger" lines={err ? errorLines(err, t) : []} />
            {info && !info.pinSet && <Notes tone="warn" lines={[t.locks.noPin]} />}
            {lockedMin > 0 && (
                <div role="alert" className="note danger"><span className="strong" style={{ color: "var(--color-danger-700)" }}>{t.locks.lockedTitle(lockedMin)}</span> {t.locks.lockedBody}</div>
            )}
            {info && !info.locks.length && <p className="muted">{t.locks.none}</p>}
            {info?.locks.map(l => (
                <section key={l.slot} className="card" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center" }} aria-label={l.name}>
                    <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true"><rect x="8" y="18" width="24" height="16" rx="3" fill="none" stroke="#14467C" strokeWidth="2" /><path d="M13 18v-5a7 7 0 0 1 14 0v5" fill="none" stroke="#14467C" strokeWidth="2" /></svg>
                    <div style={{ flex: "1 1 320px", display: "flex", flexDirection: "column" }}>
                        <h2 style={{ fontSize: 14 }}>{l.name || `Lock ${l.slot}`}</h2>
                        <span className="muted small">Node {l.nodeId} · EP {l.endpoint} · {t.locks.slot(l.slot)}{l.battery !== null ? ` · ${l.battery} %` : ""}{l.online ? "" : ` · ${t.assign.offline}`}</span>
                    </div>
                    <span className={l.status === "Locked" ? "ok" : "wait"}>{t.locks.status[l.status] ?? l.status}</span>
                    <Button disabled={!l.online} onClick={() => setLockOf(l)}>{t.locks.lock}</Button>
                    <Button kind="primary" disabled={!l.online || !info.pinSet || lockedMin > 0} onClick={() => { setPin(""); setUnlockOf(l); }}>{t.locks.unlock}</Button>
                </section>
            ))}

            <div className="split">
                <section className="card side" aria-labelledby="rules" style={{ maxWidth: "none", flex: "1 1 360px" }}>
                    <h2 id="rules">{t.locks.rulesTitle}</h2>
                    <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "120px minmax(0, 1fr)", gap: "12px 16px", overflowWrap: "anywhere" }}>
                        <dt className="muted small">{t.locks.rAdmin}</dt>
                        <dd style={{ margin: 0 }}>{t.locks.rAdminV} {info?.pinSet && <button type="button" className="linklike" onClick={() => { setCur(""); setNext(""); setChanging(true); }}>{t.locks.changePin}</button>}</dd>
                        <dt className="muted small">{t.locks.rDash}</dt><dd style={{ margin: 0 }}>{t.locks.rDashV}</dd>
                        <dt className="muted small">{t.locks.rKnx}</dt><dd style={{ margin: 0 }}>{t.locks.rKnxV(Boolean(info?.locks.some(l => l.unlockEnabled)))}</dd>
                        <dt className="muted small">{t.locks.rDevice}</dt><dd style={{ margin: 0 }} className="wait">{t.locks.rDeviceV}</dd>
                    </dl>
                </section>
                <section className="card wide" aria-labelledby="log">
                    <h2 id="log">{t.locks.logTitle}</h2>
                    {info?.log.length ? (
                        <div className="tablewrap">
                            <table>
                                <thead>
                                    <tr>
                                        <Th col="at" widths={widths} setWidth={setWidth} min={140}>{t.locks.colTime}</Th>
                                        <Th col="src" widths={widths} setWidth={setWidth} min={200}>{t.locks.colSource}</Th>
                                        <Th col="res" widths={widths} setWidth={setWidth} min={160}>{t.locks.colResult}</Th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {info.log.map((e, i) => (
                                        <tr key={i}>
                                            <td className="mono nowrap">{fmt(e.at)}</td>
                                            <td>{t.locks.source[e.source] ?? e.source} · {e.ip}{e.target ? ` · ${e.target}` : ""}</td>
                                            <td className={e.result === "unlocked" || e.result === "pin_changed" ? "ok" : "err"}>{t.locks.result[e.result] ?? e.result}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : (
                        <p className="muted" style={{ margin: 0 }}>{t.locks.noLog}</p>
                    )}
                </section>
            </div>

            {unlockOf && (
                <ConfirmDialog
                    kicker={t.locks.dlgKicker}
                    title={t.locks.dlgTitle(unlockOf.name || `Lock ${unlockOf.slot}`)}
                    action={t.locks.confirm}
                    blocker={PIN_RE.test(pin) ? "" : " "}
                    summary={<PinInput id="pin" label={t.locks.pinLabel} value={pin} onChange={setPin} help={t.locks.pinHelp} />}
                    inlineError={pinInline}
                    run={async () => {
                        await api.unlock(unlockOf.slot, pin);
                        setPin("");
                        void load();
                        return <Notes tone="okb" lines={[t.locks.done]} />;
                    }}
                    onClose={() => { setPin(""); setUnlockOf(null); }}
                />
            )}
            {lockOf && (
                <ConfirmDialog
                    kicker={t.locks.dlgKicker}
                    title={t.locks.lockDialog(lockOf.name || `Lock ${lockOf.slot}`)}
                    action={t.locks.lock}
                    summary={null}
                    run={async () => {
                        await api.lock(lockOf.slot);
                        void load();
                        return null;
                    }}
                    onClose={() => setLockOf(null)}
                />
            )}
            {changing && (
                <ConfirmDialog
                    title={t.locks.changeTitle}
                    action={t.locks.changePin}
                    blocker={PIN_RE.test(cur) && PIN_RE.test(next) ? "" : " "}
                    summary={
                        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                            <PinInput id="pin-cur" label={t.locks.current} value={cur} onChange={setCur} />
                            <PinInput id="pin-next" label={t.locks.next} value={next} onChange={setNext} />
                        </div>
                    }
                    inlineError={e => {
                        const r = pinInline(e);
                        if (r) setCur("");
                        return r;
                    }}
                    run={async () => {
                        await api.changePin(cur, next);
                        void load();
                        return <Notes tone="okb" lines={[t.locks.changeDone]} />;
                    }}
                    onClose={() => setChanging(false)}
                />
            )}
        </>
    );
}
