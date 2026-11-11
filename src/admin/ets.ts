// ETS exchange: GroupAddress-Export XML and CSV writers (handover to ETS 5/6), and a tolerant reader for
// ETS group address exports (CSV 1-level or 3-level, GroupAddress-Export XML) used to reserve addresses
// already in use on site. Pure functions, no I/O.
import { gaNumber, normalizeGa, parseGa, type GaEntry, type ReservedGa } from "./planner/types.ts";

/** GA as exported: planner entry after manual overrides. */
export type ExportGa = Pick<GaEntry, "ga" | "name" | "dpt" | "rangePath" | "description"> & { overridden?: boolean };

/** "1.001" -> "DPST-1-1", "20.105" -> "DPST-20-105", "9" -> "DPT-9". Empty for unknown input. */
export function etsDptId(dpt: string | null | undefined): string {
    if (!dpt) return "";
    const m = /^(\d+)(?:\.(\d+))?$/.exec(dpt.trim());
    if (!m) return "";
    return m[2] === undefined ? `DPT-${Number(m[1])}` : `DPST-${Number(m[1])}-${Number(m[2])}`;
}

/** "DPST-1-1" -> "1.001", "DPT-9" -> "9", "5.001" -> "5.001". Undefined when not recognised. */
export function dptFromEts(s: string | undefined): string | undefined {
    if (!s) return undefined;
    const first = s.split(/[,;\s]+/).find(x => x.trim()) ?? "";
    let m = /^DPST-(\d+)-(\d+)$/i.exec(first);
    if (m) return `${Number(m[1])}.${String(Number(m[2])).padStart(3, "0")}`;
    m = /^DPT-(\d+)$/i.exec(first);
    if (m) return String(Number(m[1]));
    m = /^(\d+)\.(\d+)$/.exec(first);
    if (m) return `${Number(m[1])}.${m[2].padStart(3, "0")}`;
    return undefined;
}

