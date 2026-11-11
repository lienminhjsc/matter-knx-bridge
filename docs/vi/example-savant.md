# Ví dụ client: Savant Generic KNX

[English](../en/example-savant.md) | Tiếng Việt

Trang này minh hoạ cách cấu hình một KNX client làm việc với bridge, lấy component Generic KNX của hệ Savant làm ví dụ. Mọi KNX client hỗ trợ KNXnet/IP tunnelling đều cấu hình tương tự: trỏ client tới bridge như một IP interface và nhập group address cùng giá trị theo bảng bàn giao của admin.

Savant là nhãn hiệu của chủ sở hữu. Dự án này không liên kết và không được Savant bảo trợ.

**Trạng thái: luồng trọn vẹn Savant Generic KNX tới bridge tới thiết bị Matter cần kiểm chứng.** Các giá trị dưới đây lấy từ mã nguồn bridge (những gì bridge gửi và nhận). Mỗi bước riêng của Savant được đánh dấu đã kiểm chứng hay cần kiểm chứng.

| Hạng mục | Trạng thái |
|---|---|
| Gateway Generic KNX kết nối tới bridge (search, connect, heartbeat) | Cần kiểm chứng |
| Công tắc đèn và phản hồi | Cần kiểm chứng |
| Setpoint và mode HVAC | Cần kiểm chứng |
| Action và state cấp quạt | Cần kiểm chứng |
| Savant đọc group address phản hồi khi khởi động (`GroupValue_Read`) | Cần kiểm chứng |
| DPT 5.100 có trong danh sách DPT của Savant | Cần kiểm chứng |
| Import file ETS XML của bridge vào cấu hình Savant | Cần kiểm chứng |

## 1. Gateway

Trong công cụ cấu hình Savant (Blueprint), thêm component **Generic KNX** và đặt:

- Ethernet IP address: IP của bridge (`knx.host_ip`, ví dụ `192.168.1.50`)
- Port: 3671

Mỗi component Generic KNX chiếm một tunnel trên bridge. Đặt `knx.max_tunnels` đủ cho mọi client (mặc định 8). Một hệ Savant dùng được nhiều KNX IP interface cùng lúc, nên có thể thêm bridge bên cạnh KNX interface sẵn có. Dùng group address trên bridge không chồng với group address của hệ KNX thật ([knx.md](knx.md#giới-hạn)).

## 2. Đèn: công tắc và phản hồi

Group address lấy từ bảng bàn giao của admin (bước 6), ví dụ:

| Chức năng | Group address | DPT | Giá trị |
|---|---|---|---|
| Công tắc (lệnh) | `1/1/1` | 1.001 | 1 Bật, 0 Tắt |
| Trạng thái công tắc (phản hồi) | `1/1/2` | 1.001 | 1 Bật, 0 Tắt |
| Giá trị dim (lệnh) | `1/1/3` | 5.001 | 0-100 % |
| Trạng thái dim (phản hồi) | `1/1/4` | 5.001 | 0-100 %, 0 khi đang tắt |

Trong phần KNX settings của Savant, tạo một mục lighting kiểu switch (hoặc dimmer) với địa chỉ lệnh và địa chỉ trạng thái.

## 3. HVAC: setpoint và mode

| Chức năng | DPT | Giá trị |
|---|---|---|
| Bật/tắt (lệnh, phản hồi) | 1.001 | 1 Bật (Cool, hoặc Heat với máy chỉ sưởi), 0 Tắt. Phản hồi 1 khi mode khác Off |
| Setpoint (lệnh, phản hồi) | 9.001 | °C. Bridge nhận 5 đến 40, làm tròn 0,5 °C, giới hạn theo máy |
| Nhiệt độ phòng (phản hồi) | 9.001 | °C |
| Mode (lệnh, phản hồi) | 20.105 | 0 Auto, 1 Heat, 3 Cool, 6 Off, 9 Fan only, 14 Dry |

Auto chỉ được nhận nếu máy hỗ trợ. Các giá trị 20.105 khác bị bridge bỏ qua.

## 4. Quạt: device action và state

Quạt điều hoà mặc định dùng DPT 5.100 (fan stage), một byte có giá trị là cấp quạt. Trong Savant, tạo thiết bị Fan trên các group address của quạt:

| Action của Savant | Giá trị gửi lên GA lệnh quạt |
|---|---|
| `FANSPEED0` | 0 (Off) |
| `FANSPEED1` | 1 (Low) |
| `FANSPEED2` | 2 (Medium) |
| `FANSPEED3` | 3 (High) |

| State của Savant | Điều kiện trên GA phản hồi quạt |
|---|---|
| `FANISOFF` | is equal to 0 |
| `FANISLOW` | is equal to 1 |
| `FANISMID` | is equal to 2 |
| `FANISHIGH` | is equal to 3 |

DPT: 5.100. Nếu danh sách DPT của Savant không có 5.100, chọn 5.010: cùng cách mã hoá một byte không dấu, nên các bit trên bus giống hệt nhau.

Khi máy chạy ở chế độ quạt Auto, GA phản hồi báo tốc độ đang chạy thật (1 đến 3, hoặc 0). GA này không có cấp Auto.

Chỉ bridge được gửi lên GA phản hồi quạt. Không gắn status object của thiết bị khác vào GA này.

Tránh kiểu phần trăm (DPT 5.001) cho state quạt của Savant: phép so sánh "is equal to" trên giá trị phần trăm dễ trượt do làm tròn. Chỉ dùng khi bắt buộc phải khớp thiết bị KNX có sẵn làm việc theo phần trăm ([knx.md](knx.md#quạt-theo-cấp-hay-theo-phần-trăm)).

## 5. Kiểm tra

1. Upload cấu hình lên Savant host.
2. Trên bridge, chạy `LOG_LEVEL=debug npm start` và xem dòng kết nối tunnel (`tunnel N connected from ...`) cùng các dòng như `1/1/1 -> light.1.on = true`.
3. Bật tắt thiết bị từ app Savant, rồi bật tắt từ hệ sinh thái gốc (ví dụ Apple Home). Trạng thái trên Savant phải đổi theo trong cả hai trường hợp, vì phản hồi đến từ thiết bị.
