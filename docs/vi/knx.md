# Phía KNX

[English](../en/knx.md) | Tiếng Việt

Bridge là một **KNXnet/IP tunnelling server**. Với KNX client, bridge giống một IP interface có một line KNX ảo nhỏ phía sau, trên đó thiết bị Matter xuất hiện dưới dạng group object. Không có bus KNX vật lý.

- `GroupValue_Write` từ client tới group address lệnh trở thành lệnh trên một channel của bridge (ví dụ `light.1.on = true`).
- Khi channel đổi vì thiết bị báo giá trị mới, bridge gửi `GroupValue_Write` lên mọi group address phản hồi gắn với channel đó, tới mọi tunnel đang kết nối.
- `GroupValue_Read` trên group address phản hồi được trả lời bằng `GroupValue_Response` từ giá trị hiện tại của channel.

Tên channel và kiểu giá trị: [channels.md](channels.md).

## Cấu hình: `knx`

| Khoá | Mặc định | Ý nghĩa |
|---|---|---|
| `enabled` | `true` | Bật KNXnet/IP server |
| `host_ip` | IPv4 không phải loopback đầu tiên | Địa chỉ LAN của máy chủ. Trả về trong câu trả lời search và connect; nhóm multicast 224.0.23.12 được join trên địa chỉ này. Nên ghi rõ |
| `port` | `3671` | Cổng UDP |
| `friendly_name` | `"Matter Bridge"` | Tên client hiển thị trong danh sách interface |
| `individual_address` | `15.15.250` | Individual address của chính interface (địa chỉ nguồn của telegram bridge gửi) |
| `tunnel_address` | `15.15.240` | Địa chỉ của tunnel đầu tiên. Các tunnel sau tăng dần trong cùng line, không vượt `.255` |
| `max_tunnels` | `8` | Số tunnel đồng thời, 1 đến 32. Mỗi kết nối client chiếm một tunnel |
| `objects` | `[]` | Danh sách gắn group address, xem bên dưới |

Chọn `individual_address` và `tunnel_address` không trùng với địa chỉ trong project ETS nếu client đồng thời kết nối tới một hệ KNX thật.

## Gắn group address: `knx.objects`

Mỗi mục gắn một group address với một channel theo một chiều:

```json
{ "ga": "1/1/1", "dpt": "1.001", "bind": "light.1.on", "dir": "cmd", "name": "Living room ceiling switch" }
```

| Trường | Bắt buộc | Ý nghĩa |
|---|---|---|
| `ga` | có | Group address 3 cấp `main/middle/sub` |
| `dpt` | có | `1.xxx`, `5.001`, `5.xxx`, `7.xxx`, `9.xxx` hoặc `20.105` |
| `bind` | có | Channel, ví dụ `light.1.on`, `hvac.2.setpoint` |
| `dir` | có | `cmd`: giá trị KNX ghi vào được gửi tới channel. `fb`: trạng thái channel được gửi lên GA và dùng để trả lời lệnh đọc |
| `transform` | không | `invert`, `fan_level` hoặc `hvac_mode`, xem bên dưới |
| `fan_steps` | không | Đi kèm `fan_level`: phần trăm cho Low, Medium, High, tăng dần, 1 đến 100. Mặc định `[33, 67, 100]` |
| `name` | không | Hiện trong log |

Các quy tắc kiểm tra khi nạp cấu hình (bridge không khởi động, hoặc admin không áp dụng, và báo danh sách lỗi):

- `cmd` chỉ dùng cho channel nhận lệnh, `fb` chỉ dùng cho channel có phản hồi ([channels.md](channels.md)).
- Channel boolean cần DPT 1.x. Channel số không dùng được 1.x hay 20.x. Channel chuỗi không gắn được, trừ `hvac.N.mode` với DPT 20.105 và `transform: "hvac_mode"`.
- `lock.N.unlock` với `dir: "cmd"` chỉ được chấp nhận khi `locks.N.unlock_enabled` là `true`.

Nhiều mục `cmd` có thể dùng chung một group address: một telegram điều khiển nhiều channel, giống một nhóm KNX có nhiều actuator. Với `fb`, dùng một group address cho mỗi channel; nếu nhiều mục `fb` chung một GA, lệnh đọc được trả lời theo mục đầu tiên.

