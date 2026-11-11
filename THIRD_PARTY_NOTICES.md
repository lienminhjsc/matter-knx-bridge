# Third-party notices

matter-knx-bridge is licensed under Apache-2.0. This file lists the third-party software it uses, how each piece reaches a running installation, and its license. Versions are the ones pinned in `package.json` / `package-lock.json` for release 0.1.0.

The repository itself does not contain third-party source code. Runtime dependencies are installed by `npm ci`. The admin UI build (`npm run build:admin`, output in `admin-ui/dist/`) bundles React and two font families; if you distribute a built copy, include the notices below.

## Runtime dependencies (installed by npm)

| Package | Version | License | Role |
|---|---|---|---|
| `matter-server` | 1.5.5 | Apache-2.0 (LICENSE file) | matterjs-server: Matter controller with WebSocket API on port 5580 and the web dashboard |
| `@matter-server/ws-client` | 1.5.5 | Apache-2.0 | WebSocket client the bridge uses to talk to matter-server |
| `@matter-server/dashboard` | 1.5.5 | Apache-2.0 | Dashboard web app served by matter-server, shown in admin step 2 |
| `@matter-server/ws-controller`, `@matter-server/custom-clusters`, `@matter-server/ble-proxy` | 1.5.5 | Apache-2.0 (LICENSE file; no `license` field in package.json) | Parts of matter-server |
| `@matter/*` (`main`, `node`, `nodejs`, `nodejs-ble`, `protocol`, `types`, `model`, `general`, `thread-br-client`, `dcl-data`) | 0.18.0 (`dcl-data` 2026.11.7) | Apache-2.0 | matter.js, the Matter stack used by matter-server |

matter-server pulls in further transitive packages (express, ws, lit, vis-network, noble/bleno, serialport, usb and others). Their licenses are MIT, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, Apache-2.0, `Apache-2.0 OR MIT`, BlueOak-1.0.0 and Public Domain (`jsonify`). Run `npm ls --omit=dev --all` and read each package's `package.json` / LICENSE for the exact list.

Note on `usb` (MIT, transitive through `@matter/nodejs-ble`, used only for Bluetooth commissioning): the npm package ships the libusb source and prebuilt native binaries. libusb is licensed LGPL-2.1. matter-knx-bridge does not modify, link to or redistribute it; npm installs it as part of matter-server. If you redistribute a full installation (for example a disk image with `node_modules/`), check the LGPL-2.1 obligations for libusb.

No package in the production dependency tree declares a GPL license. The only copyleft code found is libusb (LGPL-2.1) inside `usb`, described above.

## Bundled into the admin UI build (`admin-ui/dist/`)

| Package | Version | License | Notes |
|---|---|---|---|
| `react`, `react-dom`, `scheduler` | 18.3.1, 18.3.1, 0.23.2 | MIT | Copyright (c) Facebook, Inc. and its affiliates |
| `@fontsource/onest` | 5.3.1 | OFL-1.1 | Onest font, Copyright 2021 The Onest Project Authors (https://github.com/simpals/onest) |
| `@fontsource/jetbrains-mono` | 5.3.0 | OFL-1.1 | JetBrains Mono font, Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) |

The fonts are bundled so the admin UI works on a site LAN without Internet access. The SIL Open Font License 1.1 text is included in each `@fontsource` package (`node_modules/@fontsource/*/LICENSE`).

## Build and development tools (not shipped)

TypeScript (Apache-2.0), Vite (MIT), `@vitejs/plugin-react` (MIT), `@types/*` (MIT). These are dev dependencies and are not part of a running bridge or the UI bundle, apart from code Vite emits for the bundle.

## Embedded matterjs-server dashboard

Admin step 2 shows the dashboard of `@matter-server/dashboard` (Apache-2.0) inside the admin UI. The bridge does not copy or modify its files: it proxies requests to the local matter-server under `/matter/` and, at runtime, inserts one script tag into the dashboard index page:

```html
<script>window.__MATTERJS_PRODUCTION_MODE__=true</script>
```

This makes the dashboard connect to the proxied WebSocket (`/matter/ws`). The proxy also filters some WebSocket messages (door lock commands, see `docs/en/admin.md`). The dashboard source and license are in `node_modules/@matter-server/dashboard/`.
