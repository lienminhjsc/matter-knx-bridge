# Tra cứu channel

[English](../en/channels.md) | Tiếng Việt

Channel là mô hình trung lập giữa lõi bridge và các front end (KNX, admin). Nguồn chuẩn: `src/channels.ts`.

- Tên: `<kind>.<slot>.<property>`, ví dụ `light.1.on`, hoặc `system.<property>`.
- `kind` là `light`, `hvac`, `sensor` hoặc `lock`. Slot là khoá trong mục tương ứng của `config.json` (`lights`, `thermostats`, `sensors`, `locks`).
- Kiểu giá trị: `bool`, `number`, `string`.
- **cmd**: channel nhận lệnh. **fb**: channel phát trạng thái.
- Trạng thái phản hồi chỉ cập nhật từ giá trị thiết bị báo về, không suy ra từ lệnh. Trong lúc lệnh chờ xác nhận, `pending` là `true`. Nếu thiết bị không xác nhận trong `pending_timeout_ms`, `error` được đặt thành `no confirmation from device`.
- Lệnh nhận đầu vào linh hoạt: boolean từ `true/false`, `1/0`, `"on"/"off"`; số từ số hoặc chuỗi số (chấp nhận dấu phẩy thập phân); tên mode không phân biệt hoa thường.

Giới hạn slot: đèn 255, cảm biến 255, thermostat 64, khoá 64.

