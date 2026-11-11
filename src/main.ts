// Entry point: node src/main.ts [path/to/config.json]
import { resolve } from "node:path";
import { ensureAdminPassword, loadConfig } from "./config.ts";
import { MatterGateway } from "./matter.ts";
import { Bridge, VERSION } from "./bridge.ts";
import { KnxGateway } from "./knx/gateway.ts";
import { AdminServer } from "./admin/server.ts";
import { loadPlanner } from "./admin/planner/load.ts";
import { log } from "./log.ts";

const configPath = resolve(process.argv[2] ?? process.env.BRIDGE_CONFIG ?? "config.json");

async function main(): Promise<void> {
    const generated = ensureAdminPassword(configPath);
    if (generated) {
        log.warn("main", `admin.password was not set: generated "${generated}" and saved it to ${configPath} (user "admin"). It is shown only once.`);
    }
    const cfg = loadConfig(configPath);
    log.info("main", `matter-knx-bridge ${VERSION}, config ${configPath}: ${Object.keys(cfg.locks).length} locks, ${Object.keys(cfg.lights).length} lights, ${Object.keys(cfg.sensors).length} sensors, ${Object.keys(cfg.thermostats).length} thermostats`);

    const matter = new MatterGateway(cfg.matter_server);
    const bridge = new Bridge(cfg, matter);
    let knx: KnxGateway | undefined;
    if (cfg.knx?.enabled) {
        knx = new KnxGateway(cfg.knx, {
            command: (channel, value) => void bridge.command(channel, value),
            value: channel => bridge.value(channel),
        });
    }
    // Channel changes go to the KNX layer (when enabled).
    bridge.onChange((channel, value) => knx?.channelChanged(channel, value));
    bridge.init();
    await knx?.listen();
    matter.start();

    let admin: AdminServer | undefined;
    if (cfg.admin?.enabled) {
        const planner = await loadPlanner(cfg.admin.planner_module);
        if (cfg.admin.planner_module) log.info("main", `GA planner "${planner.name}" from ${cfg.admin.planner_module}`);
        admin = new AdminServer(cfg.admin, {
            planner,
            configPath,
            getConfig: () => bridge.config,
            applyConfig: next => {
                bridge.setConfig(next);
                if (knx && next.knx) {
                    knx.setObjects(next.knx.objects);
                    knx.pushAll();
                }
            },
            matter,
            uiDir: resolve(import.meta.dirname, "..", "admin-ui", "dist"),
            status: () => ({
                version: VERSION,
                matter: { connected: matter.connected, nodes: matter.listNodes().length },
                knx: knx
                    ? {
                          tunnels: knx.server.tunnelCount,
                          port: knx.server.port,
                          objects: bridge.config.knx?.objects.length ?? 0,
                          host: cfg.knx?.host_ip ?? null,
                          individualAddress: cfg.knx?.individual_address ?? null,
                      }
                    : null,
            }),
        });
        await admin.listen();
    }

    const shutdown = async (sig: string) => {
        log.info("main", `received ${sig}, stopping`);
        bridge.stop();
        matter.stop();
        await knx?.close();
        await admin?.close();
        process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch(err => {
    log.error("main", (err as Error).message);
    process.exit(1);
});
