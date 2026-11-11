# Channel reference

English | [Tiếng Việt](../vi/channels.md)

Channels are the neutral model between the bridge core and its front ends (KNX, admin). Source of truth: `src/channels.ts`.

- Name: `<kind>.<slot>.<property>`, for example `light.1.on`, or `system.<property>`.
- `kind` is `light`, `hvac`, `sensor` or `lock`. The slot is the key in the matching section of `config.json` (`lights`, `thermostats`, `sensors`, `locks`).
- Value types: `bool`, `number`, `string`.
- **cmd**: the channel accepts commands. **fb**: the channel publishes state.
- Feedback is only updated from values reported by the device, never inferred from a command. While a command waits for confirmation, `pending` is `true`. If the device does not confirm within `pending_timeout_ms`, `error` is set to `no confirmation from device`.
- Commands accept loose input: booleans from `true/false`, `1/0`, `"on"/"off"`; numbers from numbers or numeric strings (decimal comma accepted); mode names are case-insensitive.

Slot limits: lights 255, sensors 255, thermostats 64, locks 64.

For KNX bindings, only `bool` and `number` channels can be bound, plus `hvac.N.mode` through DPT 20.105. Recommended DPTs: [knx.md](knx.md#value-tables-per-channel).

## Common properties

| Property | Type | cmd | fb | Kinds | Description |
|---|---|---|---|---|---|
| `name` | string | | yes | all | Slot name from config, else the Matter NodeLabel |
| `online` | bool | | yes | all | Node reachable via matter-server |
| `error` | string | | yes | all | Last command error, empty when OK |
| `pending` | bool | | yes | light, lock, hvac | `true` while a command waits for device confirmation |
| `refresh` | bool | yes | | light, lock, hvac | Trigger: re-read the device attributes (any value) |

## Light: `light.N.*`

Config: `lights.N = { node_id, endpoint, name? }`. The endpoint needs OnOff (6); LevelControl (8) for dimming, ColorControl (768) for colour.

| Property | Type | cmd | fb | Description |
|---|---|---|---|---|
| `on` | bool | yes | yes | OnOff.OnOff |
| `level` | number | yes | yes | 0-100 %. Feedback 0 when off, >= 1 when on (LevelControl.CurrentLevel). Command 0 switches off; a light without LevelControl switches on for any value > 0 |
| `hue` | number | yes | yes | 0-100 % (ColorControl.CurrentHue) |
| `saturation` | number | yes | yes | 0-100 % (ColorControl.CurrentSaturation) |
| `ct` | number | yes | yes | Colour temperature in Kelvin (1000-20000 accepted), clamped to the light's range (ColorControl.ColorTemperatureMireds) |
| `ct_level` | number | yes | yes | Colour temperature 0-100 %, 0 = warmest, 100 = coolest |

## HVAC: `hvac.N.*`

Config: `thermostats.N = { node_id, endpoint, fan_endpoint?, name? }`. `endpoint` has the Thermostat cluster (513). `fan_endpoint` has FanControl (514); if omitted, all endpoints of the node are searched.

| Property | Type | cmd | fb | Description |
|---|---|---|---|---|
| `temperature` | number | | yes | °C (Thermostat.LocalTemperature) |
| `humidity` | number | | yes | % RH from any endpoint of the node |
| `setpoint` | number | yes | yes | °C, active setpoint: heating setpoint in Heat mode, else cooling. Commands 5-40, rounded to 0.5, clamped to device limits |
| `setpoint_min` | number | | yes | Lower setpoint limit, °C |
| `setpoint_max` | number | | yes | Upper setpoint limit, °C |
| `setpoint_step` | bool | yes | | `true` = +1 °C, `false` = -1 °C (like DPT 1.007) |
| `mode` | string | yes | yes | `Off`, `Heat`, `Cool`, `Auto`, `Dry`, `Fan` (Thermostat.SystemMode). A mode the device does not support sets `error` |
| `on` | bool | yes | yes | Feedback: mode is not Off. Command `true` = Cool (Heat on heat-only devices), `false` = Off |
| `action` | string | | yes | `Heating`, `Cooling`, `Fan`, `Dehumidifying`, `Idle` (Thermostat.ThermostatRunningState, else derived from mode) |
| `fan` | number | yes | yes | Fan stage 0 Off, 1 Low, 2 Medium, 3 High (FanControl.FanMode). In Auto, shows the running speed |
| `fan_mode` | string | yes | yes | `Off`, `Low`, `Medium`, `High`, `On`, `Auto` (FanControl.FanMode). Commands also accept `Med` |
| `fan_percent` | number | | yes | FanControl.PercentCurrent |

Matter Thermostat has no separate power attribute: "on" means a mode other than Off.

## Sensor: `sensor.N.*`

Config: `sensors.N = { node_id, endpoint?, name? }`. Without `endpoint`, each value is taken from any endpoint of the node that has the cluster.

| Property | Type | cmd | fb | Description |
|---|---|---|---|---|
| `occupancy` | bool | | yes | OccupancySensing.Occupancy bit 0 |
| `contact` | bool | | yes | BooleanState.StateValue, `true` = contact made = closed |
| `temperature` | number | | yes | °C, 0.1 resolution (TemperatureMeasurement) |
| `humidity` | number | | yes | % RH, integer (RelativeHumidityMeasurement) |
| `lux` | number | | yes | lux, integer (IlluminanceMeasurement) |
| `battery` | number | | yes | 0-100 % (PowerSource.BatPercentRemaining / 2) |

Sensors have no `pending` or `refresh`.

## Lock: `lock.N.*`

Config: `locks.N = { node_id, endpoint, name?, unlock_enabled? }`. The endpoint has DoorLock (257).

| Property | Type | cmd | fb | Description |
|---|---|---|---|---|
| `state` | string | | yes | `Locked`, `Unlocked`, `NotFullyLocked`, `Unlatched`, `Unknown` (DoorLock.LockState) |
| `locked` | bool | | yes | LockState == Locked |
| `jammed` | bool | | yes | Set by the DoorLockAlarm LockJammed event, cleared when the lock reports Locked or Unlocked |
| `battery` | number | | yes | 0-100 % (PowerSource.BatPercentRemaining / 2) |
| `lock` | bool | yes | | Trigger: `true` = lockDoor (`false` is ignored) |
| `unlock` | bool | yes | | Trigger: `true` = unlockDoor, rejected unless `unlock_enabled` is `true` for this lock (`false` is ignored) |

`lock` and `unlock` act only on `true`, so a 0 telegram never unlocks. Lock commands are Matter timed requests (10 s).

## System: `system.*`

| Property | Type | cmd | fb | Description |
|---|---|---|---|---|
| `version` | string | | yes | Bridge version |
| `error` | string | | yes | Last bridge level error (unknown channel, unknown slot...) |
| `controller_online` | bool | | yes | Connected to matter-server |
| `refresh` | bool | yes | | Trigger: re-read every configured node |

## Adding a channel

See [CONTRIBUTING.md](../../CONTRIBUTING.md#adding-a-device-type-or-channel).
