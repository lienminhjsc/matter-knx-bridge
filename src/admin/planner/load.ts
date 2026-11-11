// Loads the GA planner: the built-in planner, or an ES module named by admin.planner_module.
// The module exports a GaPlanner as its default export (or as a named export "planner").
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { builtinPlanner } from "./builtin.ts";
import type { GaPlanner } from "./types.ts";

export function isGaPlanner(v: unknown): v is GaPlanner {
    const p = v as Partial<GaPlanner> | null;
    return typeof p === "object" && p !== null && typeof p.name === "string" && p.name.length > 0 && typeof p.plan === "function";
}

/**
 * Returns the planner for admin.planner_module. Unset: the built-in planner. A relative path resolves against
 * the working directory. Throws a clear error when the module cannot be loaded or exports no planner.
 */
export async function loadPlanner(modulePath: string | undefined): Promise<GaPlanner> {
    if (!modulePath) return builtinPlanner;
    const url = pathToFileURL(resolve(modulePath)).href;
    let mod: Record<string, unknown>;
    try {
        mod = (await import(url)) as Record<string, unknown>;
    } catch (e) {
        throw new Error(`admin.planner_module ${modulePath}: cannot load module (${(e as Error).message})`);
    }
    const p = mod.default ?? mod.planner;
    if (!isGaPlanner(p)) {
        throw new Error(`admin.planner_module ${modulePath}: the module must export a GaPlanner ({ name: string, plan(input, options) }) as default export or as "planner"`);
    }
    return p;
}
