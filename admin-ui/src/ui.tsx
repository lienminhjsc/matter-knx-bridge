// Shared components: buttons with busy state, confirm dialog (confirm/sending/done/error), resizable table columns.
import { useEffect, useRef, useState, type ReactNode, type PointerEvent as RPointerEvent, type KeyboardEvent as RKeyboardEvent } from "react";
import { errorLines } from "./api.ts";
import { locale, useLang } from "./i18n.tsx";

/** Circuit types the bridge serves (matches BRIDGE_SUPPORTED in src/admin/suggest.ts). */
export const SUPPORTED = ["lt.onoff", "lt.dim", "lt.cct", "hvac.unit", "pres.sensor", "sec.contact"];

export function Button(props: {
    kind?: "primary" | "secondary";
    small?: boolean;
    busy?: boolean;
    disabled?: boolean;
    onClick?: () => void;
    type?: "button" | "submit";
    children: ReactNode;
}) {
    const cls = `btn btn-${props.kind ?? "secondary"}${props.small ? " btn-sm" : ""}`;
    return (
        <button type={props.type ?? "button"} className={cls} disabled={props.disabled || props.busy} aria-busy={props.busy || undefined} onClick={props.onClick}>
            {props.busy && <span className="spin" aria-hidden="true" />}
            {props.children}
        </button>
    );
}

export function Notes({ lines, tone }: { lines: string[]; tone: "danger" | "warn" | "info" | "okb" }) {
    if (!lines.length) return null;
    return (
        <div className={`note ${tone}`} role={tone === "danger" ? "alert" : "status"}>
            {lines.length === 1 ? lines[0] : (
                <>
                    <span className="strong">{lines[0]}</span>
                    <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>{lines.slice(1).map((l, i) => <li key={i}>{l}</li>)}</ul>
                </>
            )}
        </div>
    );
}

export function PageHead({ step, title, sub, children }: { step?: number; title: string; sub?: ReactNode; children?: ReactNode }) {
    const { t } = useLang();
    return (
        <div className="head">
            <div className="t">
                {step !== undefined && <span className="muted small">{t.step(step)}</span>}
                <h1>{title}</h1>
                {sub && <span className="muted">{sub}</span>}
            </div>
            {children && <div className="row noprint">{children}</div>}
        </div>
    );
}

type Phase = "confirm" | "sending" | "done" | "error";

/**
 * Confirm dialog before sending. run() returns the "done" content; a thrown error goes to "error" with a retry button.
 * blocker: a non empty string disables the send button. onError returns custom content for an error (e.g. 409).
 */
export function ConfirmDialog(props: {
    title: string;
    kicker?: string;
    summary: ReactNode;
    action: string;
    run: () => Promise<ReactNode>;
    onClose: (done: boolean) => void;
    blocker?: string;
    extra?: ReactNode;
    onError?: (e: unknown) => ReactNode | undefined;
    /** Error the user can fix in place (e.g. wrong PIN): stay in the confirm step, show the error above the button. */
    inlineError?: (e: unknown) => ReactNode | undefined;
}) {
    const { t } = useLang();
    const [phase, setPhase] = useState<Phase>("confirm");
    const [result, setResult] = useState<ReactNode>(null);
    const [err, setErr] = useState<unknown>(null);
    const [inline, setInline] = useState<ReactNode>(null);
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => ref.current?.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled)")?.focus(), [phase]);
    useEffect(() => {
        const k = (e: KeyboardEvent) => e.key === "Escape" && phase !== "sending" && props.onClose(phase === "done");
        window.addEventListener("keydown", k);
        return () => window.removeEventListener("keydown", k);
    }, [phase, props]);

    const go = async () => {
        setPhase("sending");
        setInline(null);
        try {
            setResult(await props.run());
            setPhase("done");
        } catch (e) {
            const il = props.inlineError?.(e);
            if (il) {
                setInline(il);
                setPhase("confirm");
                return;
            }
            setErr(e);
            setPhase("error");
        }
    };

    return (
        <div className="overlay">
            <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-t" ref={ref}>
                <div className="t" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {props.kicker && <span className="muted small">{props.kicker}</span>}
                    <h2 id="dlg-t">{props.title}</h2>
                </div>
                {phase === "done" ? result : props.summary}
                {(phase === "confirm" || phase === "sending") && props.extra}
                {inline}
                {phase === "error" && (props.onError?.(err) ?? <Notes tone="danger" lines={[t.sendFailed, ...errorLines(err, t)]} />)}
                <div className="row" style={{ justifyContent: "flex-end" }}>
                    {phase === "done" ? (
                        <Button kind="primary" onClick={() => props.onClose(true)}>{t.close}</Button>
                    ) : (
                        <>
                            <Button disabled={phase === "sending"} onClick={() => props.onClose(false)}>{t.cancel}</Button>
                            <Button kind="primary" busy={phase === "sending"} disabled={Boolean(props.blocker)} onClick={go}>
                                {phase === "sending" ? t.sending : phase === "error" || inline ? t.retry : props.action}
                            </Button>
                        </>
                    )}
                </div>
                {props.blocker && phase !== "done" && <p className="muted small" style={{ margin: 0 }}>{props.blocker}</p>}
            </div>
        </div>
    );
}

