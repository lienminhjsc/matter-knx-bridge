# Thêm thiết bị Matter (commissioning)

[English](../en/commissioning.md) | Tiếng Việt

Bridge không tự commission thiết bị. matterjs-server là Matter controller: nó tham gia vào từng thiết bị với vai trò quản trị bổ sung (multi-admin) và giữ thông tin xác thực fabric trong thư mục storage. Sau đó bridge làm việc với thiết bị thông qua matter-server.

Cách thông dụng là giữ thiết bị trong hệ sinh thái đang dùng (Apple Home, Google Home...) và chia sẻ nó cho matter-server bằng mã ghép nối. Cách này không cần Bluetooth hay thông tin mạng Thread, vì thiết bị đã ở sẵn trên mạng.

## Trước khi bắt đầu

- matter-server và bridge đang chạy ([setup.md](setup.md)).
- Với thiết bị Thread, máy chủ có route IPv6 tới mạng Thread ([setup.md](setup.md), mục 4).
- Ghi lại cho mỗi thiết bị: hãng và model, Wi-Fi hay Thread, phòng, và số hệ sinh thái đang điều khiển nó.

### Giới hạn fabric

Mỗi hệ sinh thái điều khiển một thiết bị Matter chiếm một fabric trên thiết bị đó. Đa số thiết bị hỗ trợ 5 fabric. Khi đã dùng hết (hiển thị 5/5), commission sẽ thất bại cho tới khi gỡ thiết bị khỏi một hệ. Admin hiện số fabric của từng node ở bước 3 và đánh dấu node hết fabric ở bước 2.

Giữ danh sách các thiết bị đã chia sẻ cho matter-server. Danh sách này cần khi gỡ fabric sau này (ví dụ khi chuyển sang máy khác).

## 1. Lấy mã ghép nối

Mã chỉ có hiệu lực trong thời gian ngắn (thường vài phút), nên tạo mã ngay trước bước 2. Tên menu tuỳ phiên bản và ngôn ngữ của ứng dụng.

**Apple Home**: mở phụ kiện, vào cài đặt, chọn **Bật chế độ ghép nối** (Turn On Pairing Mode). Ứng dụng hiện mã setup 11 số. Mã 8 số là mã HomeKit, không phải mã Matter, sẽ không dùng được.

**Google Home**: mở cài đặt thiết bị, **Ứng dụng và dịch vụ Matter được liên kết** (Linked Matter apps & services), **Liên kết ứng dụng và dịch vụ** (Link apps & services). Ứng dụng hiện mã ghép nối. Cần kiểm chứng với bridge này.

**Hệ sinh thái khác**: tìm mục "chia sẻ thiết bị", "multi-admin" hoặc "chế độ ghép nối" trong cài đặt thiết bị.

**Thiết bị mới, chưa ở hệ nào**: dashboard matter-server có thể commission bằng mã QR qua Bluetooth nếu máy chủ có Bluetooth, nhưng chưa thử với bridge. Cách đã thử là commission vào Apple Home trước rồi chia sẻ (Google Home: cần kiểm chứng).

## 2. Commission trên dashboard

1. Mở admin (`http://<ip-bridge>:2401`), bước 2 **Matter**. Dashboard matterjs-server được nhúng bên dưới dải tóm tắt, chỉ có tiếng Anh. **Mở tab riêng** để xem toàn màn hình.
2. Trên dashboard, chọn **Commission node**, chọn cách dùng mã setup, dán mã vào.
3. Chờ node hiện ra cùng endpoint và cluster. Thiết bị Thread có thể lâu hơn thiết bị Wi-Fi.

Cần thấy gì theo loại thiết bị:

| Thiết bị | Cluster trên endpoint |
|---|---|
| Đèn, công tắc, ổ cắm | OnOff (6); LevelControl (8) nếu dim được; ColorControl (768) nếu chỉnh màu hoặc nhiệt độ màu |
| Điều hoà, thermostat | Thermostat (513); FanControl (514) trên cùng endpoint hoặc endpoint khác; cảm biến độ ẩm tuỳ thiết bị |
| Cảm biến hiện diện / chuyển động | OccupancySensing (1030), có thể kèm IlluminanceMeasurement (1024) |
| Tiếp điểm cửa / cửa sổ | BooleanState (69) |
| Khoá cửa | DoorLock (257), PowerSource cho pin |

Dashboard còn có sơ đồ mạng Thread, giúp đánh giá chất lượng mesh quanh một thiết bị.

Công tắc nhiều kênh là một node có nhiều endpoint. Mỗi endpoint thành một mạch riêng trong bridge.

## 3. Nhận diện và gán

Bước 3 **Gán thiết bị** trong admin liệt kê mọi endpoint. Danh sách node tự làm mới mỗi 10 giây, nên node vừa commission sẽ hiện ra mà không cần tải lại trang.

- **Identify** gửi lệnh Matter Identify (cluster 3) tới endpoint trong 10 giây. Thiết bị nháy đèn, kêu bíp hoặc báo hiệu theo cách riêng của model. Dùng để biết thiết bị vật lý nào ứng với dòng nào trước khi đặt tên.
- Admin gợi ý loại mạch theo cluster (ví dụ đèn dim khi có LevelControl). Có thể đổi.
- Chọn phòng và sửa tên mạch tự sinh.

Chi tiết: [admin.md](admin.md).

Khoá cửa không gán ở bước 3. Thêm bằng tay vào `locks` trong `config.json` ([knx.md](knx.md#khoá-cửa)).

## Gỡ thiết bị

Để trả lại slot fabric mà matter-server đang dùng:

1. Gỡ mạch khỏi dự án trong admin (bước 3), lập lại group address và áp dụng.
2. Xoá node trên dashboard matter-server. Dashboard sẽ thử gỡ fabric của nó khỏi thiết bị.
3. Kiểm tra trong hệ sinh thái gốc (ví dụ mục dịch vụ kết nối của phụ kiện trong Apple Home) rằng fabric của matter-server đã mất. Nếu chưa, gỡ ở đó.

## Xử lý sự cố

| Hiện tượng | Kiểm tra |
|---|---|
| Báo mã không hợp lệ | Mã Matter 11 số, không phải mã HomeKit 8 số; mã chưa hết hạn; tạo mã mới |
| Commission lỗi vì hết fabric | Thiết bị đã 5/5 fabric. Gỡ một hệ khỏi thiết bị |
| Không tìm thấy thiết bị Thread hoặc hết thời gian chờ | Route IPv6 tới prefix Thread trên máy chủ, border router online, thiết bị nằm trên mạng Thread của border router đó |
| Thiết bị hiện hai lần, discovery chập chờn | Máy chủ có hai interface mạng đang bật. Tắt một cái |
| Node online trên dashboard nhưng offline trong admin | Bridge chưa kết nối tới matter-server (thanh trạng thái báo mất kết nối Matter) |