Với KNX, chỉ gắn được channel `bool` và `number`, cộng thêm `hvac.N.mode` qua DPT 20.105. DPT khuyến nghị: [knx.md](knx.md#bảng-giá-trị-theo-channel).

## Thuộc tính chung

| Thuộc tính | Kiểu | cmd | fb | Loại | Mô tả |
|---|---|---|---|---|---|
| `name` | string | | có | tất cả | Tên slot trong config, nếu không có thì lấy Matter NodeLabel |
| `online` | bool | | có | tất cả | Node tới được qua matter-server |
| `error` | string | | có | tất cả | Lỗi lệnh gần nhất, rỗng khi bình thường |
| `pending` | bool | | có | light, lock, hvac | `true` trong lúc lệnh chờ thiết bị xác nhận |
| `refresh` | bool | có | | light, lock, hvac | Kích hoạt: đọc lại attribute của thiết bị (giá trị bất kỳ) |

## Đèn: `light.N.*`

Config: `lights.N = { node_id, endpoint, name? }`. Endpoint cần OnOff (6); LevelControl (8) để dim, ColorControl (768) để chỉnh màu.

| Thuộc tính | Kiểu | cmd | fb | Mô tả |
|---|---|---|---|---|
| `on` | bool | có | có | OnOff.OnOff |
| `level` | number | có | có | 0-100 %. Phản hồi 0 khi tắt, >= 1 khi bật (LevelControl.CurrentLevel). Lệnh 0 là tắt; đèn không có LevelControl sẽ bật với mọi giá trị > 0 |
| `hue` | number | có | có | 0-100 % (ColorControl.CurrentHue) |
| `saturation` | number | có | có | 0-100 % (ColorControl.CurrentSaturation) |
| `ct` | number | có | có | Nhiệt độ màu Kelvin (nhận 1000-20000), giới hạn trong dải của đèn (ColorControl.ColorTemperatureMireds) |
| `ct_level` | number | có | có | Nhiệt độ màu 0-100 %, 0 = ấm nhất, 100 = lạnh nhất |

## HVAC: `hvac.N.*`

Config: `thermostats.N = { node_id, endpoint, fan_endpoint?, name? }`. `endpoint` có cluster Thermostat (513). `fan_endpoint` có FanControl (514); bỏ trống thì tìm trên mọi endpoint của node.

| Thuộc tính | Kiểu | cmd | fb | Mô tả |
|---|---|---|---|---|
| `temperature` | number | | có | °C (Thermostat.LocalTemperature) |
| `humidity` | number | | có | % RH từ bất kỳ endpoint nào của node |
| `setpoint` | number | có | có | °C, setpoint đang dùng: setpoint sưởi ở mode Heat, còn lại là setpoint làm lạnh. Lệnh 5-40, làm tròn 0,5, giới hạn theo thiết bị |
| `setpoint_min` | number | | có | Giới hạn dưới của setpoint, °C |
| `setpoint_max` | number | | có | Giới hạn trên của setpoint, °C |
| `setpoint_step` | bool | có | | `true` = +1 °C, `false` = -1 °C (giống DPT 1.007) |
| `mode` | string | có | có | `Off`, `Heat`, `Cool`, `Auto`, `Dry`, `Fan` (Thermostat.SystemMode). Mode thiết bị không hỗ trợ sẽ ghi vào `error` |
| `on` | bool | có | có | Phản hồi: mode khác Off. Lệnh `true` = Cool (Heat với thiết bị chỉ sưởi), `false` = Off |
| `action` | string | | có | `Heating`, `Cooling`, `Fan`, `Dehumidifying`, `Idle` (Thermostat.ThermostatRunningState, nếu không có thì suy từ mode) |
| `fan` | number | có | có | Cấp quạt 0 Off, 1 Low, 2 Medium, 3 High (FanControl.FanMode). Ở Auto, hiện tốc độ đang chạy |
| `fan_mode` | string | có | có | `Off`, `Low`, `Medium`, `High`, `On`, `Auto` (FanControl.FanMode). Lệnh nhận thêm `Med` |
| `fan_percent` | number | | có | FanControl.PercentCurrent |

Matter Thermostat không có attribute nguồn riêng: "bật" nghĩa là mode khác Off.

## Cảm biến: `sensor.N.*`

Config: `sensors.N = { node_id, endpoint?, name? }`. Không ghi `endpoint` thì mỗi giá trị lấy từ endpoint bất kỳ của node có cluster tương ứng.

| Thuộc tính | Kiểu | cmd | fb | Mô tả |
|---|---|---|---|---|
| `occupancy` | bool | | có | OccupancySensing.Occupancy bit 0 |
| `contact` | bool | | có | BooleanState.StateValue, `true` = tiếp điểm đóng = cửa đóng |
| `temperature` | number | | có | °C, độ phân giải 0,1 (TemperatureMeasurement) |
| `humidity` | number | | có | % RH, số nguyên (RelativeHumidityMeasurement) |
| `lux` | number | | có | lux, số nguyên (IlluminanceMeasurement) |
| `battery` | number | | có | 0-100 % (PowerSource.BatPercentRemaining / 2) |

Cảm biến không có `pending` và `refresh`.

## Khoá cửa: `lock.N.*`

Config: `locks.N = { node_id, endpoint, name?, unlock_enabled? }`. Endpoint có DoorLock (257).

| Thuộc tính | Kiểu | cmd | fb | Mô tả |
|---|---|---|---|---|
| `state` | string | | có | `Locked`, `Unlocked`, `NotFullyLocked`, `Unlatched`, `Unknown` (DoorLock.LockState) |
| `locked` | bool | | có | LockState == Locked |
| `jammed` | bool | | có | Đặt bởi sự kiện DoorLockAlarm LockJammed, xoá khi khoá báo Locked hoặc Unlocked |
| `battery` | number | | có | 0-100 % (PowerSource.BatPercentRemaining / 2) |
| `lock` | bool | có | | Kích hoạt: `true` = lockDoor (`false` bị bỏ qua) |
| `unlock` | bool | có | | Kích hoạt: `true` = unlockDoor, bị từ chối nếu khoá này không có `unlock_enabled` là `true` (`false` bị bỏ qua) |

`lock` và `unlock` chỉ tác động khi nhận `true`, nên telegram 0 không bao giờ mở cửa. Lệnh khoá dùng Matter timed request (10 s).

## Hệ thống: `system.*`

| Thuộc tính | Kiểu | cmd | fb | Mô tả |
|---|---|---|---|---|
| `version` | string | | có | Phiên bản bridge |
| `error` | string | | có | Lỗi cấp bridge gần nhất (channel không tồn tại, slot không tồn tại...) |
| `controller_online` | bool | | có | Đã kết nối tới matter-server |
| `refresh` | bool | có | | Kích hoạt: đọc lại mọi node đã cấu hình |

## Thêm channel

Xem [CONTRIBUTING.md](../../CONTRIBUTING.md#adding-a-device-type-or-channel).
