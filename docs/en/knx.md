# KNX side

English | [Tiếng Việt](../vi/knx.md)

The bridge is a **KNXnet/IP tunnelling server**. To a KNX client it looks like an IP interface with a small virtual KNX line behind it, on which the Matter devices appear as group objects. There is no physical KNX bus.

- A `GroupValue_Write` from a client to a command group address becomes a command on a bridge channel (for example `light.1.on = true`).
- When a channel changes because the device reported a new value, the bridge sends `GroupValue_Write` on every feedback group address bound to it, to every connected tunnel.
- A `GroupValue_Read` on a feedback group address is answered with `GroupValue_Response` from the current channel value.

Channel names and value types: [channels.md](channels.md).

## Configuration: `knx`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Start the KNXnet/IP server |
| `host_ip` | first non-loopback IPv4 | LAN address of the host. Returned in search and connect answers; the multicast group 224.0.23.12 is joined on it. Set it explicitly |
| `port` | `3671` | UDP port |
| `friendly_name` | `"Matter Bridge"` | Name shown by clients in the interface list |
| `individual_address` | `15.15.250` | Individual address of the interface itself (source of telegrams the bridge sends) |
| `tunnel_address` | `15.15.240` | Address of the first tunnel. Further tunnels count up within the same line, never past `.255` |
| `max_tunnels` | `8` | Concurrent tunnels, 1 to 32. Each client connection uses one |
| `objects` | `[]` | Group address bindings, see below |

Pick `individual_address` and `tunnel_address` so that they do not collide with addresses used in your ETS project if the client also connects to a real KNX installation.

## Group address bindings: `knx.objects`

Each entry binds one group address to one channel in one direction:

```json
{ "ga": "1/1/1", "dpt": "1.001", "bind": "light.1.on", "dir": "cmd", "name": "Living room ceiling switch" }
```

| Field | Required | Meaning |
|---|---|---|
| `ga` | yes | Group address, 3-level `main/middle/sub` |
| `dpt` | yes | `1.xxx`, `5.001`, `5.xxx`, `7.xxx`, `9.xxx` or `20.105` |
| `bind` | yes | Channel, for example `light.1.on`, `hvac.2.setpoint` |
| `dir` | yes | `cmd`: writes from KNX are sent to the channel. `fb`: channel state is sent to the GA and answers reads |
| `transform` | no | `invert`, `fan_level` or `hvac_mode`, see below |
| `fan_steps` | no | With `fan_level`: percent for Low, Medium, High, ascending, 1 to 100. Default `[33, 67, 100]` |
| `name` | no | Shown in logs |

Rules checked when the config is loaded (the bridge refuses to start, or the admin refuses to apply, with a list of errors):

- `cmd` only on channels that accept commands, `fb` only on channels with feedback ([channels.md](channels.md)).
- Boolean channels need DPT 1.x. Numeric channels cannot use 1.x or 20.x. Text channels cannot be bound, except `hvac.N.mode` with DPT 20.105 and `transform: "hvac_mode"`.
- `lock.N.unlock` with `dir: "cmd"` is only accepted when `locks.N.unlock_enabled` is `true`.

Several `cmd` entries may use the same group address: one telegram then drives several channels, like a KNX group with several actuators. For `fb`, use one group address per channel; if several `fb` entries share a GA, reads are answered from the first one.

The admin app writes `knx.objects` for you (step 5, Apply). It replaces the objects of devices managed by the project and keeps hand-written objects of other devices (for example door locks or slots configured by hand), unless their group address is now used by the plan.

## Data point types

| DPT | Size | Encoding in the bridge | Typical use |
|---|---|---|---|
| 1.xxx | 1 bit | 0 / 1. Commands accept `true/false`, `1/0`, `on/off` | 1.001 switch, 1.007 step, 1.018 occupancy, 1.019 window/door, 1.005 alarm |
| 5.001 | 1 byte | 0-100 % scaled to 0-255. Decoded and rounded to whole percent | Dimming value, colour temperature level, battery, fan percent |
| 5.xxx (other than 5.001) | 1 byte | Raw value 0-255, no scaling | 5.100 fan stage, 5.010 counter |
| 7.xxx | 2 bytes unsigned | Raw value 0-65535 | 7.600 colour temperature in Kelvin, 7.013 lux |
| 9.xxx | 2 byte float | KNX float, commands rounded to 0.1 | 9.001 temperature, 9.004 lux, 9.007 humidity |
| 20.105 | 1 byte enum | With `transform: "hvac_mode"`, see the table below | HVAC controller mode |

