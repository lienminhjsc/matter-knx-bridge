# Ứng dụng quản trị (admin)

[English](../en/admin.md) | Tiếng Việt

Admin chạy trong cùng tiến trình với bridge, ở cổng 2401. Admin dẫn kỹ sư commissioning từ một dự án trống tới hệ KNX chạy được qua 6 bước, kèm một trang riêng cho khoá cửa. Giao diện có tiếng Việt và tiếng Anh (chuyển ở đầu trang; trình duyệt nhớ lựa chọn, mặc định tiếng Việt). Dashboard matterjs-server nhúng bên trong chỉ có tiếng Anh.

Build giao diện một lần sau khi cài hoặc cập nhật: `npm run build:admin`.

## Cấu hình: `admin`

| Khoá | Mặc định | Ý nghĩa |
|---|---|---|
| `enabled` | `true` | Bật admin server |
| `host` | `"0.0.0.0"` | Địa chỉ nghe. Dùng địa chỉ LAN của máy để không nghe trên interface khác |
| `port` | `2401` | Cổng HTTP |
| `password` | tự sinh | Mật khẩu của user `admin`, tối thiểu 8 ký tự. Nếu thiếu, được sinh ở lần chạy đầu, lưu vào `config.json` và in ra log một lần |
| `project_path` | `"project.json"` | Dữ liệu dự án (tầng, phòng, gán thiết bị, bản chụp địa chỉ) |
| `unlock_pin_hash` | không đặt | Hash của PIN mở khoá 6 số, đặt bằng `npm run set-unlock-pin`. Không đặt: không mở khoá được từ admin |
| `audit_path` | `"unlock-audit.log"` | Nhật ký mở khoá, mỗi dòng một object JSON |
| `planner_module` | không đặt | Đường dẫn tới ES module chứa planner group address tuỳ chỉnh, tính theo thư mục làm việc. Không đặt: dùng planner tích hợp. Xem [Planner tuỳ chỉnh](#planner-tuỳ-chỉnh) |

## Đăng nhập và phiên

- Trình duyệt hỏi user `admin` và mật khẩu (HTTP Basic auth).
- Đăng nhập thành công thì bridge đặt cookie phiên `mb_session` (HttpOnly, SameSite=Strict, hiệu lực 12 giờ). Cookie này cũng dùng để xác thực WebSocket của dashboard, vì trình duyệt không phải lúc nào cũng gửi thông tin Basic auth cho WebSocket.
- Phiên lưu trong bộ nhớ: khởi động lại bridge là mọi người phải đăng nhập lại.
- Kết nối là HTTP thường. Chỉ dùng admin trong LAN tin cậy, hoặc sau VPN hay reverse proxy TLS của bạn.
- Request làm thay đổi dữ liệu (POST, PUT, DELETE) và WebSocket của dashboard bị từ chối với mã 403 khi trình duyệt gửi `Origin` không khớp header `Host`. Reverse proxy đặt trước admin phải giữ nguyên header `Host` gốc.

Đổi mật khẩu: sửa `admin.password` trong `config.json` rồi khởi động lại bridge, hoặc xoá khoá này để bridge sinh mật khẩu mới.

## Bước 1: Dự án

Nhập tên dự án, tầng và phòng.

- Mã tầng và mã phòng: 2 đến 8 ký tự `A-Z` và `0-9`. Mã phòng là duy nhất trong dự án.
- Mã là tiền tố của tên mạch và tên group address (ví dụ `GF.LIV.L01`), nên chốt trước bước 4. Đổi mã sau khi đã xuất ETS sẽ đổi tên group address; địa chỉ đã khoá giữ nguyên.
- Có thể đánh dấu một tầng là ngoài trời.

## Bước 2: Matter

Hiện trạng thái matterjs-server (số node, node offline, node hết fabric, node chưa gán) và nhúng dashboard matterjs-server. Dùng dashboard để commission thiết bị bằng mã ghép nối và xem sơ đồ mạng Thread. Xem [commissioning.md](commissioning.md).

Dashboard được bridge phục vụ tại `/matter/`, sau lớp đăng nhập admin. Xem [Proxy dashboard](#proxy-dashboard) về những gì bridge thay đổi và chặn.

## Bước 3: Gán thiết bị

Liệt kê mọi endpoint của mọi node.

- **Identify** làm thiết bị tự báo hiệu trong 10 giây (cluster Identify của Matter), để khớp dòng trên màn hình với thiết bị thật.
- **Loại mạch**: gợi ý theo cluster, sửa được. Các loại bridge điều khiển được hiện nay: đèn bật/tắt, đèn dimmer, đèn CCT, điều hoà, cảm biến hiện diện, tiếp điểm cửa. Các loại khác (đèn RGB, rèm cuốn, rèm lá) vẫn ghi được vào dự án, nhưng planner tích hợp không sinh group address cho chúng (có cảnh báo).
- **Phòng** và **tên mạch**: tên được sinh theo dạng `{tầng}.{phòng}.{token}` và sửa được. Chỉ ASCII, không dấu cách, phải bắt đầu bằng mã tầng và mã phòng, không trùng.
- Với điều hoà, chọn kiểu group address của quạt: cấp 0-3 (DPT 5.100, mặc định) hoặc phần trăm (DPT 5.001) kèm phần trăm cho Low / Medium / High. Xem [knx.md](knx.md#quạt-theo-cấp-hay-theo-phần-trăm).

Khoá cửa không gán ở đây; cấu hình trong `config.json` ([knx.md](knx.md#khoá-cửa)).

## Bước 4: Group address

Lập group address cho mọi mạch đã gán từ bản dự án đã lưu, và cho biết bridge phục vụ những địa chỉ nào.

- Còn thay đổi chưa lưu ở bước 1 đến 3 thì không lập được: bridge luôn lập từ bản đã lưu.
- Planner cấp địa chỉ và DPT cho từng mạch, bridge gắn mỗi địa chỉ với một channel (ví dụ giá trị dim của đèn với `light.N.level`). Scheme mặc định (main theo hệ thống, middle theo tầng, mỗi phòng một khối 20 sub) và object theo từng loại mạch được mô tả ở [knx.md](knx.md#bố-trí-group-address).
- Kết quả: tổng số group address, số bridge phục vụ, lỗi (chặn áp dụng và xuất) và cảnh báo.
- Sau khi xuất ETS, địa chỉ bị khoá. Nếu lập lại làm đổi một địa chỉ đã xuất, địa chỉ đó hiện trong mục thay đổi địa chỉ.

**Ghi đè thủ công.** Mọi địa chỉ trong bảng GA đều sửa trực tiếp được. Địa chỉ sửa tay được lưu trong dự án (`overrides`, theo mạch và object), hiện nhãn "tay" và có thể trả về địa chỉ do planner sinh. Các kiểm tra: sai định dạng, một địa chỉ tay dùng hai lần, địa chỉ đã import từ ETS (chỉ cho phép sau khi xác nhận "dùng địa chỉ đã import"), địa chỉ ngoài dải hợp lệ (main 0-31, middle 0-7, sub 0-255, khác 0/0/0), trùng với group address khác, và địa chỉ tay mà group address không còn tồn tại (cảnh báo).

**Import địa chỉ ETS có sẵn.** Để tránh trùng với hệ KNX đã có tại công trình, import file xuất group address của hệ đó ở bước 4. Định dạng nhận, tự nhận biết: ETS CSV (1 cấp hoặc 3 cấp, phân cách `;`, `,` hoặc tab, có hoặc không có BOM) và ETS GroupAddress-Export XML, tối đa 16 MB. Địa chỉ import thành địa chỉ dành riêng: planner bỏ qua chúng, và đặt địa chỉ tay trùng địa chỉ dành riêng phải xác nhận. Group address do chính bridge xuất trước đó được nhận ra và không bị giữ chỗ. Mỗi lần import thay danh sách dành riêng (hoặc gộp vào); có thể xoá danh sách. Group address cố ý dùng địa chỉ đã import không được đưa vào file xuất ETS của bridge, vì đã có sẵn trong project ETS.

Import file xuất thật từ ETS 5 / 6: cần kiểm chứng.

## Bước 5: Áp dụng

Nạp plan vào bridge đang chạy:

- Ghi `lights`, `thermostats`, `sensors` và `knx.objects` vào `config.json`. File cũ được giữ thành `config.json.bak`. Các khoá khác (khoá cửa, thiết lập KNX interface, admin) giữ nguyên.
- **`knx.objects` bị thay toàn bộ.** Object viết tay sẽ mất.
- Slot: một cặp node và endpoint giữ số slot đã có, để các gắn kết cũ không bị lệch. Slot của thiết bị không có trong dự án (ví dụ khoá cấu hình tay) được giữ.
- Bridge nạp cấu hình mới mà không khởi động lại. Các tunnel KNX đang mở vẫn kết nối và nhận trạng thái hiện tại của mọi group address phản hồi.
- Không áp dụng được khi plan còn lỗi, và phải xác nhận rõ trong hộp thoại.

## Bước 6: Bàn giao

Tài liệu tham chiếu cho người cấu hình KNX client.

- **Bảng group address**: mọi group address nhóm theo tầng và phòng, gồm tên, chiều (lệnh hoặc phản hồi), thiết bị và **giá trị cần nhập vào KNX client** (ví dụ `0 Auto · 1 Heat · 3 Cool · 6 Off · 9 Fan · 14 Dry` cho mode HVAC). Có bộ lọc chỉ hiện các địa chỉ bridge phục vụ. Đầu bảng hiện IP interface (IP bridge và cổng 3671).
- **CSV**: toàn bộ bảng, mã hoá UTF-8 có BOM để các chương trình bảng tính giữ đúng dấu tiếng Việt.
- **In**: bản in có tên dự án, revision, IP và ngày in ở đầu trang.
- **Xuất ETS**: tạo `matter-bridge-rev<N>-ets.xml` (ETS GroupAddress-Export XML: group range lồng theo main rồi middle, DPT dạng `DPST-x-y`, kèm mô tả) và `matter-bridge-rev<N>-ga.csv` (CSV 3 cấp có BOM). Lần xuất **khoá** địa chỉ ở revision N. Nếu thay đổi sau đó làm dịch một địa chỉ đã xuất, hộp thoại xuất liệt kê thay đổi và yêu cầu xác nhận rõ; khi đó phải cập nhật lại project ETS và KNX client.

Import các file này vào ETS 5 / 6: cần kiểm chứng.

## Trang Khoá cửa

Liệt kê các khoá trong `config.json` kèm trạng thái, pin và việc mở khoá qua KNX có bật hay không.

- **Khoá**: gửi `lockDoor` sau hộp thoại xác nhận.
- **Mở khoá**: cần **PIN mở khoá**, tách riêng khỏi mật khẩu admin.
- Trang còn hiện nhật ký mở khoá (50 mục gần nhất) và cho đổi PIN (phải nhập PIN hiện tại).

### PIN mở khoá

Đặt trên máy chạy bridge:

```sh
npm run set-unlock-pin              # dùng config.json
npm run set-unlock-pin -- other.json
```

Script hỏi 6 chữ số hai lần, lưu hash scrypt (salt ngẫu nhiên) vào `admin.unlock_pin_hash` và giữ file cũ thành `config.json.bak`. Khởi động lại bridge sau đó.

- Sai PIN 5 lần liên tiếp thì chức năng mở khoá bị khoá 5 phút. Bộ đếm tính chung cho cả bridge, không theo địa chỉ IP.
- Mọi lần thử (đã mở, sai PIN, bị khoá tạm, lệnh lỗi, đổi PIN, lệnh dashboard bị chặn) được ghi vào `admin.audit_path` kèm thời gian, nguồn và IP client.
- Lệnh tới khoá dùng Matter timed request (10 s) theo yêu cầu của cluster DoorLock.

PIN bảo vệ việc mở khoá từ admin. PIN độc lập với `unlock_enabled`, khoá này chỉ điều khiển việc mở khoá qua KNX. Việc khoá cửa có tự yêu cầu PIN riêng cho thao tác từ xa (RequirePINforRemoteOperation) hay không chưa được thử với khoá thật.

## Proxy dashboard

Bridge chuyển tiếp `/matter/` tới matter-server (`matter_server` trong `config.json`, thường là `127.0.0.1:5580`):

- Request HTTP được chuyển tiếp mà bỏ header `Authorization` và `Cookie` của trình duyệt. File của dashboard không bị sửa, ngoại trừ một thẻ script (`window.__MATTERJS_PRODUCTION_MODE__=true`) được chèn vào trang index để dashboard kết nối tới `/matter/ws` thay vì hỏi URL server.
- WebSocket `/matter/ws` cần phiên admin hợp lệ. Message từ dashboard được kiểm tra trước khi tới matter-server. Bị chặn:
  - mọi lệnh DoorLock (cluster 257) trừ `lockDoor`, kể cả trong lệnh gộp (batched);
  - mọi lệnh ghi attribute vào cluster 257.
  - áp dụng cho cả message dạng text lẫn binary, và mọi message không phải JSON thuần.
- Message bị chặn nhận câu trả lời lỗi (mã 403) trên dashboard và một mục `blocked_dashboard` trong nhật ký.
- Không thương lượng nén WebSocket, để đọc được mọi message.

Bộ lọc này ngăn việc mở khoá tuỳ tiện hoặc nhầm từ dashboard, nhưng không phải sandbox: dashboard vẫn có toàn quyền controller, nên người có mật khẩu admin vẫn có thể, ví dụ, mở commissioning window trên khoá cửa rồi ghép khoá với một controller khác. Hãy coi mật khẩu admin là quyền điều khiển mọi thiết bị đã commission.

Bộ lọc này chỉ áp dụng cho proxy. Client kết nối thẳng tới matter-server không bị lọc, vì vậy matter-server chỉ được nghe trên `127.0.0.1`.

Dashboard nhúng đã dùng với Chrome trên máy tính. Safari và trình duyệt di động: cần kiểm chứng.

## Planner tuỳ chỉnh

Scheme địa chỉ có thể thay thế. Đặt `admin.planner_module` là đường dẫn tới một ES module export planner dưới dạng default export hoặc named export `planner`:

```js
// tiny-planner.mjs: mỗi mạch một GA công tắc trong main group 9
export default {
    name: "tiny",
    plan(input) {
        const gas = input.circuits.map((c, i) => ({
            ga: "9/0/" + (i + 1), name: "T " + c.name, dpt: "1.001",
            deviceId: c.id, objectKey: "SW", isStatus: false, rangePath: ["Tiny", "All"],
        }));
        return { scheme: "tiny-1", gas, issues: [], stats: { total: gas.length, bySystem: {}, maxUtilization: null } };
    },
};
```

- `plan(input, options?)` phải chạy đồng bộ và cho kết quả xác định. `input` gồm `floors`, `rooms`, `circuits` (id, tên, loại, mã tầng và phòng, tuỳ chọn như `fanFormat`) và `reserved` (địa chỉ import phải bỏ qua). Kiểu dữ liệu ở `src/admin/planner/types.ts`.
- Giá trị `objectKey` phải khớp các key bridge gắn được (xem bảng object ở [knx.md](knx.md#bố-trí-group-address)); key khác vẫn nằm trong file xuất nhưng không được gắn.
- Với mọi planner, bridge vẫn áp dụng địa chỉ tay, kiểm tra trùng và địa chỉ dành riêng, và ép DPT của object quạt (5.100 hoặc 5.001) và mode (20.105).

Bridge không khởi động nếu không nạp được module hoặc module không export planner.

## HTTP API

Giao diện dùng JSON API dưới `/api/` với cùng cơ chế xác thực: trạng thái, node, identify, dự án, plan, áp dụng, xuất, khoá cửa. Áp dụng, xuất và khoá cần `"confirm": true` trong body; mở khoá cần PIN. API này dành riêng cho giao diện admin và có thể đổi giữa các phiên bản.