export function useFmtTime(): (iso: string | null | undefined) => string {
    const { lang, t } = useLang();
    return iso => {
        if (!iso) return t.never;
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(locale(lang));
    };
}

// ------------------------------------------------------------ Resizable table columns

const COLS_KEY = "mb.cols.";

/** Column widths (px) per table, remembered in the browser. undefined = automatic. */
export function useColumnWidths(table: string): [Record<string, number>, (col: string, w: number) => void] {
    const [w, setW] = useState<Record<string, number>>(() => {
        try {
            return JSON.parse(localStorage.getItem(COLS_KEY + table) ?? "{}") as Record<string, number>;
        } catch {
            return {};
        }
    });
    const set = (col: string, px: number) =>
        setW(cur => {
            const next = { ...cur, [col]: px };
            try {
                localStorage.setItem(COLS_KEY + table, JSON.stringify(next));
            } catch {
                // ignore
            }
            return next;
        });
    return [w, set];
}

/** Column header with a resize handle on its right edge (mouse, touch, arrow keys when the handle has focus). */
export function Th(props: { col: string; widths: Record<string, number>; setWidth: (col: string, w: number) => void; min?: number; children?: ReactNode }) {
    const { lang } = useLang();
    const ref = useRef<HTMLTableCellElement>(null);
    const min = props.min ?? 56;
    const width = props.widths[props.col];
    const start = (e: RPointerEvent<HTMLSpanElement>) => {
        e.preventDefault();
        const th = ref.current;
        if (!th) return;
        const x0 = e.clientX;
        const w0 = th.getBoundingClientRect().width;
        const target = e.currentTarget;
        target.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => props.setWidth(props.col, Math.max(min, Math.round(w0 + ev.clientX - x0)));
        const up = () => {
            target.removeEventListener("pointermove", move);
            target.removeEventListener("pointerup", up);
        };
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", up);
    };
    const key = (e: RKeyboardEvent<HTMLSpanElement>) => {
        const cur = ref.current?.getBoundingClientRect().width ?? min;
        if (e.key === "ArrowRight") props.setWidth(props.col, Math.round(cur + 16));
        if (e.key === "ArrowLeft") props.setWidth(props.col, Math.max(min, Math.round(cur - 16)));
    };
    return (
        <th ref={ref} style={width ? { width, minWidth: width, maxWidth: width } : { minWidth: min }}>
            <span className="th-label">{props.children}</span>
            <span
                className="col-grip noprint"
                role="separator"
                aria-orientation="vertical"
                aria-label={lang === "vi" ? "Kéo để đổi độ rộng cột" : "Drag to resize column"}
                tabIndex={0}
                onPointerDown={start}
                onKeyDown={key}
                onDoubleClick={() => props.setWidth(props.col, 0)}
            />
        </th>
    );
}