Admin tự ghi `knx.objects` (bước 5, Áp dụng). Bước này thay object của các thiết bị do dự án quản lý và giữ object viết tay của thiết bị khác (ví dụ khoá cửa, slot cấu hình bằng tay), trừ khi group address của chúng đã được plan dùng.

## Kiểu dữ liệu (DPT)

| DPT | Kích thước | Cách bridge mã hoá | Dùng cho |
|---|---|---|---|
| 1.xxx | 1 bit | 0 / 1. Lệnh nhận `true/false`, `1/0`, `on/off` | 1.001 công tắc, 1.007 bước, 1.018 hiện diện, 1.019 cửa / cửa sổ, 1.005 báo động |
| 5.001 | 1 byte | 0-100 % quy về 0-255. Khi giải mã làm tròn tới phần trăm nguyên | Giá trị dim, mức nhiệt độ màu, pin, phần trăm quạt |
| 5.xxx (khác 5.001) | 1 byte | Giá trị thô 0-255, không quy đổi | 5.100 cấp quạt, 5.010 bộ đếm |
| 7.xxx | 2 byte không dấu | Giá trị thô 0-65535 | 7.600 nhiệt độ màu Kelvin, 7.013 lux |
| 9.xxx | 2 byte float | KNX float, lệnh làm tròn tới 0,1 | 9.001 nhiệt độ, 9.004 lux, 9.007 độ ẩm |
| 20.105 | 1 byte enum | Với `transform: "hvac_mode"`, xem bảng bên dưới | Chế độ bộ điều khiển HVAC |

Chưa hỗ trợ: DPT 3.007 (dim tương đối), 14.x (float 4 byte), 16.x (chuỗi), 232.600 (RGB) và các loại khác. Telegram không giải mã được sẽ ghi log và bỏ qua.

## Bảng giá trị theo channel

Các DPT dưới đây là lựa chọn khuyến nghị. DPT khác cùng họ được mã hoá giống hệt (bridge chỉ xét họ DPT), miễn là KNX client hiểu giá trị đúng ý.

### Đèn (`light.N.*`)

| Channel | DPT | cmd | fb | Giá trị |
|---|---|---|---|---|
| `on` | 1.001 | có | có | 1 bật, 0 tắt |
| `level` | 5.001 | có | có | 0-100 %. Lệnh 0 là tắt, > 0 là bật ở mức đó. Phản hồi 0 khi đang tắt |
| `ct` | 7.600 | có | có | Kelvin, giới hạn trong dải của đèn |
| `ct_level` | 5.001 | có | có | 0 % ấm nhất, 100 % lạnh nhất |
| `hue`, `saturation` | 5.001 | có | có | 0-100 % |

### HVAC (`hvac.N.*`)

| Channel | DPT | cmd | fb | Giá trị |
|---|---|---|---|---|
| `on` | 1.001 | có | có | Lệnh 1: mode Cool (Heat với thiết bị chỉ sưởi), 0: mode Off. Phản hồi 1 khi mode khác Off |
| `setpoint` | 9.001 | có | có | °C. Lệnh trong khoảng 5 đến 40, làm tròn 0,5 °C, giới hạn theo thiết bị. Setpoint đang dùng: setpoint sưởi ở mode Heat, setpoint làm lạnh trong các trường hợp còn lại |
| `setpoint_step` | 1.007 | có | không | 1 = +1 °C, 0 = -1 °C |
| `temperature` | 9.001 | không | có | Nhiệt độ phòng, °C |
| `humidity` | 9.007 | không | có | % RH, nếu node có cảm biến độ ẩm |
| `setpoint_min`, `setpoint_max` | 9.001 | không | có | Giới hạn setpoint của thiết bị |
| `mode` | 20.105 + `hvac_mode` | có | có | Xem bảng mode |
| `fan` | 5.100 (mặc định) | có | có | 0 Off, 1 Low, 2 Medium, 3 High. Ở Auto, phản hồi là tốc độ đang chạy |
| `fan` | 5.001 + `fan_level` | có | có | Phần trăm, xem mục quạt |
| `fan_percent` | 5.001 | không | có | Tốc độ quạt hiện tại, % |

Mode HVAC, DPT 20.105 (HVACContrMode) với `transform: "hvac_mode"`:

