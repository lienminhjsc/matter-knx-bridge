# matter-knx-bridge

English | [Tiếng Việt](README.vi.md)

matter-knx-bridge makes Matter devices (Wi-Fi and Thread) controllable from any KNX system. It runs next to a local [matterjs-server](https://github.com/matter-js/matterjs-server) and presents itself on the LAN as a **KNXnet/IP tunnelling interface**. KNX clients (visualisations, home automation controllers, ETS group monitor) connect to it like to any IP interface and read and write group addresses; the bridge turns those into Matter commands and pushes device state back as group telegrams.

Devices that already live in Apple Home or Google Home are added through Matter multi-admin with their 11-digit pairing code, so they stay in their original ecosystem as well.

Version 0.1.0. This is a DIY project: read the [disclaimer](#disclaimer) before using it, especially with door locks.

## Features

- KNXnet/IP tunnelling server on UDP 3671: discovery by multicast search, several tunnels at once (default 8), feedback pushed to every tunnel on change, `GroupValue_Read` answered from the current state.
- Typed channels between KNX and Matter, for example `light.1.on`, `light.1.level`, `hvac.1.setpoint`, `hvac.1.mode`, `hvac.1.fan`, `sensor.1.occupancy`, `lock.1.locked`. Full list: [docs/en/channels.md](docs/en/channels.md).
- Supported DPT families: 1.x, 5.001, 5.x (1 byte, for example 5.010, 5.100), 7.x, 9.x, 20.105. Transforms for door contacts (`invert`), HVAC mode (`hvac_mode`, DPT 20.105) and fan speed in percent (`fan_level`).
- Feedback comes only from values reported by the device, never from the command that was sent. A command that is not confirmed in time sets the device `error` channel.
- Admin web app on port 2401 (login user `admin`), bilingual Vietnamese / English, that walks a commissioning engineer through 6 steps: project, Matter, assign devices, group addresses, apply, handover. Built-in group address planner with manual overrides, import of existing ETS addresses as reserved, and ETS export; the planner is pluggable.
- Embedded matterjs-server dashboard (Thread graph, commissioning) behind the admin login. The proxy blocks door unlock commands sent from the dashboard.
- Door locks: unlocking over KNX is off by default per lock (`unlock_enabled`). Unlocking from the admin needs a separate 6-digit PIN with lockout and an audit log.
- Configuration changes from the admin are applied to the running bridge without a restart.

## Architecture

```
 KNX clients                     matter-knx-bridge (Node 22)                  matterjs-server          Devices
 (visualisation,     UDP 3671   +----------------------------+  WebSocket   +----------------+
  controller,     <-----------> | KNXnet/IP tunnelling server|  127.0.0.1   | Matter         |  Wi-Fi   Matter
  ETS monitor)                  |   group address <-> channel| <----------> | controller     | <------> devices
                                |                            |    :5580     | (fabric data)  |  Thread  (via border
 Browser          HTTP 2401     | Bridge core (channels,     |              | dashboard      |          router)
 (engineer)   <---------------> |   pending, unlock gating)  |              +----------------+
                                | Admin web app + dashboard  |
                                |   proxy (/matter/)         |
                                +----------------------------+
```

More detail: [docs/en/architecture.md](docs/en/architecture.md).

## Status

| Area | Status |
|---|---|
| Thread on/off switch (multi-admin from Apple Home) | Matter side verified on real hardware, through an earlier non-KNX front end of the same bridge core; KNX feedback read over a tunnel verified; KNX commands to be verified |
| Wi-Fi air conditioner controller: mode, setpoint, fan | Matter side verified on real hardware, through an earlier non-KNX front end of the same bridge core; KNX feedback read over a tunnel verified; KNX commands to be verified |
| ETS discovers the bridge as a KNXnet/IP interface | Verified |
| Savant Generic KNX end-to-end through the bridge | To be verified |
| ETS 5 / 6 import of the exported group address files (XML, CSV) | To be verified |
| Importing real ETS 5 / 6 group address exports into the admin | To be verified |
| Real door locks (lock, unlock from admin, jammed event) | To be verified |
| Embedded dashboard in Safari and mobile browsers | To be verified (works in Chrome on desktop) |
| Dimmers, colour temperature, sensors on real devices | To be verified (covered by mock tests) |
| Google Home multi-admin pairing code | To be verified |
| Raspberry Pi 5 deployment | To be verified (developed and tested on macOS) |

## Requirements

- Node.js 22 (>= 22.18, < 23). The bridge runs its TypeScript sources directly, there is no build step for the server.
- A host on the same LAN (same L2 segment / VLAN) as the KNX clients and the Matter devices. Tested on macOS; Raspberry Pi 5 is the intended target.
- For Thread devices: a Thread border router on that LAN (for example HomePod mini, Apple TV 4K or a Google Nest hub) and IPv6 routing to the Thread network on the host.
- Each device needs a free Matter fabric slot (devices usually allow 5).

## Quick start

```sh
git clone https://github.com/tungvu9x/matter-knx-bridge.git
cd matter-knx-bridge
npm ci
npm run build:admin
cp config.example.json config.json   # then edit knx.host_ip and remove the example devices

# Terminal 1: Matter controller, WebSocket on 127.0.0.1:5580
npm run matter-server -- --storage-path ./data/matter --listen-address 127.0.0.1

# Terminal 2: the bridge
npm start
```

On first start the bridge generates an admin password, writes it into `config.json` and prints it once in the log. Open `http://<bridge-ip>:2401`, log in as `admin` and follow the 6 steps. Full instructions: [docs/en/setup.md](docs/en/setup.md), [docs/en/commissioning.md](docs/en/commissioning.md), [docs/en/admin.md](docs/en/admin.md).

## Configuration overview

`config.json` (not committed, template: [`config.example.json`](config.example.json)):

| Key | Meaning |
|---|---|
| `matter_server` | WebSocket URL of matter-server, default `ws://127.0.0.1:5580/ws` |
| `pending_timeout_ms`, `command_timeout_ms` | Wait for device confirmation (default 10000) and per request timeout (default 15000) |
| `lights`, `thermostats`, `sensors`, `locks` | Device slots: `{ "1": { "node_id": 5, "endpoint": 1, "name": "..." } }`. Locks also have `unlock_enabled` (default `false`) |
| `knx` | KNXnet/IP server: `host_ip`, `friendly_name`, `individual_address`, `tunnel_address`, `max_tunnels`, `objects` (group address bindings) |
| `admin` | Admin web app: `host`, `port` (2401), `password`, `project_path`, `unlock_pin_hash`, `audit_path`, `planner_module` |

The admin writes `lights`, `thermostats`, `sensors` and `knx.objects` for you when you apply a plan. Locks are configured by hand. Details: [docs/en/knx.md](docs/en/knx.md).

## Documentation

| Topic | English | Tiếng Việt |
|---|---|---|
| Setup (macOS, Raspberry Pi 5, systemd) | [setup](docs/en/setup.md) | [setup](docs/vi/setup.md) |
| Adding Matter devices (multi-admin) | [commissioning](docs/en/commissioning.md) | [commissioning](docs/vi/commissioning.md) |
| KNX side: tunnelling, ETS, DPTs | [knx](docs/en/knx.md) | [knx](docs/vi/knx.md) |
| Admin web app, handover, door locks | [admin](docs/en/admin.md) | [admin](docs/vi/admin.md) |
| Channel reference | [channels](docs/en/channels.md) | [channels](docs/vi/channels.md) |
| Example client: Savant Generic KNX | [example-savant](docs/en/example-savant.md) | [example-savant](docs/vi/example-savant.md) |
| Architecture | [architecture](docs/en/architecture.md) | [architecture](docs/vi/architecture.md) |

## Security notes

- Run the bridge on a trusted LAN only. KNXnet/IP tunnelling has no authentication: anyone who can reach UDP 3671 can switch the bound devices. Never expose ports 3671, 2401 or 5580 to the Internet.
- Keep matter-server bound to `127.0.0.1`. The admin proxy filters door lock commands, a direct connection to port 5580 does not.
- The admin uses HTTP Basic auth plus a session cookie over plain HTTP. Use it on the local network or through your own VPN / TLS terminator.
- `config.json`, `project.json`, `unlock-audit.log` and the matter-server storage directory contain secrets and fabric data. Do not commit or share them.

See [SECURITY.md](SECURITY.md) for the threat model and how to report a vulnerability.

## Disclaimer

This is a DIY project published as is, without warranty (see the license). It is not certified by any standards body and has not been tested for safety-critical or life-safety use. You use it at your own risk. Be especially careful with door locks: a configuration mistake or a bug can unlock a door. Keep `unlock_enabled` off unless you have verified the setup on site.

matter-knx-bridge talks to Matter devices through matterjs-server and to KNX systems through standard KNXnet/IP tunnelling. It is not affiliated with, endorsed by or certified by the Connectivity Standards Alliance, KNX Association, the Open Home Foundation or Savant. Matter, KNX and Savant are trademarks of their respective owners and are used here only to describe compatibility. No logos of these organisations are used.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Device reports (what works with which device) are welcome through the issue templates.

## License

Apache License 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE). Third-party components: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
