# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Repository moved to https://github.com/lienminhjsc/matter-knx-bridge. The project is now maintained by KNXStore.vn; copyright holder is Lien Minh System Integration JSC. The license stays Apache-2.0.
- Admin UI build tools: Vite 8.3.8 and `@vitejs/plugin-react` 6.3.0 (no change to the bundled runtime code).
- CI: `actions/checkout` and `actions/setup-node` v7. Dependabot now skips major updates and groups related packages.

## [0.1.0] - 2026-11-11

Initial public release.

### Added

- KNXnet/IP tunnelling server (UDP 3671): search and description, several tunnels (default 8), heartbeat, ACK and resend, forwarding of group telegrams between tunnels, `GroupValue_Read` answered from current state.
- Channel model between KNX and Matter for lights (on/off, level, hue, saturation, colour temperature), air conditioners and thermostats (on, setpoint, mode, fan stage and mode, temperature, humidity), sensors (occupancy, contact, temperature, humidity, lux, battery) and door locks (lock, unlock, locked, jammed, battery).
- DPT support: 1.x, 5.001, 5.x, 7.x, 9.x, 20.105; transforms `invert`, `hvac_mode`, `fan_level`. Fan defaults to DPT 5.100 stage 0-3, percent mode optional.
- Connection to matterjs-server (`matter-server` 1.5.5) over WebSocket with automatic reconnect.
- Admin web app on port 2401 (Vietnamese / English) with 6 steps: project, Matter (embedded matterjs-server dashboard), assign devices (Identify, circuit type suggestion), group address planning, apply without restart, handover (GA table, CSV, print, ETS export with address freezing).
- Built-in group address planner (scheme `builtin-v1`: main per system, middle per floor, 20-address block per room), manual address overrides, import of existing ETS addresses (CSV or XML) as reserved, ETS GroupAddress-Export XML and CSV export, pluggable planner via `admin.planner_module`.
- Door lock safety: unlocking over KNX off by default per lock, dashboard proxy blocks DoorLock commands except lock, admin unlock with a separate 6-digit PIN (scrypt hash, lockout after 5 wrong tries, audit log), `npm run set-unlock-pin`.
- Mock test suite (`npm test`) for bridge core, KNX layer and admin API.

[Unreleased]: https://github.com/lienminhjsc/matter-knx-bridge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lienminhjsc/matter-knx-bridge/releases/tag/v0.1.0
