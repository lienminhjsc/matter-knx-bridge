// Admin unlock PIN: scrypt hash, wrong-attempt limit, audit log (memory + JSON lines file).
import { appendFileSync } from "node:fs";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const PIN_RE = /^\d{6}$/;
export const MAX_WRONG = 5;
export const LOCKOUT_MS = 5 * 60 * 1000;

export function hashPin(pin: string): string {
    const salt = randomBytes(16);
    return `scrypt$${salt.toString("hex")}$${scryptSync(pin, salt, 32).toString("hex")}`;
}

export function verifyPin(pin: string, stored: string): boolean {
    const [kind, saltHex, hashHex] = stored.split("$");
    if (kind !== "scrypt" || !saltHex || !hashHex) return false;
    const got = scryptSync(pin, Buffer.from(saltHex, "hex"), 32);
    return timingSafeEqual(got, Buffer.from(hashHex, "hex"));
}

export type AuditResult = "unlocked" | "wrong_pin" | "locked_out" | "failed" | "blocked_dashboard" | "pin_changed";

export interface AuditEntry {
    at: string;
    source: "admin" | "dashboard";
    ip: string;
    result: AuditResult;
    target?: string;
    detail?: string;
}

/** Counts wrong attempts for the whole bridge (not per IP: an attacker can change IP). */
export class UnlockGuard {
    #wrong = 0;
    #lockedUntil = 0;
    #log: AuditEntry[] = [];
    #path: string | undefined;
    #now: () => number;

    constructor(auditPath?: string, now: () => number = Date.now) {
        this.#path = auditPath;
        this.#now = now;
    }

    /** Remaining lockout in ms; 0 = not locked out. */
    lockedFor(): number {
        return Math.max(0, this.#lockedUntil - this.#now());
    }

    get attemptsLeft(): number {
        return this.lockedFor() > 0 ? 0 : MAX_WRONG - this.#wrong;
    }

    /** Checks a PIN. The MAX_WRONG-th wrong attempt locks out for LOCKOUT_MS. */
    check(pin: string, stored: string): "ok" | "wrong" | "locked" {
        if (this.lockedFor() > 0) return "locked";
        if (PIN_RE.test(pin) && verifyPin(pin, stored)) {
            this.#wrong = 0;
            return "ok";
        }
        this.#wrong++;
        if (this.#wrong >= MAX_WRONG) {
            this.#wrong = 0;
            this.#lockedUntil = this.#now() + LOCKOUT_MS;
            return "locked";
        }
        return "wrong";
    }

    record(e: Omit<AuditEntry, "at">): void {
        const entry = { at: new Date(this.#now()).toISOString(), ...e };
        this.#log.unshift(entry);
        this.#log.length = Math.min(this.#log.length, 100);
        if (this.#path) {
            try {
                appendFileSync(this.#path, JSON.stringify(entry) + "\n");
            } catch {
                // the file log is secondary; the in-memory log remains
            }
        }
    }

    get entries(): AuditEntry[] {
        return this.#log;
    }
}
