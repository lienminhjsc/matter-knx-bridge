# Field test: <name>

<!-- Copy this file to docs/field-tests/<site>-<nn>.md. Do not publish IP addresses, pairing codes, serial numbers or customer data (see README.md in this folder). Write "to be filled" for anything not known yet; do not guess. -->

| | |
|---|---|
| Test ID | <site>-<nn> |
| Site type / Loại công trình | office / apartment / villa / hotel room / lab |
| Maintainer / Người phụ trách | KNXStore.vn team |
| Period / Thời gian | YYYY-MM-DD to YYYY-MM-DD (planned N days) |
| Status / Trạng thái | Not started / Running / Paused / Closed |
| Last updated / Cập nhật lần cuối | YYYY-MM-DD |

## 1. Summary / Tóm tắt

<!-- Fill when the test is closed. 3 to 5 sentences: what ran, for how long, what worked, what failed, what changes in the README status table. -->

To be filled when the test is closed.

## 2. Environment / Môi trường

### 2.1 Bridge host

| Item | Value |
|---|---|
| Hardware | e.g. Raspberry Pi 5 8 GB / Mac mini M2 |
| OS and version | |
| Node.js | `node -v` |
| matter-knx-bridge | tag or commit (`git rev-parse --short HEAD`) |
| matter-server | version from `package-lock.json` |
| How it runs | systemd / launchd / manual |
| `LOG_LEVEL` | debug (required for command counts) |
| Other software on the host | e.g. another bridge sharing matter-server |

### 2.2 Network

| Item | Value |
|---|---|
| Topology | e.g. one flat LAN, KNX clients and bridge in the same VLAN |
| Bridge connection | Ethernet / Wi-Fi |
| Thread border router(s) | model, firmware, count |
| Wi-Fi access point(s) for Matter Wi-Fi devices | model |
| IPv6 on the LAN | yes / no / partial |
| Remote access | none / VPN (never port forwarding) |

### 2.3 KNX side

| KNX client | Software and version | Connection | Tunnels used | Notes |
|---|---|---|---|---|
| e.g. ETS | ETS 6.x | KNXnet/IP tunnelling | 1 | group monitor, latency samples |
| e.g. Savant | host model, Blueprint and OS version | Generic KNX | 1 | |

Physical KNX installation on site: none / yes (describe the IP interface or router, the bridge does not connect to TP itself).

### 2.4 Matter ecosystems

| Ecosystem | Controller and version | Role |
|---|---|---|
| Apple Home | e.g. HomePod mini, iOS / tvOS version | original ecosystem, multi-admin source |
| Google Home | | |

## 3. Devices / Thiết bị

<!-- One row per Matter device. "Node" is the matter-server node id, which is not personal data. Fabrics = used / max, from the matter-server dashboard. -->

| # | Brand and model | Firmware | Matter device type | Network | Node | Shared from | Fabrics | Bridge slot | Channels bound | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | | | | Wi-Fi / Thread | | Apple Home / Google Home / direct | x / 5 | `light.1` | `on`, `level` | Active |

Devices on site that are not bridged, and why (for example unsupported device type):

| Brand and model | Matter device type | Reason |
|---|---|---|
| | | |

## 4. Test plan / Kế hoạch test

<!-- Result: Pass / Fail / Partial / Not tested. Keep IDs stable so weekly updates can refer to them. Rows T01 to T10 match the README status table. -->

| ID | Test | Method | Expected | Result | Date | Notes |
|---|---|---|---|---|---|---|
| T01 | KNX on/off and feedback, Thread switch | Write the command GA from the KNX client 20 times | Device switches every time, feedback GA follows | Not tested | | |
| T02 | KNX control of air conditioner: on, mode, setpoint, fan | Each function 10 times from the KNX client | Device follows, feedback GA follows | Not tested | | |
| T03 | Discovery in ETS | ETS, Interfaces, search | Bridge listed as KNXnet/IP interface | Not tested | | |
| T04 | Savant Generic KNX end-to-end | Control from the Savant app | Device follows, Savant state follows | Not tested | | |
| T05 | ETS import of exported GA files (XML, CSV) | Import into ETS 5 / 6 | Import without errors, names and DPTs kept | Not tested | | |
| T06 | Admin import of real ETS GA exports | Import a real project export | Addresses reserved, no collisions | Not tested | | |
| T07 | Door lock: lock, unlock from admin with PIN, jammed | Only with explicit approval for each unlock | Lock state correct, unlock logged in audit | Not tested | | |
| T08 | Embedded dashboard in Safari and mobile browsers | Open admin step 2 | Dashboard loads, Thread graph shown | Not tested | | |
| T09 | Dimmers, colour temperature, sensors | Per device | Values and feedback correct | Not tested | | |
| T10 | Google Home multi-admin code | Share a device from Google Home | Device commissioned into matter-server | Not tested | | |
| T11 | Feedback when the device is used from its own app or by hand | Switch from Apple Home and at the device | Feedback GA follows within a few seconds | Not tested | | |
| T12 | Recovery after matter-server restart | Restart matter-server | Bridge reconnects, states refreshed, no manual action | Not tested | | |
| T13 | Recovery after host reboot | Reboot the host | Bridge and matter-server start by themselves | Not tested | | |
| T14 | Recovery after power loss of a device | Cut power, restore | Device comes back, `error` channel clears | Not tested | | |
| T15 | Several KNX clients at once | 2 or more tunnels open | Feedback reaches every tunnel | Not tested | | |

## 5. Weekly metrics / Số liệu theo tuần

<!-- Commands to get these numbers: README.md in this folder, section "Collecting the numbers from the log". Latency is measured by hand, 20 samples per device type. -->

| Week | Dates | Bridge starts | Planned restarts | matter-server lost | Commands | Timeouts | Timeout rate | Latency median / max (ms) | Errors | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | | | |
| 2 | | | | | | | | | | |
| 3 | | | | | | | | | | |
| 4 | | | | | | | | | | |

Timeout rate = timeouts / commands. Unplanned bridge starts = bridge starts minus planned restarts.

## 6. Incidents / Sự cố

<!-- Every unexpected behaviour, even if it fixed itself. Link a GitHub issue when one is opened. -->

| Date | Symptom | Devices / channels | Cause | Fix or workaround | Issue |
|---|---|---|---|---|---|
| | | | | | |

## 7. Changes during the test / Thay đổi trong quá trình test

<!-- Version upgrades, config changes, devices added or removed, planned restarts, network changes. -->

| Date | Change | Reason |
|---|---|---|
| | | |

## 8. Conclusion / Kết luận

<!-- Fill when the test is closed. -->

| README status row | Before | Proposed | Evidence (test IDs, weeks) |
|---|---|---|---|
| | To be verified | Verified / still to be verified | |

Open problems and follow-up issues:

- To be filled.