export function xmlEscape(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

interface Ranges {
    mains: Map<number, string>;
    middles: Map<string, string>;
}

/** Range names from the planner rangePath of non overridden GAs; fallback "Main N" / "Middle N/M". */
function rangeNames(gas: ExportGa[]): Ranges {
    const mains = new Map<number, string>();
    const middles = new Map<string, string>();
    for (const g of gas) {
        const p = parseGa(g.ga);
        if (!p || g.overridden) continue;
        if (g.rangePath[0] && !mains.has(p[0])) mains.set(p[0], g.rangePath[0]);
        if (g.rangePath[1] && !middles.has(`${p[0]}/${p[1]}`)) middles.set(`${p[0]}/${p[1]}`, g.rangePath[1]);
    }
    return { mains, middles };
}

/** Valid GAs sorted by address, grouped main -> middle. */
function grouped(gas: ExportGa[]): Map<number, Map<number, ExportGa[]>> {
    const sorted = gas.filter(g => parseGa(g.ga)).sort((a, b) => gaNumber(a.ga) - gaNumber(b.ga));
    const out = new Map<number, Map<number, ExportGa[]>>();
    for (const g of sorted) {
        const [m, mid] = parseGa(g.ga)!;
        if (!out.has(m)) out.set(m, new Map());
        const mm = out.get(m)!;
        if (!mm.has(mid)) mm.set(mid, []);
        mm.get(mid)!.push(g);
    }
    return out;
}

/** ETS 5/6 GroupAddress-Export XML (import in ETS: Group Addresses > Import). */
export function buildEtsXml(gas: ExportGa[]): string {
    const names = rangeNames(gas);
    const lines = ['<?xml version="1.0" encoding="utf-8" standalone="yes"?>', '<GroupAddress-Export xmlns="http://knx.org/xml/ga-export/01">'];
    for (const [m, mids] of grouped(gas)) {
        const mStart = Math.max(1, m << 11);
        lines.push(`  <GroupRange Name="${xmlEscape(names.mains.get(m) ?? `Main ${m}`)}" RangeStart="${mStart}" RangeEnd="${(m << 11) + 2047}">`);
        for (const [mid, list] of mids) {
            const base = (m << 11) | (mid << 8);
            lines.push(`    <GroupRange Name="${xmlEscape(names.middles.get(`${m}/${mid}`) ?? `Middle ${m}/${mid}`)}" RangeStart="${Math.max(1, base)}" RangeEnd="${base + 255}">`);
            for (const g of list) {
                const dpt = etsDptId(g.dpt);
                const attrs = [`Name="${xmlEscape(g.name)}"`, `Address="${g.ga}"`];
                if (dpt) attrs.push(`DPTs="${dpt}"`);
                if (g.description) attrs.push(`Description="${xmlEscape(g.description)}"`);
                lines.push(`      <GroupAddress ${attrs.join(" ")} />`);
            }
            lines.push("    </GroupRange>");
        }
        lines.push("  </GroupRange>");
    }
    lines.push("</GroupAddress-Export>");
    return lines.join("\r\n") + "\r\n";
}

function csvQuote(s: string): string {
    return `"${s.replace(/"/g, '""')}"`;
}

/** ETS "3/Level" group address CSV (comma separated, quoted, UTF-8 with BOM). */
export function buildEtsCsv(gas: ExportGa[]): string {
    const names = rangeNames(gas);
    const row = (cells: string[]) => cells.map(csvQuote).join(",");
    const lines = [row(["Main", "Middle", "Sub", "Address", "Central", "Unfiltered", "Description", "DatapointType", "Security"])];
    for (const [m, mids] of grouped(gas)) {
        lines.push(row([names.mains.get(m) ?? `Main ${m}`, "", "", `${m}/-/-`, "", "", "", "", "Auto"]));
        for (const [mid, list] of mids) {
            lines.push(row(["", names.middles.get(`${m}/${mid}`) ?? `Middle ${m}/${mid}`, "", `${m}/${mid}/-`, "", "", "", "", "Auto"]));
            for (const g of list) lines.push(row(["", "", g.name, g.ga, "", "", g.description ?? "", etsDptId(g.dpt), "Auto"]));
        }
    }
    return "﻿" + lines.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------------------------------------
// Import

export interface EtsImportError {
    line: number;
    address: string;
    code: "address_format" | "address_level";
    text: string;
}

export interface EtsImportResult {
    format: "csv" | "xml";
    entries: ReservedGa[];
    /** Addresses found more than once in the file (first occurrence kept). */
    duplicates: string[];
    errors: EtsImportError[];
}

/** RFC 4180 style CSV reader: quoted cells, "" escapes, line breaks inside quotes. Returns rows with their line number. */
export function parseCsv(text: string, delim: string): { line: number; cells: string[] }[] {
    const rows: { line: number; cells: string[] }[] = [];
    let cells: string[] = [];
    let cell = "";
    let quoted = false;
    let line = 1;
    let rowLine = 1;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    cell += '"';
                    i++;
                } else quoted = false;
            } else {
                if (ch === "\n") line++;
                cell += ch;
            }
            continue;
        }
        if (ch === '"') quoted = true;
        else if (ch === delim) {
            cells.push(cell);
            cell = "";
        } else if (ch === "\n" || ch === "\r") {
            if (ch === "\r" && text[i + 1] === "\n") i++;
            cells.push(cell);
            if (cells.some(c => c.trim())) rows.push({ line: rowLine, cells });
            cells = [];
            cell = "";
            line++;
            rowLine = line;
        } else cell += ch;
    }
    cells.push(cell);
    if (cells.some(c => c.trim())) rows.push({ line: rowLine, cells });
    return rows;
}

/** Delimiter of the first non empty line: the most frequent of ";", ",", tab outside quotes (default ","). */
export function detectDelimiter(text: string): string {
    const first = text.split(/\r?\n/).find(l => l.trim()) ?? "";
    let best = ",";
    let bestN = 0;
    for (const d of [",", ";", "\t"]) {
        let n = 0;
        let q = false;
        for (const ch of first) {
            if (ch === '"') q = !q;
            else if (!q && ch === d) n++;
        }
        if (n > bestN) {
            best = d;
            bestN = n;
        }
    }
    return best;
}

const ADDR3 = /^\d+\/\d+\/\d+$/;
const PARTIAL = /^\d+\/(\d+|-)\/-$/;