Not supported: DPT 3.007 (relative dimming), 14.x (4 byte float), 16.x (text), 232.600 (RGB) and others. Telegrams that cannot be decoded are logged and ignored.

## Value tables per channel

The DPTs below are the recommended ones. Another DPT of the same family encodes the same way (only the family matters to the bridge), as long as the KNX client interprets it as intended.

### Lights (`light.N.*`)

| Channel | DPT | cmd | fb | Values |
|---|---|---|---|---|
| `on` | 1.001 | yes | yes | 1 on, 0 off |
| `level` | 5.001 | yes | yes | 0-100 %. Command 0 switches off, > 0 switches on at that level. Feedback 0 while off |
| `ct` | 7.600 | yes | yes | Kelvin, clamped to the range of the light |
| `ct_level` | 5.001 | yes | yes | 0 % warmest, 100 % coolest |
| `hue`, `saturation` | 5.001 | yes | yes | 0-100 % |

### HVAC (`hvac.N.*`)

| Channel | DPT | cmd | fb | Values |
|---|---|---|---|---|
| `on` | 1.001 | yes | yes | Command 1: mode Cool (Heat on heat-only units), 0: mode Off. Feedback 1 when mode is not Off |
| `setpoint` | 9.001 | yes | yes | °C. Commands 5 to 40, rounded to 0.5 °C, clamped to the device limits. Active setpoint: heating setpoint in Heat mode, cooling setpoint otherwise |
| `setpoint_step` | 1.007 | yes | no | 1 = +1 °C, 0 = -1 °C |
| `temperature` | 9.001 | no | yes | Room temperature, °C |
| `humidity` | 9.007 | no | yes | % RH, if the node has a humidity sensor |
| `setpoint_min`, `setpoint_max` | 9.001 | no | yes | Setpoint limits of the device |
| `mode` | 20.105 + `hvac_mode` | yes | yes | See mode table |
| `fan` | 5.100 (default) | yes | yes | 0 Off, 1 Low, 2 Medium, 3 High. In Auto, feedback shows the running speed |
| `fan` | 5.001 + `fan_level` | yes | yes | Percent, see fan section |
| `fan_percent` | 5.001 | no | yes | Current fan speed in % |

HVAC mode, DPT 20.105 (HVACContrMode) with `transform: "hvac_mode"`:

| KNX value | Meaning | Matter SystemMode |
|---|---|---|
| 0 | Auto | Auto (only if the device supports it) |
| 1 | Heat | Heat |
| 3 | Cool | Cool |
| 6 | Off | Off |
| 9 | Fan only | FanOnly |
| 14 | Dry (dehumidification) | Dry |

Other 20.105 values are ignored with a log warning. In feedback, Matter EmergencyHeat is reported as 1 (Heat) and Precooling as 3 (Cool). A mode the device does not support sets `hvac.N.error`.

### Sensors (`sensor.N.*`, feedback only)

| Channel | DPT | Values |
|---|---|---|
| `occupancy` | 1.018 | 1 occupied, 0 not occupied |
| `contact` | 1.019 + `invert` | 1 open, 0 closed (the channel itself is `true` = closed, hence `invert`) |
| `temperature` | 9.001 | °C, 0.1 resolution |
| `humidity` | 9.007 | % RH |
| `lux` | 9.004 (or 7.013) | lux |
| `battery` | 5.001 | 0-100 % |

### Door locks (`lock.N.*`)

| Channel | DPT | cmd | fb | Values |
|---|---|---|---|---|
| `lock` | 1.001 | yes | no | 1 = lock. 0 is ignored |
| `unlock` | 1.001 | yes | no | 1 = unlock, only with `unlock_enabled: true`. 0 is ignored |
| `locked` | 1.001 | no | yes | 1 locked, 0 anything else |
| `jammed` | 1.005 or 1.001 | no | yes | 1 after a LockJammed alarm, back to 0 when the lock reports Locked or Unlocked |
| `battery` | 5.001 | no | yes | 0-100 % |

