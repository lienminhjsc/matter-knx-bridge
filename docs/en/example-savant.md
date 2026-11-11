# Example client: Savant Generic KNX

English | [Tiếng Việt](../vi/example-savant.md)

This page shows how a KNX client is set up against the bridge, using the Generic KNX component of a Savant system as the reference. Any KNX client that supports KNXnet/IP tunnelling is configured the same way: point it at the bridge as an IP interface and enter group addresses with the values from the admin handover table.

Savant is a trademark of its owner. This project is not affiliated with or endorsed by Savant.

**Status: the end-to-end path Savant Generic KNX to bridge to Matter device is to be verified.** The values below come from the bridge code (what the bridge sends and accepts). Each Savant-specific step is marked as verified or to verify.

| Item | Status |
|---|---|
| Generic KNX gateway connects to the bridge (search, connect, heartbeat) | To verify |
| Light switch and feedback | To verify |
| HVAC setpoint and mode | To verify |
| Fan stage actions and states | To verify |
| Savant reads feedback group addresses at start (`GroupValue_Read`) | To verify |
| DPT 5.100 available in the Savant DPT list | To verify |
| Import of the bridge's ETS XML into the Savant configuration | To verify |

## 1. Gateway

In the Savant configuration tool (Blueprint), add a **Generic KNX** component and set:

- Ethernet IP address: the bridge IP (`knx.host_ip`, for example `192.168.1.50`)
- Port: 3671

Each Generic KNX component holds one tunnel on the bridge. Keep `knx.max_tunnels` high enough for all clients (default 8). A Savant system can use several KNX IP interfaces at the same time, so the bridge can be added next to an existing KNX interface. Use group addresses on the bridge that do not overlap with those of the real KNX installation ([knx.md](knx.md#limitations)).

## 2. Light: switch and feedback

Group addresses from the admin handover table (step 6), for example:

| Function | Group address | DPT | Values |
|---|---|---|---|
| Switch (command) | `1/1/1` | 1.001 | 1 On, 0 Off |
| Switch status (feedback) | `1/1/2` | 1.001 | 1 On, 0 Off |
| Dimming value (command) | `1/1/3` | 5.001 | 0-100 % |
| Dimming status (feedback) | `1/1/4` | 5.001 | 0-100 %, 0 while off |

In the Savant KNX settings, create a lighting entry of type switch (or dimmer) with the command address and the status address.

## 3. HVAC: setpoint and mode

| Function | DPT | Values |
|---|---|---|
| On/off (command, feedback) | 1.001 | 1 On (Cool, or Heat on heat-only units), 0 Off. Feedback 1 when mode is not Off |
| Setpoint (command, feedback) | 9.001 | °C. The bridge accepts 5 to 40, rounds to 0.5 °C, clamps to the unit's limits |
| Room temperature (feedback) | 9.001 | °C |
| Mode (command, feedback) | 20.105 | 0 Auto, 1 Heat, 3 Cool, 6 Off, 9 Fan only, 14 Dry |

Auto is only accepted if the unit supports it. Other 20.105 values are ignored by the bridge.

## 4. Fan: device actions and states

The air conditioner fan uses DPT 5.100 (fan stage) by default, one byte with the stage as value. In Savant, set up a Fan device on the fan group addresses:

| Savant action | Value sent to the fan command GA |
|---|---|
| `FANSPEED0` | 0 (Off) |
| `FANSPEED1` | 1 (Low) |
| `FANSPEED2` | 2 (Medium) |
| `FANSPEED3` | 3 (High) |

| Savant state | Condition on the fan feedback GA |
|---|---|
| `FANISOFF` | is equal to 0 |
| `FANISLOW` | is equal to 1 |
| `FANISMID` | is equal to 2 |
| `FANISHIGH` | is equal to 3 |

DPT: 5.100. If 5.100 is not in the Savant DPT list, choose 5.010: it has the same one-byte unsigned encoding, so the bits on the bus are identical.

When the unit runs in Auto fan mode, the feedback GA reports the speed actually running (1 to 3, or 0). There is no Auto stage on this GA.

Only the bridge should send on the fan feedback GA. Do not bind status objects of other devices to it.

Avoid the percent format (DPT 5.001) for Savant fan states: "is equal to" comparisons on percent values are fragile because of rounding. Use it only if you must match existing KNX devices that work in percent ([knx.md](knx.md#fan-stage-or-percent)).

## 5. Check

1. Upload the configuration to the Savant host.
2. On the bridge, `LOG_LEVEL=debug npm start` and watch for the tunnel connection (`tunnel N connected from ...`) and for lines like `1/1/1 -> light.1.on = true`.
3. Switch the device from the Savant app, then switch it from its original ecosystem (for example Apple Home). The Savant state must follow in both cases, because feedback comes from the device.
