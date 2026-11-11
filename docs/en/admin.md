# Admin web app

English | [Tiếng Việt](../vi/admin.md)

The admin web app runs inside the bridge process on port 2401. It guides a commissioning engineer from an empty project to a working KNX installation in 6 steps, and has a separate page for door locks. The UI is available in Vietnamese and English (switch at the top; the browser remembers the choice, default Vietnamese). The embedded matterjs-server dashboard is English only.

Build the UI once after install or update: `npm run build:admin`.

## Configuration: `admin`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Start the admin server |
| `host` | `"0.0.0.0"` | Listen address. Use the LAN address of the host to avoid listening on other interfaces |
| `port` | `2401` | HTTP port |
| `password` | generated | Password of user `admin`, at least 8 characters. If missing, generated on first start, saved to `config.json` and printed once in the log |
| `project_path` | `"project.json"` | Project data (floors, rooms, assignments, address snapshots) |
| `unlock_pin_hash` | unset | Hash of the 6-digit unlock PIN, set with `npm run set-unlock-pin`. Unset: no unlocking from the admin |
| `audit_path` | `"unlock-audit.log"` | Unlock audit log, one JSON object per line |
| `planner_module` | unset | Path to an ES module with a custom group address planner, resolved against the working directory. Unset: built-in planner. See [Custom planner module](#custom-planner-module) |

## Login and session

- The browser asks for user `admin` and the password (HTTP Basic auth).
- After a successful login the bridge sets a session cookie `mb_session` (HttpOnly, SameSite=Strict, valid 12 hours). The cookie is also what authenticates the dashboard WebSocket, since browsers do not always send Basic credentials on WebSocket requests.
- Sessions are kept in memory: restarting the bridge logs everybody out.
- The connection is plain HTTP. Use the admin only on a trusted LAN or behind your own VPN or TLS reverse proxy.
- Requests that change something (POST, PUT, DELETE) and the dashboard WebSocket are refused with 403 when the browser sends an `Origin` that does not match the `Host` header. A reverse proxy in front of the admin must pass the original `Host` header.

To change the password, edit `admin.password` in `config.json` and restart the bridge, or delete the key to have a new one generated.

## Step 1: Project

Enter the project name, floors and rooms.

- Floor and room codes: 2 to 8 characters, `A-Z` and `0-9`. Room codes are unique within the project.
- Codes are the prefix of circuit names and group address names (for example `GF.LIV.L01`), so choose them before step 4. Changing codes after an ETS export renames group addresses; frozen addresses stay the same.
- A floor can be marked as outdoor.

## Step 2: Matter

Shows the matterjs-server state (nodes, offline nodes, nodes with full fabrics, unassigned nodes) and embeds the matterjs-server dashboard. Use the dashboard to commission devices with a pairing code and to look at the Thread network graph. See [commissioning.md](commissioning.md).

The dashboard is served by the bridge under `/matter/`, behind the admin login. See [Dashboard proxy](#dashboard-proxy) for what the bridge changes and blocks.

## Step 3: Assign devices

Lists every endpoint of every node.

- **Identify** makes the device show itself for 10 seconds (Matter Identify cluster), so you can match the row to the physical device.
- **Circuit type**: suggested from the clusters, editable. Circuit types the bridge controls today: on/off light, dimmable light, CCT light, air conditioner, presence sensor, door contact. Other types (RGB light, shades, blinds) can be recorded in the project, but the built-in planner generates no group addresses for them (warning).
- **Room** and **circuit name**: the name is generated as `{floor}.{room}.{token}` and can be edited. ASCII, no spaces, must start with the floor and room codes, unique.
- For an air conditioner, choose the fan group address format: stage 0-3 (DPT 5.100, default) or percent (DPT 5.001) with Low / Medium / High percentages. See [knx.md](knx.md#fan-stage-or-percent).

Door locks are not assigned here; they are configured in `config.json` ([knx.md](knx.md#door-locks)).

## Step 4: Group address

Generates group addresses for every assigned circuit from the saved project, and shows which ones the bridge serves.

- Unsaved changes in steps 1 to 3 block generation: the bridge always plans from the saved project.
- The planner assigns addresses and DPTs per circuit, and the bridge maps each address to a channel (for example the dimming value of a light to `light.N.level`). The default scheme (main per system, middle per floor, a block of 20 subs per room) and the objects per circuit type are described in [knx.md](knx.md#group-address-layout).
- Results: total group addresses, how many the bridge serves, errors (they block apply and export) and warnings.
- After an ETS export, addresses are frozen. If regenerating would change an address that was already exported, it is listed under address changes.

**Manual overrides.** Any address in the GA table can be edited inline. It is stored in the project (`overrides`, keyed by circuit and object) and shown with a "manual" tag; it can be set back to the generated address. Checks: invalid format, the same manual address used twice, an address imported from ETS (allowed only after confirming "use the imported address"), an address outside the valid range (main 0-31, middle 0-7, sub 0-255, not 0/0/0), conflicts with another group address, and overrides whose group address no longer exists (warning).

**Import existing ETS addresses.** To avoid clashes with a KNX installation already on site, import its group address export in step 4. Accepted formats, detected automatically: ETS CSV (1-level or 3-level, separated by `;`, `,` or tab, with or without BOM) and ETS GroupAddress-Export XML, up to 16 MB. Imported addresses become reserved: the planner skips them, and a manual address on a reserved address needs confirmation. Group addresses previously exported by the bridge itself are recognised and not reserved. An import replaces the reserved list (or merges with it); it can be cleared. Group addresses that deliberately use an imported address are left out of the bridge's ETS export files, since they already exist in the ETS project.

Import of real ETS 5 / 6 export files: to be verified.

## Step 5: Apply

Loads the plan into the running bridge:

- Writes `lights`, `thermostats`, `sensors` and `knx.objects` into `config.json`. The previous file is kept as `config.json.bak`. Other keys (locks, KNX interface settings, admin) are kept.
- **`knx.objects` is replaced completely.** Objects written by hand are removed.
- Slots: a node and endpoint keeps the slot number it already had, so existing bindings do not move. Slots of devices not in the project (for example hand-configured locks) are kept.
- The bridge reloads the configuration without restarting. Open KNX tunnels stay connected and receive the current state of every feedback group address.
- Apply is refused while the plan has errors, and needs an explicit confirmation in a dialog.

## Step 6: Handover

The reference for whoever sets up the KNX client.

- **Group address table**: every group address grouped by floor and room, with name, direction (command or feedback), device, and the **values to enter in the KNX client** (for example `0 Auto · 1 Heat · 3 Cool · 6 Off · 9 Fan · 14 Dry` for the HVAC mode). A filter shows only the addresses served by the bridge. The header shows the IP interface (bridge IP and port 3671).
- **CSV**: the full table as UTF-8 with BOM, so spreadsheet programs keep accented characters.
- **Print**: a printable version with project name, revision, IP and print date in the header.
- **ETS export**: produces `matter-bridge-rev<N>-ets.xml` (ETS GroupAddress-Export XML: group ranges nested by main then middle, DPTs as `DPST-x-y`, with descriptions) and `matter-bridge-rev<N>-ga.csv` (3-level CSV with BOM). The export **freezes** the addresses at revision N. If later changes would move an already exported address, the export dialog lists the changes and requires an explicit confirmation; the ETS project and the KNX client must then be updated again.

Importing these files into ETS 5 / 6: to be verified.

## Door locks page

Lists the locks from `config.json` with status, battery and whether KNX unlocking is enabled.

- **Lock**: sends `lockDoor` after a confirmation dialog.
- **Unlock**: needs the **unlock PIN**, which is separate from the admin password.
- The page also shows the unlock audit log (last 50 entries) and lets you change the PIN (the current PIN is required).

### Unlock PIN

Set it on the bridge host:

```sh
npm run set-unlock-pin              # uses config.json
npm run set-unlock-pin -- other.json
```

The script asks for 6 digits twice, stores an scrypt hash (random salt) in `admin.unlock_pin_hash`, and keeps the old file as `config.json.bak`. Restart the bridge afterwards.

- 5 wrong PINs in a row lock unlocking for 5 minutes. The counter is global for the bridge, not per IP address.
- Every attempt (unlocked, wrong PIN, locked out, failed command, PIN changed, blocked dashboard command) is written to `admin.audit_path` with time, source and client IP.
- Commands to a lock use a Matter timed request (10 s), as required by the DoorLock cluster.

The PIN protects unlocking from the admin. It is independent of `unlock_enabled`, which only controls unlocking over KNX. Whether a lock additionally requires its own PIN for remote operation (RequirePINforRemoteOperation) has not been tested with real locks.

## Dashboard proxy

The bridge forwards `/matter/` to matter-server (`matter_server` in `config.json`, normally `127.0.0.1:5580`):

- HTTP requests are forwarded without the browser's `Authorization` and `Cookie` headers. The dashboard files are not modified, except that one script tag (`window.__MATTERJS_PRODUCTION_MODE__=true`) is inserted into the index page so that the dashboard connects to `/matter/ws` instead of asking for a server URL.
- The WebSocket `/matter/ws` requires a valid admin session. Messages from the dashboard are inspected before they reach matter-server. Blocked:
  - every DoorLock (cluster 257) command except `lockDoor`, including inside batched commands;
  - every attribute write to cluster 257.
  - text and binary messages alike, and any message that is not plain JSON.
- A blocked message gets an error answer (code 403) in the dashboard and an entry `blocked_dashboard` in the audit log.
- WebSocket compression is not negotiated, so every message can be inspected.

The filter stops casual or accidental unlocking from the dashboard. It is not a sandbox: the dashboard keeps full controller rights, so someone with the admin password can still, for example, open a commissioning window on a lock and pair it with another controller. Treat the admin password as giving control of every commissioned device.

This filter only applies to the proxy. A client that connects to matter-server directly is not filtered, which is why matter-server must listen on `127.0.0.1` only.

The embedded dashboard has been used in Chrome on desktop. Safari and mobile browsers: to be verified.

## Custom planner module

The address scheme is pluggable. Set `admin.planner_module` to the path of an ES module that exports a planner as its default export or as a named export `planner`:

```js
// tiny-planner.mjs: one switch GA per circuit in main group 9
export default {
    name: "tiny",
    plan(input) {
        const gas = input.circuits.map((c, i) => ({
            ga: "9/0/" + (i + 1), name: "T " + c.name, dpt: "1.001",
            deviceId: c.id, objectKey: "SW", isStatus: false, rangePath: ["Tiny", "All"],
        }));
        return { scheme: "tiny-1", gas, issues: [], stats: { total: gas.length, bySystem: {}, maxUtilization: null } };
    },
};
```

- `plan(input, options?)` must be synchronous and deterministic. `input` has `floors`, `rooms`, `circuits` (id, name, type, floor and room codes, options such as `fanFormat`) and `reserved` (imported addresses to skip). The types are in `src/admin/planner/types.ts`.
- `objectKey` values must match the keys the bridge binds (see the object table in [knx.md](knx.md#group-address-layout)); other keys stay in the export without a binding.
- On top of any planner, the bridge applies manual overrides, checks duplicates and reserved addresses, and forces the DPTs of the fan (5.100 or 5.001) and mode (20.105) objects.

The bridge refuses to start if the module cannot be loaded or exports no planner.

## HTTP API

The UI uses a JSON API under `/api/` with the same authentication: status, nodes, identify, project, plan, apply, export, locks. Apply, export and lock require `"confirm": true` in the body; unlock requires the PIN. The API is internal to the admin UI and may change between versions.