`lock.N.state` (Locked, Unlocked, NotFullyLocked...) is a text channel and cannot be bound to KNX. Use `locked`.

### Common channels

`online` (1.x, fb), `pending` (1.x, fb: 1 while a command waits for confirmation) and `refresh` (1.x, cmd: re-read the device) exist for every device kind where listed in [channels.md](channels.md). `system.controller_online` (1.x, fb) reports the connection to matter-server; `system.refresh` (1.x, cmd) re-reads every configured node.

## Transforms

| Transform | Applies to | Effect |
|---|---|---|
| `invert` | DPT 1.x | Negates the value in both directions. Used for `sensor.N.contact` on DPT 1.019, where KNX 0 = closed |
| `hvac_mode` | `hvac.N.mode` on DPT 20.105 | Maps the mode names to the 20.105 values in the table above. Required for `hvac.N.mode` |
| `fan_level` | `hvac.N.fan` on DPT 5.001 | Converts between stage 0-3 and percent using `fan_steps` |

### Fan: stage or percent

The default for an air conditioner fan is **DPT 5.100 (fan stage)** without transform: the KNX value is the stage, 0 Off, 1 Low, 2 Medium, 3 High. Clients that compare exact values (for example "state is equal to 2") work reliably with it. If a client does not list 5.100, DPT 5.010 has the same 1-byte unsigned encoding.

Use **DPT 5.001 with `fan_level`** only to match existing KNX devices that work in percent:

- Sending (feedback): stage 1, 2, 3 is sent as `fan_steps[0]`, `[1]`, `[2]` percent (default 33, 67, 100). Stage 0 is 0 %.
- Receiving (command): the steps are upper bounds. 0 % = Off, up to `fan_steps[0]` = Low, up to `fan_steps[1]` = Medium, above = High. With the defaults, 67 % maps back to Medium.

When the unit is in Auto fan mode, `hvac.N.fan` reports the speed actually running, derived from FanControl PercentCurrent (0 Off, up to 33 % Low, up to 67 % Medium, above High). There is no Auto stage in this channel; use `hvac.N.fan_mode` from other front ends for Auto.

## Tunnels

- Each KNX client connection (visualisation, controller, ETS) takes one tunnel. Up to `max_tunnels` at a time.
- Tunnel addresses are assigned from `tunnel_address` upwards within the same line.
- Only tunnel connections on the link layer (`TUNNEL_LINKLAYER`) over UDP are accepted. Bus monitor mode, raw mode, KNXnet/IP over TCP and KNX IP Secure are not supported.
- Heartbeat: a tunnel without any packet for 120 s is closed. When all tunnels are in use, a new connection takes over the slot of the tunnel that has been silent the longest, if it has been silent for more than 65 s (a client that disappeared without disconnecting).
- Every telegram the bridge sends is acknowledged by the client; without acknowledgement it is sent once more after 1 s, then the tunnel is closed.
- A group telegram written by one client is also forwarded to all other tunnels, as on a real bus. Two clients connected to the bridge see each other's writes.
- Telegrams to individual addresses are confirmed but ignored. Device management is answered only for the few properties clients ask for during connection.

## Connecting ETS

ETS can use the bridge as an interface to watch and write group telegrams (Group Monitor). Programming devices is not possible: there are no devices behind the bridge.

1. In ETS, open the connection settings (Bus, Connections, Interfaces).
2. The bridge appears under discovered interfaces with its `friendly_name`, if ETS runs in the same subnet. Verified.
3. If it is not discovered, add a new interface: type KNXnet/IP, the bridge IP (`knx.host_ip`), port 3671, UDP tunnelling.
4. Select it and open the Group Monitor. With `LOG_LEVEL=debug`, the bridge log shows the tunnel connection and every telegram.

Writing values from the ETS Group Monitor and reading feedback: to be verified.