| Giá trị KNX | Ý nghĩa | Matter SystemMode |
|---|---|---|
| 0 | Auto | Auto (chỉ khi thiết bị hỗ trợ) |
| 1 | Heat | Heat |
| 3 | Cool | Cool |
| 6 | Off | Off |
| 9 | Fan only | FanOnly |
| 14 | Dry (hút ẩm) | Dry |

Giá trị 20.105 khác bị bỏ qua và ghi cảnh báo trong log. Ở phản hồi, EmergencyHeat của Matter được báo là 1 (Heat) và Precooling là 3 (Cool). Mode thiết bị không hỗ trợ sẽ ghi vào `hvac.N.error`.

### Cảm biến (`sensor.N.*`, chỉ phản hồi)

| Channel | DPT | Giá trị |
|---|---|---|
| `occupancy` | 1.018 | 1 có người, 0 không có người |
| `contact` | 1.019 + `invert` | 1 mở, 0 đóng (bản thân channel là `true` = đóng, nên cần `invert`) |
| `temperature` | 9.001 | °C, độ phân giải 0,1 |
| `humidity` | 9.007 | % RH |
| `lux` | 9.004 (hoặc 7.013) | lux |
| `battery` | 5.001 | 0-100 % |

### Khoá cửa (`lock.N.*`)

| Channel | DPT | cmd | fb | Giá trị |
|---|---|---|---|---|
| `lock` | 1.001 | có | không | 1 = khoá. Giá trị 0 bị bỏ qua |
| `unlock` | 1.001 | có | không | 1 = mở khoá, chỉ khi `unlock_enabled: true`. Giá trị 0 bị bỏ qua |
| `locked` | 1.001 | không | có | 1 đang khoá, 0 các trạng thái khác |
| `jammed` | 1.005 hoặc 1.001 | không | có | 1 sau báo động LockJammed, về 0 khi khoá báo Locked hoặc Unlocked |
| `battery` | 5.001 | không | có | 0-100 % |

`lock.N.state` (Locked, Unlocked, NotFullyLocked...) là channel chuỗi, không gắn được vào KNX. Dùng `locked`.

### Channel chung

`online` (1.x, fb), `pending` (1.x, fb: 1 trong lúc lệnh chờ xác nhận) và `refresh` (1.x, cmd: đọc lại thiết bị) có ở các loại thiết bị như liệt kê trong [channels.md](channels.md). `system.controller_online` (1.x, fb) báo kết nối tới matter-server; `system.refresh` (1.x, cmd) đọc lại mọi node đã cấu hình.

## Biến đổi giá trị (transform)

| Transform | Áp dụng cho | Tác dụng |
|---|---|---|
| `invert` | DPT 1.x | Đảo giá trị theo cả hai chiều. Dùng cho `sensor.N.contact` trên DPT 1.019, nơi KNX 0 = đóng |
| `hvac_mode` | `hvac.N.mode` trên DPT 20.105 | Quy đổi tên mode sang giá trị 20.105 theo bảng trên. Bắt buộc với `hvac.N.mode` |
| `fan_level` | `hvac.N.fan` trên DPT 5.001 | Quy đổi giữa cấp 0-3 và phần trăm theo `fan_steps` |

### Quạt: theo cấp hay theo phần trăm

Mặc định cho quạt điều hoà là **DPT 5.100 (fan stage)**, không transform: giá trị KNX chính là cấp quạt, 0 Off, 1 Low, 2 Medium, 3 High. Client so sánh giá trị chính xác (ví dụ "state bằng 2") hoạt động ổn định với kiểu này. Nếu client không có 5.100 trong danh sách, DPT 5.010 có cùng cách mã hoá 1 byte không dấu.

Chỉ dùng **DPT 5.001 kèm `fan_level`** khi phải khớp thiết bị KNX có sẵn đang làm việc theo phần trăm:

- Chiều gửi (phản hồi): cấp 1, 2, 3 được gửi là `fan_steps[0]`, `[1]`, `[2]` phần trăm (mặc định 33, 67, 100). Cấp 0 là 0 %.
- Chiều nhận (lệnh): các mốc là cận trên. 0 % = Off, tới `fan_steps[0]` = Low, tới `fan_steps[1]` = Medium, lớn hơn = High. Với giá trị mặc định, 67 % quy về Medium.

