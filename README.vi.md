# matter-knx-bridge

[English](README.md) | Tiếng Việt

matter-knx-bridge cho phép điều khiển thiết bị Matter (Wi-Fi và Thread) từ bất kỳ hệ KNX nào. Bridge chạy cạnh một [matterjs-server](https://github.com/matter-js/matterjs-server) cục bộ và xuất hiện trên LAN như một **KNXnet/IP tunnelling interface**. KNX client (visualisation, bộ điều khiển nhà thông minh, group monitor của ETS) kết nối vào như với mọi IP interface khác, đọc và ghi group address; bridge chuyển các lệnh đó thành lệnh Matter và đẩy trạng thái thiết bị về dưới dạng telegram nhóm.

Thiết bị đang có trong Apple Home hoặc Google Home được thêm vào qua Matter multi-admin bằng mã ghép nối 11 số, nên vẫn giữ nguyên trong hệ sinh thái ban đầu.

Phiên bản 0.1.0. Đây là dự án DIY: đọc [tuyên bố miễn trừ](#tuyên-bố-miễn-trừ) trước khi dùng, nhất là với khoá cửa.

## Tính năng

- KNXnet/IP tunnelling server trên UDP 3671: tìm thấy qua multicast search, nhiều tunnel cùng lúc (mặc định 8), phản hồi được đẩy tới mọi tunnel khi thay đổi, trả lời `GroupValue_Read` từ trạng thái hiện tại.
- Channel có kiểu dữ liệu giữa KNX và Matter, ví dụ `light.1.on`, `light.1.level`, `hvac.1.setpoint`, `hvac.1.mode`, `hvac.1.fan`, `sensor.1.occupancy`, `lock.1.locked`. Danh sách đầy đủ: [docs/vi/channels.md](docs/vi/channels.md).
- Nhóm DPT hỗ trợ: 1.x, 5.001, 5.x (1 byte, ví dụ 5.010, 5.100), 7.x, 9.x, 20.105. Biến đổi giá trị cho tiếp điểm cửa (`invert`), chế độ HVAC (`hvac_mode`, DPT 20.105) và tốc độ quạt theo phần trăm (`fan_level`).
- Trạng thái phản hồi chỉ lấy từ giá trị thiết bị báo về, không suy ra từ lệnh đã gửi. Lệnh không được xác nhận đúng hạn sẽ ghi vào channel `error` của thiết bị.
- Ứng dụng web quản trị (admin) ở cổng 2401 (đăng nhập user `admin`), song ngữ Việt / Anh, dẫn kỹ sư commissioning qua 6 bước: dự án, Matter, gán thiết bị, group address, áp dụng, bàn giao. Có planner group address tích hợp, ghi đè thủ công, import địa chỉ ETS có sẵn làm địa chỉ dành riêng và xuất ETS; planner có thể thay thế.
- Dashboard của matterjs-server (sơ đồ Thread, commissioning) được nhúng sau lớp đăng nhập admin. Proxy chặn lệnh mở khoá cửa gửi từ dashboard.
- Khoá cửa: mở khoá qua KNX tắt mặc định cho từng khoá (`unlock_enabled`). Mở khoá từ admin cần PIN 6 số riêng, có khoá tạm khi nhập sai và nhật ký.
- Thay đổi cấu hình từ admin được nạp vào bridge đang chạy, không cần khởi động lại.

## Kiến trúc

```
 KNX client                      matter-knx-bridge (Node 22)                  matterjs-server          Thiết bị
 (visualisation,     UDP 3671   +----------------------------+  WebSocket   +----------------+
  bộ điều khiển,  <-----------> | KNXnet/IP tunnelling server|  127.0.0.1   | Matter         |  Wi-Fi   Thiết bị
  ETS monitor)                  |   group address <-> channel| <----------> | controller     | <------> Matter
                                |                            |    :5580     | (dữ liệu       |  Thread  (qua border
 Trình duyệt      HTTP 2401     | Lõi bridge (channel,       |              |  fabric)       |          router)
 (kỹ sư)      <---------------> |   pending, chặn unlock)    |              | dashboard      |
                                | Admin + proxy dashboard    |              +----------------+
                                |   (/matter/)               |
                                +----------------------------+
```

Chi tiết: [docs/vi/architecture.md](docs/vi/architecture.md).

## Trạng thái

Một dòng chỉ chuyển sang "Đã kiểm chứng" khi có report thử nghiệm thực tế đã chốt làm căn cứ, xem [docs/field-tests](docs/field-tests/README.md).

| Hạng mục | Trạng thái |
|---|---|
| Công tắc on/off Thread (multi-admin từ Apple Home) | Phía Matter đã kiểm chứng trên thiết bị thật, qua một front end không phải KNX trước đây của cùng lõi bridge; đọc phản hồi qua KNX tunnel đã kiểm chứng; lệnh qua KNX cần kiểm chứng |
| Bộ điều khiển điều hoà Wi-Fi: mode, setpoint, quạt | Phía Matter đã kiểm chứng trên thiết bị thật, qua một front end không phải KNX trước đây của cùng lõi bridge; đọc phản hồi qua KNX tunnel đã kiểm chứng; lệnh qua KNX cần kiểm chứng |
| ETS tìm thấy bridge là KNXnet/IP interface | Đã kiểm chứng |
| Savant Generic KNX chạy trọn luồng qua bridge | Cần kiểm chứng |
| ETS 5 / 6 import file group address xuất ra (XML, CSV) | Cần kiểm chứng |
| Admin import file xuất group address thật từ ETS 5 / 6 | Cần kiểm chứng |
| Khoá cửa thật (khoá, mở từ admin, sự kiện kẹt khoá) | Cần kiểm chứng |
| Dashboard nhúng trên Safari và trình duyệt di động | Cần kiểm chứng (đã chạy với Chrome trên máy tính) |
| Dimmer, nhiệt độ màu, cảm biến trên thiết bị thật | Cần kiểm chứng (đã có mock test) |
| Mã ghép nối multi-admin từ Google Home | Cần kiểm chứng |
| Triển khai trên Raspberry Pi 5 | Cần kiểm chứng (phát triển và thử trên macOS) |

## Yêu cầu

- Node.js 22 (>= 22.18, < 23). Bridge chạy thẳng mã nguồn TypeScript, phần server không có bước build.
- Máy chạy bridge nằm cùng LAN (cùng L2 / VLAN) với KNX client và thiết bị Matter. Đã thử trên macOS; mục tiêu triển khai là Raspberry Pi 5.
- Với thiết bị Thread: có Thread border router trên LAN đó (ví dụ HomePod mini, Apple TV 4K hoặc Google Nest hub) và máy chạy bridge có route IPv6 tới mạng Thread.
- Mỗi thiết bị cần còn một slot fabric Matter trống (thường tối đa 5).

## Bắt đầu nhanh

```sh
git clone https://github.com/tungvu9x/matter-knx-bridge.git
cd matter-knx-bridge
npm ci
npm run build:admin
cp config.example.json config.json   # sau đó sửa knx.host_ip và xoá các thiết bị mẫu

# Terminal 1: Matter controller, WebSocket ở 127.0.0.1:5580
npm run matter-server -- --storage-path ./data/matter --listen-address 127.0.0.1

# Terminal 2: bridge
npm start
```

Lần chạy đầu, bridge tự sinh mật khẩu admin, ghi vào `config.json` và in ra log đúng một lần. Mở `http://<ip-bridge>:2401`, đăng nhập bằng `admin` và làm theo 6 bước. Hướng dẫn đầy đủ: [docs/vi/setup.md](docs/vi/setup.md), [docs/vi/commissioning.md](docs/vi/commissioning.md), [docs/vi/admin.md](docs/vi/admin.md).

## Tổng quan cấu hình

`config.json` (không commit, mẫu: [`config.example.json`](config.example.json)):

| Khoá | Ý nghĩa |
|---|---|
| `matter_server` | URL WebSocket của matter-server, mặc định `ws://127.0.0.1:5580/ws` |
| `pending_timeout_ms`, `command_timeout_ms` | Thời gian chờ thiết bị xác nhận (mặc định 10000) và timeout mỗi request (mặc định 15000) |
| `lights`, `thermostats`, `sensors`, `locks` | Slot thiết bị: `{ "1": { "node_id": 5, "endpoint": 1, "name": "..." } }`. Khoá có thêm `unlock_enabled` (mặc định `false`) |
| `knx` | KNXnet/IP server: `host_ip`, `friendly_name`, `individual_address`, `tunnel_address`, `max_tunnels`, `objects` (gắn group address) |
| `admin` | Admin: `host`, `port` (2401), `password`, `project_path`, `unlock_pin_hash`, `audit_path`, `planner_module` |

Khi áp dụng một plan, admin tự ghi `lights`, `thermostats`, `sensors` và `knx.objects`. Khoá cửa cấu hình bằng tay. Chi tiết: [docs/vi/knx.md](docs/vi/knx.md).

## Tài liệu

| Chủ đề | English | Tiếng Việt |
|---|---|---|
| Cài đặt (macOS, Raspberry Pi 5, systemd) | [setup](docs/en/setup.md) | [setup](docs/vi/setup.md) |
| Thêm thiết bị Matter (multi-admin) | [commissioning](docs/en/commissioning.md) | [commissioning](docs/vi/commissioning.md) |
| Phía KNX: tunnelling, ETS, DPT | [knx](docs/en/knx.md) | [knx](docs/vi/knx.md) |
| Admin, bàn giao, khoá cửa | [admin](docs/en/admin.md) | [admin](docs/vi/admin.md) |
| Tra cứu channel | [channels](docs/en/channels.md) | [channels](docs/vi/channels.md) |
| Ví dụ client: Savant Generic KNX | [example-savant](docs/en/example-savant.md) | [example-savant](docs/vi/example-savant.md) |
| Kiến trúc | [architecture](docs/en/architecture.md) | [architecture](docs/vi/architecture.md) |

## Lưu ý bảo mật

- Chỉ chạy bridge trong LAN tin cậy. KNXnet/IP tunnelling không có xác thực: ai tới được UDP 3671 đều bật tắt được thiết bị đã gắn. Không bao giờ mở cổng 3671, 2401 hay 5580 ra Internet.
- Giữ matter-server chỉ nghe trên `127.0.0.1`. Proxy của admin lọc lệnh khoá cửa, còn kết nối thẳng vào cổng 5580 thì không.
- Admin dùng HTTP Basic auth cộng cookie phiên trên HTTP thường. Chỉ dùng trong mạng nội bộ hoặc qua VPN / TLS terminator của bạn.
- `config.json`, `project.json`, `unlock-audit.log` và thư mục storage của matter-server chứa bí mật và dữ liệu fabric. Không commit, không chia sẻ.

Xem [SECURITY.md](SECURITY.md) về mô hình đe doạ và cách báo lỗ hổng.

## Tuyên bố miễn trừ

Đây là dự án DIY, phát hành nguyên trạng, không bảo hành (xem license). Dự án không được tổ chức tiêu chuẩn nào chứng nhận và chưa được thử cho ứng dụng an toàn hay an ninh sinh mạng. Bạn tự chịu rủi ro khi sử dụng. Đặc biệt cẩn thận với khoá cửa: một lỗi cấu hình hoặc lỗi phần mềm có thể làm mở cửa. Giữ `unlock_enabled` ở trạng thái tắt cho tới khi đã kiểm chứng tại công trình.

matter-knx-bridge giao tiếp với thiết bị Matter qua matterjs-server và với hệ KNX qua KNXnet/IP tunnelling chuẩn. Dự án không liên kết, không được bảo trợ hay chứng nhận bởi Connectivity Standards Alliance, KNX Association, Open Home Foundation hay Savant. Matter, KNX và Savant là nhãn hiệu của chủ sở hữu tương ứng, chỉ được nhắc tới để mô tả khả năng tương thích. Dự án không dùng logo của các tổ chức này.

## Đóng góp

Xem [CONTRIBUTING.md](CONTRIBUTING.md) và [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Báo cáo thiết bị (chạy được gì với thiết bị nào) gửi qua issue template.

## License

Apache License 2.0, xem [LICENSE](LICENSE) và [NOTICE](NOTICE). Thành phần bên thứ ba: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