Importing the group addresses exported by the admin (step 6, ETS XML) into an ETS project: to be verified. See [admin.md](admin.md#step-6-handover).

## Group address layout

The admin app plans group addresses for you from floors, rooms and circuits (step 4). You can also write `knx.objects` by hand with any layout.

The built-in planner (scheme `builtin-v1`, source `src/admin/planner/builtin.ts`) uses 3-level addresses `main/middle/sub`:

| Level | Meaning |
|---|---|
| Main | System: 0 central (reserved, never generated), 1 lighting, 2 shading (reserved, no addresses generated yet), 3 HVAC, 4 sensors and security. Mains 5 to 31 are left free for the site |
| Middle | Floor. Indoor floors, sorted by order then code, take 1, 2, 3... Outdoor floors take 7, 6, 5... from the top, so adding an indoor floor never moves them. Middle 0 is reserved for central functions. At most 7 floors (error `floor_limit`) |
| Sub | Room block. Room k on a floor (0-based, sorted by order then code) owns subs `1 + 20k` to `20 + 20k` in every main: 12 rooms per floor use subs 1 to 240, subs 241 to 255 stay free. A 13th room gives error `room_limit` |

Inside a room block, circuits are sorted by name, then id, and each circuit's objects follow the template order below. Addresses imported from ETS (reserved) are skipped. When a block is full, the remaining objects get no address (warning `block_full`, error `ga_unassigned`) until you set them by hand or move circuits.

Stability: adding a circuit or a room does not move the addresses of other rooms. Inserting a room in the middle of the room order shifts the rooms after it. Once exported to ETS, addresses are frozen and any change is reported ([admin.md](admin.md#step-6-handover)).

Group address names look like `LT - GF.LIV.L01 - SW` (system prefix, circuit name, object). Objects per circuit type:

| Circuit type | Main | Objects (DPT) |
|---|---|---|
| `lt.onoff` on/off light | 1 | `SW`, `FB` (1.001) |
| `lt.dim` dimmable light | 1 | `SW`, `FB` (1.001), `VAL`, `VALFB` (5.001) |
| `lt.cct` CCT light | 1 | as `lt.dim`, plus `CCT`, `CCT_FB` (7.600) |
| `hvac.unit` air conditioner | 3 | `ONOFF`, `ONOFF_FB` (1.001), `SETP`, `SETP_FB`, `TEMP` (9.001), `MODE`, `MODE_FB` (20.105), `FAN`, `FAN_FB` (5.100, or 5.001 in percent mode) |
| `pres.sensor` presence sensor | 4 | `OCC` (1.018), `LUX` (9.004) |
| `sec.contact` door contact | 4 | `CONTACT` (1.019) |

No central, scene or room group addresses are generated. Shading types (`sht.*`) and RGB lights get no addresses yet.

Manual overrides and ETS import are described in [admin.md](admin.md#step-4-group-address). A different address scheme can be plugged in with `admin.planner_module` ([admin.md](admin.md#custom-planner-module)).

## Door locks

Locks are not managed by the admin planner. Add them to `config.json` by hand:

```json
"locks": {
  "1": { "node_id": 6, "endpoint": 1, "name": "Front door", "unlock_enabled": false }
}
```

and the objects you need, for example:

```json
{ "ga": "6/1/1", "dpt": "1.001", "bind": "lock.1.lock", "dir": "cmd", "name": "Front door lock" },
{ "ga": "6/1/2", "dpt": "1.001", "bind": "lock.1.locked", "dir": "fb", "name": "Front door locked status" },
{ "ga": "6/1/3", "dpt": "1.001", "bind": "lock.1.jammed", "dir": "fb", "name": "Front door jammed" }
```

Restart the bridge after editing `config.json` by hand. The admin apply step keeps these lock objects, as long as the plan does not use the same group addresses.

`unlock_enabled: true` allows any client on the LAN to unlock the door through `lock.N.unlock` without a PIN, because KNXnet/IP has no authentication. Only enable it after you have assessed that risk on site.

## Limitations

- **Not a KNX router.** No KNXnet/IP routing (multicast group communication), no connection to a twisted pair (TP) bus. The bridge does not connect to an existing IP interface or router as a client.
- **Group addresses cannot be shared with TP devices yet.** A wall switch or thermostat on a real KNX bus does not see the bridge's group addresses. Only clients connected to the bridge's own tunnels do. A client connected both to the bridge and to a real KNX interface should use group addresses that do not overlap.
- No KNX IP Secure, no KNXnet/IP over TCP.
- No relative dimming (DPT 3.007), shutters or blinds, RGB colour objects, scenes or central functions yet. The built-in planner generates no addresses for these.
- One feedback value per channel. The bridge does not store values written by clients to feedback group addresses.