Khi điều hoà ở chế độ quạt Auto, `hvac.N.fan` báo tốc độ đang chạy thật, lấy từ FanControl PercentCurrent (0 Off, tới 33 % Low, tới 67 % Medium, lớn hơn là High). Channel này không có cấp Auto; dùng `hvac.N.fan_mode` từ front end khác nếu cần Auto.

## Tunnel

- Mỗi kết nối KNX client (visualisation, bộ điều khiển, ETS) chiếm một tunnel. Tối đa `max_tunnels` cùng lúc.
- Địa chỉ tunnel được cấp từ `tunnel_address` tăng dần trong cùng line.
- Chỉ nhận kết nối tunnel ở link layer (`TUNNEL_LINKLAYER`) qua UDP. Không hỗ trợ chế độ bus monitor, raw, KNXnet/IP qua TCP và KNX IP Secure.
- Heartbeat: tunnel không có gói nào trong 120 s sẽ bị đóng. Khi đã đủ tunnel, kết nối mới lấy slot của tunnel im lặng lâu nhất, nếu tunnel đó đã im lặng quá 65 s (client biến mất mà không ngắt kết nối).
- Mọi telegram bridge gửi đều phải được client ACK; không có ACK thì gửi lại một lần sau 1 s, sau đó đóng tunnel.
- Telegram nhóm do một client ghi cũng được chuyển tới mọi tunnel khác, như trên bus thật. Hai client cùng nối vào bridge thấy lệnh của nhau.
- Telegram gửi tới individual address được xác nhận nhưng bỏ qua. Device management chỉ trả lời vài property mà client thường hỏi khi kết nối.

## Kết nối ETS

ETS có thể dùng bridge làm interface để xem và ghi telegram nhóm (Group Monitor). Không nạp chương trình thiết bị được: phía sau bridge không có thiết bị KNX nào.

1. Trong ETS, mở phần thiết lập kết nối (Bus, Connections, Interfaces).
2. Nếu ETS chạy cùng subnet, bridge xuất hiện trong danh sách interface tìm thấy với tên `friendly_name`. Đã kiểm chứng.
3. Nếu không tìm thấy, thêm interface mới: kiểu KNXnet/IP, IP của bridge (`knx.host_ip`), cổng 3671, UDP tunnelling.
4. Chọn interface đó và mở Group Monitor. Với `LOG_LEVEL=debug`, log bridge hiện kết nối tunnel và từng telegram.

Ghi giá trị từ Group Monitor của ETS và đọc phản hồi: cần kiểm chứng.

