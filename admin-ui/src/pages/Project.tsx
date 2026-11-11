import { useState } from "react";
import type { ProjectState } from "../App.tsx";
import { useLang } from "../i18n.tsx";
import { Button, Notes, PageHead, Th, useColumnWidths } from "../ui.tsx";

const CODE_RE = /^[A-Z0-9]{2,8}$/;
const toCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);

export function ProjectPage({ ps }: { ps: ProjectState }) {
    const { t } = useLang();
    const { project: p, update } = ps;
    const [msg, setMsg] = useState<string[]>([]);
    const [widths, setWidth] = useColumnWidths("rooms");
    const floors = [...p.floors].sort((a, b) => a.order - b.order);

    const addFloor = () =>
        update(x => {
            let n = x.floors.length;
            let code = `F${n + 1}`;
            while (x.floors.some(f => f.code === code)) code = `F${++n + 1}`;
            return { ...x, floors: [...x.floors, { code, label: t.project.newFloor(x.floors.length + 1), order: x.floors.length }] };
        });
    const addRoom = (floorCode: string) =>
        update(x => {
            let n = x.rooms.length + 1;
            let code = `R${String(n).padStart(2, "0")}`;
            while (x.rooms.some(r => r.code === code)) code = `R${String(++n).padStart(2, "0")}`;
            const order = x.rooms.filter(r => r.floorCode === floorCode).length;
            return { ...x, rooms: [...x.rooms, { code, floorCode, label: t.project.newRoom, order }] };
        });

    // Codes link floors, rooms and circuits: no duplicates, so two floors are never merged by mistake.
    const renameFloor = (old: string, code: string) => {
        if (code !== old && p.floors.some(f => f.code === code)) return setMsg([t.project.floorExists(code)]);
        setMsg([]);
        update(x => ({
            ...x,
            floors: x.floors.map(f => (f.code === old ? { ...f, code } : f)),
            rooms: x.rooms.map(r => (r.floorCode === old ? { ...r, floorCode: code } : r)),
            assignments: x.assignments.map(a => (a.floorCode === old ? { ...a, floorCode: code, name: a.name.replace(`${old}.`, `${code}.`) } : a)),
        }));
    };
    const renameRoom = (old: string, code: string) => {
        if (code !== old && p.rooms.some(r => r.code === code)) return setMsg([t.project.roomExists(code)]);
        setMsg([]);
        update(x => ({
            ...x,
            rooms: x.rooms.map(r => (r.code === old ? { ...r, code } : r)),
            assignments: x.assignments.map(a => (a.roomCode === old ? { ...a, roomCode: code, name: a.name.replace(`${a.floorCode}.${old}.`, `${a.floorCode}.${code}.`) } : a)),
        }));
    };

    const removeFloor = (code: string) => {
        if (p.rooms.some(r => r.floorCode === code)) return setMsg([t.project.floorHasRooms(code)]);
        setMsg([]);
        update(x => ({ ...x, floors: x.floors.filter(f => f.code !== code) }));
    };
    const removeRoom = (code: string) => {
        const used = p.assignments.filter(a => a.roomCode === code);
        if (used.length) return setMsg([t.project.roomHasCircuits(code, used.length)]);
        setMsg([]);
        update(x => ({ ...x, rooms: x.rooms.filter(r => r.code !== code) }));
    };

    return (
        <>
            <PageHead step={1} title={t.project.title} sub={t.project.sub}>
                <Button onClick={addFloor}>{t.project.addFloor}</Button>
                <a className="btn btn-primary" href="#/matter">{t.project.next}</a>
            </PageHead>
            <label className="lbl" style={{ maxWidth: 400 }}>
                {t.project.name}
                <input className="field" value={p.name} onChange={e => update(x => ({ ...x, name: e.target.value }))} />
            </label>
            <Notes tone="warn" lines={msg} />
            {p.exported && <Notes tone="info" lines={[t.project.frozenNote]} />}
            {!floors.length && <p className="muted">{t.project.noFloors}</p>}
            {floors.map(f => {
                const rooms = p.rooms.filter(r => r.floorCode === f.code).sort((a, b) => a.order - b.order);
                return (
                    <section className="card" key={f.code} aria-label={f.label}>
                        <div className="row">
                            <label className="lbl" style={{ width: 120 }}>
                                {t.project.floorCode}
                                <input className="field mono" value={f.code} aria-invalid={!CODE_RE.test(f.code)} onChange={e => renameFloor(f.code, toCode(e.target.value))} />
                            </label>
                            <label className="lbl" style={{ flex: "1 1 200px" }}>
                                {t.project.floorName}
                                <input className="field" value={f.label} onChange={e => update(x => ({ ...x, floors: x.floors.map(y => (y.code === f.code ? { ...y, label: e.target.value } : y)) }))} />
                            </label>
                            <label className="lbl" style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 16 }}>
                                <input type="checkbox" checked={Boolean(f.outdoor)} onChange={e => update(x => ({ ...x, floors: x.floors.map(y => (y.code === f.code ? { ...y, outdoor: e.target.checked } : y)) }))} />
                                {t.project.outdoor}
                            </label>
                            <div className="row" style={{ paddingTop: 16 }}>
                                <Button small onClick={() => addRoom(f.code)}>{t.project.addRoom}</Button>
                                <Button small onClick={() => removeFloor(f.code)}>{t.project.removeFloor}</Button>
                            </div>
                        </div>
                        {rooms.length > 0 && (
                            <div className="tablewrap">
                                <table>
                                    <thead>
                                        <tr>
                                            <Th col="code" widths={widths} setWidth={setWidth} min={140}>{t.project.roomCode}</Th>
                                            <Th col="name" widths={widths} setWidth={setWidth}>{t.project.roomName}</Th>
                                            <Th col="n" widths={widths} setWidth={setWidth} min={72}>{t.project.circuits}</Th>
                                            <th style={{ width: 100 }} />
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {rooms.map(r => (
                                            <tr key={r.code}>
                                                <td><input className="field mono" style={{ width: "100%" }} value={r.code} aria-label={t.project.roomCode} aria-invalid={!CODE_RE.test(r.code)} onChange={e => renameRoom(r.code, toCode(e.target.value))} /></td>
                                                <td><input className="field" style={{ width: "100%" }} value={r.label} aria-label={t.project.roomName} onChange={e => update(x => ({ ...x, rooms: x.rooms.map(y => (y.code === r.code ? { ...y, label: e.target.value } : y)) }))} /></td>
                                                <td>{p.assignments.filter(a => a.roomCode === r.code).length}</td>
                                                <td><Button small onClick={() => removeRoom(r.code)}>{t.project.remove}</Button></td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </section>
                );
            })}
        </>
    );
}
