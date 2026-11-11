# Guide for AI coding agents

matter-knx-bridge: Matter devices (via a local matterjs-server) exposed to KNX clients through a KNXnet/IP tunnelling server, plus an admin web app. Node 22, TypeScript run directly, no server build step.

Read first: [README.md](README.md), [docs/en/architecture.md](docs/en/architecture.md), [CONTRIBUTING.md](CONTRIBUTING.md).

## Repository map

| Path | Content |
|---|---|
| `src/main.ts` | Entry point, wiring, shutdown |
| `src/config.ts` | Config types, defaults, validation, slot limits |
| `src/channels.ts` | Channel model (source of truth for channel names and types) |
| `src/bridge.ts` | Core: commands to Matter, pending / timeout, unlock gating, publishing |
| `src/mapping.ts` | Matter attributes to channel values |
| `src/matter.ts` | WebSocket client to matterjs-server |
| `src/knx/` | `frames.ts` (KNXnet/IP, cEMI, DPT codecs), `server.ts` (tunnelling server), `gateway.ts` (GA bindings, transforms) |
| `src/admin/` | Admin HTTP server, dashboard proxy, project, plan, GA planner (`planner/`), ETS import / export (`ets.ts`), suggestions, unlock PIN |
| `admin-ui/` | React + Vite UI; strings in `admin-ui/src/i18n.tsx` (VI and EN) |
| `scripts/set-unlock-pin.ts` | PIN setup script |
| `test/` | Node test runner tests with fakes (no devices) |
| `docs/en/`, `docs/vi/` | Mirrored user docs |
| `config.example.json` | Config template; `config.json` is git-ignored |

## Checks

Run before you finish a change:

```sh
npm test
npm run typecheck
npm run typecheck:admin
npm run build:admin
```

On macOS with Homebrew use Node 22: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`.

## Conventions

- Erasable TypeScript only: no `enum`, no parameter properties, no value namespaces. Import local files with the `.ts` extension.
- The core stays free of KNX and admin specifics; front ends use channels.
- Feedback channels only from device reports, never echoed from commands.
- Renaming a channel or config key: update `src/channels.ts`, its users, the admin planner, tests, and both `docs/en/` and `docs/vi/` in the same change.
- Every UI string in both Vietnamese and English.
- Docs: no em dashes, no emoji, no unverified claims ("to be verified" instead), commands must match `package.json`.

## Safety rules

- **Never send commands to real door locks** (`lockDoor`, `unlockDoor`, `lock.N.unlock`, `/api/locks/*`) without explicit confirmation from a human for that specific action. Use the mock tests instead.
- Never set `unlock_enabled: true` or weaken unlock gating, the dashboard DoorLock filter or the PIN lockout without an explicit request and a test.
- Never commit `config.json`, `config.json.bak`, `project.json`, `unlock-audit.log`, `data/` or any matter-server storage, pairing / setup codes, fabric data, passwords, PIN hashes, or real site IP plans.
- Do not expose matter-server beyond `127.0.0.1` in examples or code.
- Ask before running anything that controls real devices or changes a running installation (apply, export, commissioning).
