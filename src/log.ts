// Logs to stdout/stderr, one line per event with timestamp. launchd/systemd collect it into a log file.
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel: Level = (process.env.LOG_LEVEL as Level) in ORDER ? (process.env.LOG_LEVEL as Level) : "info";

function write(level: Level, tag: string, parts: unknown[]): void {
    if (ORDER[level] < ORDER[minLevel]) return;
    const msg = parts.map(p => (p instanceof Error ? p.message : typeof p === "string" ? p : JSON.stringify(p))).join(" ");
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${tag}] ${msg}`;
    (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

export const log = {
    setLevel(l: Level): void {
        minLevel = l;
    },
    debug: (tag: string, ...p: unknown[]) => write("debug", tag, p),
    info: (tag: string, ...p: unknown[]) => write("info", tag, p),
    warn: (tag: string, ...p: unknown[]) => write("warn", tag, p),
    error: (tag: string, ...p: unknown[]) => write("error", tag, p),
};