function norm(s: string): string {
    return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function addEntry(out: EtsImportResult, seen: Set<string>, line: number, address: string, name: string, dpt: string | undefined): void {
    const a = address.trim();
    if (!a || PARTIAL.test(a)) return; // empty or a group range row of the 3-level CSV ("1/-/-", "1/1/-")
    let ga: string | undefined;
    if (ADDR3.test(a)) ga = normalizeGa(a);
    else if (/^\d+$/.test(a) && Number(a) > 0 && Number(a) < 65536) {
        const n = Number(a);
        ga = `${n >> 11}/${(n >> 8) & 7}/${n & 255}`;
    } else if (/^\d+\/\d+$/.test(a)) {
        out.errors.push({ line, address: a, code: "address_level", text: `line ${line}: ${a} is a 2-level address; export with 3-level addresses` });
        return;
    }
    if (!ga) {
        out.errors.push({ line, address: a, code: "address_format", text: `line ${line}: "${a}" is not a valid group address` });
        return;
    }
    if (seen.has(ga)) {
        if (!out.duplicates.includes(ga)) out.duplicates.push(ga);
        return;
    }
    seen.add(ga);
    out.entries.push(dpt ? { ga, name: name.trim(), dpt } : { ga, name: name.trim() });
}

function parseCsvExport(text: string): EtsImportResult {
    const out: EtsImportResult = { format: "csv", entries: [], duplicates: [], errors: [] };
    const seen = new Set<string>();
    const rows = parseCsv(text, detectDelimiter(text));
    const headerAt = rows.slice(0, 10).findIndex(r => r.cells.some(c => norm(c) === "address"));
    if (headerAt < 0) {
        // No header: ETS 1-level order "Group name","Address",... or any row with a 3-level address cell.
        for (const r of rows) {
            const i = r.cells.findIndex(c => ADDR3.test(c.trim()) || /^\d+\/\d+$/.test(c.trim()));
            if (i < 0) continue;
            const name = r.cells.slice(0, i).reverse().find(c => c.trim()) ?? "";
            addEntry(out, seen, r.line, r.cells[i], name, dptFromEts(r.cells.find(c => /^DPS?T-/i.test(c.trim()))));
        }
        return out;
    }
    const head = rows[headerAt].cells.map(norm);
    const col = (...names: string[]) => head.findIndex(h => names.includes(h));
    const iAddr = col("address");
    const iName = col("group name", "name", "sub");
    const iMain = col("main");
    const iMiddle = col("middle");
    const iDpt = col("datapointtype", "datapoint type", "dpt", "dpts", "data point type");
    for (const r of rows.slice(headerAt + 1)) {
        const c = (i: number) => (i >= 0 ? r.cells[i] ?? "" : "");
        const name = c(iName) || c(iMiddle) || c(iMain);
        addEntry(out, seen, r.line, c(iAddr), name, dptFromEts(c(iDpt)));
    }
    return out;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function xmlDecode(s: string): string {
    return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e: string) => {
        if (e[0] === "#") {
            const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(n) ? String.fromCodePoint(n) : all;
        }
        return ENTITIES[e] ?? all;
    });
}

function parseXmlExport(text: string): EtsImportResult {
    const out: EtsImportResult = { format: "xml", entries: [], duplicates: [], errors: [] };
    const seen = new Set<string>();
    const re = /<GroupAddress(?=[\s/>])([^>]*?)\/?>/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
        const attrs: Record<string, string> = {};
        const ar = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
        for (let a = ar.exec(m[1]); a; a = ar.exec(m[1])) attrs[a[1]] = xmlDecode(a[2] ?? a[3] ?? "");
        const line = text.slice(0, m.index).split("\n").length;
        addEntry(out, seen, line, attrs.Address ?? "", attrs.Name ?? "", dptFromEts(attrs.DPTs ?? attrs.DatapointType));
    }
    return out;
}

/** Reads an ETS group address export (format detected from the content; UTF-8 BOM tolerated). */
export function parseEtsExport(raw: string): EtsImportResult {
    const text = raw.replace(/^﻿/, "");
    return text.trimStart().startsWith("<") ? parseXmlExport(text) : parseCsvExport(text);
}
