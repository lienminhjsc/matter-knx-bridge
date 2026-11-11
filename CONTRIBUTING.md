# Contributing

Thanks for your interest. Bug reports, device reports and pull requests are welcome. For larger changes, open an issue first so we can agree on the approach.

By contributing you agree that your contribution is licensed under the Apache License 2.0 (see [LICENSE](LICENSE)).

## Development setup

Requirements: Node.js 22 (>= 22.18, < 23). No other toolchain is needed; Node runs the TypeScript sources directly.

```sh
git clone https://github.com/tungvu9x/matter-knx-bridge.git
cd matter-knx-bridge
npm ci
npm test
```

On macOS with Homebrew, a newer Node may come first in `PATH`. Use Node 22 explicitly:

```sh
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
node -v   # v22.x
```

Running against real devices needs matterjs-server and a `config.json`, see [docs/en/setup.md](docs/en/setup.md). Most work can be done with the mock tests alone.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Runs all tests in `test/` with the Node test runner. Uses a fake Matter port and a simulated KNX client, no devices needed |
| `npm run typecheck` | Type-checks `src/` and `test/` (`tsconfig.json`) |
| `npm run typecheck:admin` | Type-checks the admin UI (`admin-ui/tsconfig.json`) |
| `npm run build:admin` | Builds the admin UI into `admin-ui/dist/` |
| `npm run dev:admin` | Vite dev server for the admin UI, proxies `/api` to a bridge running on 127.0.0.1:2401 |
| `npm start` | Runs the bridge with `config.json` |
| `npm run matter-server -- <options>` | Runs matterjs-server from `node_modules` |
| `npm run set-unlock-pin` | Sets the admin unlock PIN in `config.json` |

Run `npm test`, `npm run typecheck`, `npm run typecheck:admin` and `npm run build:admin` before opening a pull request. CI runs the same.

## Code conventions

- **Erasable TypeScript only.** Node strips types at runtime, so no `enum`, no `namespace` with values, no constructor parameter properties, no other syntax that needs transpiling (`erasableSyntaxOnly` is on in `tsconfig.json`). Use `as const` objects instead of enums.
- **Import with the `.ts` extension**: `import { Bridge } from "./bridge.ts";`. Type-only imports use `import type`.
- Keep the bridge core (`src/bridge.ts`, `src/mapping.ts`, `src/channels.ts`) free of KNX and admin specifics. Front ends talk to the core through channels.
- Feedback channels must only be updated from values reported by the device, never from the command that was sent.
- Prefer pure functions for conversions (`mapping.ts`, DPT codecs) and test them directly.
- Comments and log messages in English. Explain why, not what.
- New runtime dependencies need a good reason. Check their license (Apache-2.0 compatible, no GPL) and add them to [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Adding a device type or channel

New property on an existing kind (for example a new light attribute):

1. `src/channels.ts`: add the property to `CHANNELS[kind]` with type, `cmd` / `fb` and a short `doc`.
2. `src/mapping.ts`: compute the feedback value from Matter attributes in the matching `*Channels` function.
3. `src/bridge.ts`: handle the command in the matching `#...Command` method, with a `done` check that confirms the state reported by the device.
4. `src/knx/gateway.ts`: only if a new DPT family or transform is needed (encoding, decoding, validation).
5. Admin, if the planner should bind it: object binding in `src/admin/plan.ts`, handover value text in `admin-ui/src/i18n.tsx` (both languages).
6. Tests in `test/`.
7. Docs: `docs/en/channels.md` and `docs/vi/channels.md`, value tables in `docs/en/knx.md` and `docs/vi/knx.md`.

New device kind (for example window coverings): additionally extend `DeviceKind`, `CONFIG_SECTION` and `DEVICE_RE` in `src/channels.ts`, the slot interface and `LIMITS` in `src/config.ts`, publishing in `Bridge` (`#refreshNode` and the refresh paths), the circuit type suggestion in `src/admin/suggest.ts`, and slot allocation in `src/admin/plan.ts`.

Door lock related changes need extra care: unlock must stay opt-in, triggers must only act on `true`, and every unlock path must be logged.

## Admin UI and translations

- Every user-visible string goes through `admin-ui/src/i18n.tsx` and must exist in **both** Vietnamese (`vi`) and English (`en`). The `Dict` type makes a missing key a type error in `npm run typecheck:admin`.
- API errors return a stable `code` plus parameters; the UI translates the code. Do not show raw English server messages to users.
- Vietnamese text uses full diacritics.

## Documentation

- English docs live in `docs/en/`, Vietnamese in `docs/vi/`, with the same file names and structure. Update both when you change behaviour. If you cannot write one language, say so in the pull request and someone will help.
- Plain, precise language for engineers. No marketing wording, no emoji.
- **No em dashes** in docs or code comments. Use a colon, a comma or a new sentence.
- Do not state anything as verified that has not been tested on real hardware. Write "to be verified" instead.
- Commands and config keys in docs must match `package.json` and `config.example.json` / `src/config.ts`.
- Examples use private addresses like `192.168.1.x` and neutral device names.

## Commits and pull requests

- One topic per pull request. Keep refactors separate from behaviour changes.
- Commit subject in the imperative mood, at most about 72 characters (for example "Add DPT 9.007 humidity feedback for sensors"). Use the body to explain why.
- Fill in the pull request template: what changed, how it was tested (mock tests, which real devices), docs updated in both languages.
- Never commit `config.json`, `project.json`, `unlock-audit.log`, matter-server storage, pairing codes, IP plans of real sites or any secret. `.gitignore` covers the usual files; check `git status` before committing.

## Device reports

If you tested the bridge with a device, open a "Device report" issue: brand, model, Matter device type, Wi-Fi or Thread, what works and what does not. This helps others more than anything else.