Import group address do admin xuất (bước 6, ETS XML) vào project ETS: cần kiểm chứng. Xem [admin.md](admin.md#bước-6-bàn-giao).

## Bố trí group address

Admin lập group address cho bạn từ tầng, phòng và mạch (bước 4). Bạn cũng có thể viết `knx.objects` bằng tay theo bất kỳ cách bố trí nào.

Planner tích hợp (scheme `builtin-v1`, mã nguồn `src/admin/planner/builtin.ts`) dùng địa chỉ 3 cấp `main/middle/sub`:

| Cấp | Ý nghĩa |
|---|---|
| Main | Hệ thống: 0 trung tâm (dành riêng, không bao giờ sinh), 1 chiếu sáng, 2 rèm (dành riêng, chưa sinh địa chỉ), 3 HVAC, 4 cảm biến và an ninh. Main 5 đến 31 để trống cho công trình |
| Middle | Tầng. Tầng trong nhà, sắp theo thứ tự rồi theo mã, lấy 1, 2, 3... Tầng ngoài trời lấy 7, 6, 5... từ trên xuống, nên thêm tầng trong nhà không làm dịch chúng. Middle 0 dành cho chức năng trung tâm. Tối đa 7 tầng (lỗi `floor_limit`) |
| Sub | Khối của phòng. Phòng thứ k trên một tầng (đếm từ 0, sắp theo thứ tự rồi theo mã) sở hữu sub `1 + 20k` tới `20 + 20k` trong mọi main: 12 phòng mỗi tầng dùng sub 1 tới 240, sub 241 tới 255 để trống. Phòng thứ 13 báo lỗi `room_limit` |

Trong một khối phòng, mạch được sắp theo tên rồi theo id, object của từng mạch theo thứ tự của template bên dưới. Địa chỉ import từ ETS (dành riêng) được bỏ qua. Khi khối đầy, các object còn lại không có địa chỉ (cảnh báo `block_full`, lỗi `ga_unassigned`) cho tới khi bạn đặt tay hoặc chuyển bớt mạch.

Độ ổn định: thêm mạch hoặc thêm phòng không làm dịch địa chỉ của phòng khác. Chèn một phòng vào giữa thứ tự phòng sẽ làm dịch các phòng phía sau. Sau khi xuất ETS, địa chỉ bị khoá và mọi thay đổi đều được báo ([admin.md](admin.md#bước-6-bàn-giao)).

Tên group address có dạng `LT - GF.LIV.L01 - SW` (tiền tố hệ thống, tên mạch, object). Object theo loại mạch:

| Loại mạch | Main | Object (DPT) |
|---|---|---|
| `lt.onoff` đèn bật/tắt | 1 | `SW`, `FB` (1.001) |
| `lt.dim` đèn dimmer | 1 | `SW`, `FB` (1.001), `VAL`, `VALFB` (5.001) |
| `lt.cct` đèn CCT | 1 | như `lt.dim`, thêm `CCT`, `CCT_FB` (7.600) |
| `hvac.unit` điều hoà | 3 | `ONOFF`, `ONOFF_FB` (1.001), `SETP`, `SETP_FB`, `TEMP` (9.001), `MODE`, `MODE_FB` (20.105), `FAN`, `FAN_FB` (5.100, hoặc 5.001 ở kiểu phần trăm) |
| `pres.sensor` cảm biến hiện diện | 4 | `OCC` (1.018), `LUX` (9.004) |
| `sec.contact` tiếp điểm cửa | 4 | `CONTACT` (1.019) |

Không sinh group address trung tâm, scene hay nhóm phòng. Loại rèm (`sht.*`) và đèn RGB chưa được cấp địa chỉ.

Ghi đè thủ công và import ETS xem ở [admin.md](admin.md#bước-4-group-address). Có thể thay scheme địa chỉ khác bằng `admin.planner_module` ([admin.md](admin.md#planner-tuỳ-chỉnh)).

## Khoá cửa

Khoá cửa không do planner của admin quản lý. Thêm bằng tay vào `config.json`:

```json
"locks": {
  "1": { "node_id": 6, "endpoint": 1, "name": "Front door", "unlock_enabled": false }
}
```

và các object cần dùng, ví dụ:

```json
{ "ga": "6/1/1", "dpt": "1.001", "bind": "lock.1.lock", "dir": "cmd", "name": "Front door lock" },
{ "ga": "6/1/2", "dpt": "1.001", "bind": "lock.1.locked", "dir": "fb", "name": "Front door locked status" },
{ "ga": "6/1/3", "dpt": "1.001", "bind": "lock.1.jammed", "dir": "fb", "name": "Front door jammed" }
```

Sửa `config.json` bằng tay xong thì khởi động lại bridge. Bước áp dụng của admin giữ các object khoá này, miễn là plan không dùng trùng group address.

`unlock_enabled: true` cho phép mọi client trong LAN mở cửa qua `lock.N.unlock` mà không cần PIN, vì KNXnet/IP không có xác thực. Chỉ bật sau khi đã đánh giá rủi ro này tại công trình.

## Giới hạn

- **Không phải KNX router.** Không có KNXnet/IP routing (giao tiếp nhóm qua multicast), không kết nối bus twisted pair (TP). Bridge không kết nối làm client tới một IP interface hay router có sẵn.
- **Chưa dùng chung group address với thiết bị TP.** Công tắc tường hay thermostat trên bus KNX thật không thấy group address của bridge. Chỉ client nối vào tunnel của chính bridge mới thấy. Client nối đồng thời vào bridge và vào một KNX interface thật nên dùng group address không chồng nhau.
- Không có KNX IP Secure, không có KNXnet/IP qua TCP.
- Chưa có dim tương đối (DPT 3.007), rèm, object màu RGB, scene hay chức năng trung tâm. Planner tích hợp không sinh địa chỉ cho các loại này.
- Mỗi channel một giá trị phản hồi. Bridge không lưu giá trị client ghi vào group address phản hồi.
