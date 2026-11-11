# Cài đặt

[English](../en/setup.md) | Tiếng Việt

Hướng dẫn này cài matterjs-server và bridge trên cùng một máy: macOS để phát triển, Raspberry Pi 5 để lắp đặt lâu dài. Cài xong, làm tiếp theo [commissioning.md](commissioning.md) và [admin.md](admin.md).

## 1. Yêu cầu

| Hạng mục | Yêu cầu |
|---|---|
| Máy chủ | macOS 14 trở lên (đã thử), hoặc Raspberry Pi 5 chạy Linux 64-bit (mục tiêu triển khai, cần kiểm chứng) |
| Node.js | 22.x, tối thiểu 22.18 (`engines` trong `package.json`: `>=22.18.0 <23`). Node chạy thẳng file `.ts` |
| Mạng | Nên dùng Ethernet có dây. Cùng L2 / VLAN với KNX client, thiết bị Matter và Thread border router. Không lọc mDNS và IPv6 multicast |
| Thread | Có Thread border router trong LAN (ví dụ HomePod mini, Apple TV 4K, Google Nest hub). Thiết bị phải nằm trên mạng Thread của border router đó |
| Ổ đĩa | Khoảng 0,5 GB cho `node_modules` và dữ liệu matter-server |

Các cổng sử dụng:

| Cổng | Giao thức | Tiến trình nghe | Phạm vi |
|---|---|---|---|
| 3671 | UDP | Bridge, KNXnet/IP tunnelling (và multicast 224.0.23.12 cho search) | LAN, KNX client |
| 2401 | TCP (HTTP) | Bridge, admin | LAN, chỉ kỹ sư |
| 5580 | TCP (WebSocket + dashboard) | matter-server | Chỉ `127.0.0.1` |

## 2. Cài Node.js 22

macOS dùng Homebrew:

```sh
brew install node@22
export PATH=/opt/homebrew/opt/node@22/bin:$PATH   # thêm vào shell profile
node -v   # phải ra v22.x, x >= 18
```

Chỉ hỗ trợ Node 22. Nếu bản Node mới hơn của Homebrew đứng trước trong `PATH`, `npm ci` sẽ cảnh báo engine không khớp và bridge có thể không chạy. Đặt `node@22` lên trước như trên.

Raspberry Pi: cài Node 22 bằng cách nào cũng được, miễn là bản 22.18 trở lên (ví dụ gói NodeSource hoặc trình quản lý phiên bản như nvm). Kiểm tra bằng `node -v`.

## 3. Lấy mã nguồn

```sh
git clone https://github.com/tungvu9x/matter-knx-bridge.git
cd matter-knx-bridge
npm ci                 # cài matter-server và đúng phiên bản trong package-lock.json
npm run build:admin    # build giao diện admin vào admin-ui/dist/
npm test               # mock test, không cần thiết bị
```

Chưa chạy `npm run build:admin` thì cổng admin chỉ hiện trang "UI not built".

## 4. Chuẩn bị mạng

### macOS

Chỉ bật một interface mạng khi làm việc với Matter. Bật cả Wi-Fi và Ethernet thì mDNS trả lời hai lần, thiết bị có thể xuất hiện hai lần hoặc không phân giải được.

```sh
networksetup -listallhardwareports          # tìm tên thiết bị Wi-Fi (thường là en0 hoặc en1)
networksetup -setairportpower <wifi-device> off

# Thread: route IPv6 tới prefix Thread (fd...) do border router quảng bá
netstat -rn -f inet6 | grep -E '^fd'

# Border router và thiết bị Matter đã commission thấy được trên LAN (Ctrl+C sau vài giây)
dns-sd -B _meshcop._udp local.
dns-sd -B _matter._tcp local.

# Không cho máy ngủ trong lúc thử
caffeinate -dimsu &
```

Nếu route Thread chỉ có trên interface vừa tắt, chờ 1 đến 2 phút để có router advertisement tiếp theo rồi kiểm tra lại. Không có route này thì không tới được thiết bị Thread.

Firewall ứng dụng của macOS có thể hỏi cho phép kết nối vào `node`. Chọn cho phép, nếu không KNX client không tới được UDP 3671 và trình duyệt không tới được 2401.

### Raspberry Pi / Linux

Linux phải nhận thông tin route mà Thread border router gửi trong router advertisement. Đây là các thiết lập thường được ghi trong tài liệu cho Matter controller trên Linux (ví dụ phần yêu cầu hệ điều hành của Python Matter server thuộc Open Home Foundation); thay `eth0` bằng interface của bạn. Cần kiểm chứng trên Raspberry Pi 5 với bridge này.

```sh
sudo sysctl -w net.ipv6.conf.eth0.accept_ra=1
sudo sysctl -w net.ipv6.conf.eth0.accept_ra_rt_info_max_plen=64
ip -6 route | grep -E '^fd'           # route tới prefix Thread qua border router
avahi-browse -rt _matter._tcp         # cần gói avahi-utils
```

Ghi hai dòng `sysctl` vào một file trong `/etc/sysctl.d/` để giữ sau khi khởi động lại. Nếu máy có chuyển tiếp IPv6 (`net.ipv6.conf.all.forwarding=1`) thì `accept_ra` phải là `2`.

## 5. Chạy matterjs-server

matter-server được cài như một dependency và chạy qua npm script `matter-server`:

```sh
mkdir -p ./data/matter
npm run matter-server -- \
  --storage-path ./data/matter \
  --listen-address 127.0.0.1 \
  --primary-interface en0 \
  --disable-ota
```

| Tham số | Lý do |
|---|---|
| `--storage-path` | Thông tin xác thực fabric và dữ liệu node. Đây là thứ bắt buộc phải sao lưu. `data/` đã có trong `.gitignore` |
| `--listen-address 127.0.0.1` | Không có tham số này, matter-server nghe trên mọi interface. Proxy của admin lọc lệnh khoá cửa; kết nối thẳng vào 5580 sẽ bỏ qua bộ lọc đó |
| `--primary-interface` | Interface dùng cho địa chỉ IPv6 link-local (`en0`, `eth0`...). Chọn interface có route Thread |
| `--disable-ota` | Tuỳ chọn: không cập nhật firmware trong lúc thử |
| `--log-file <path>` | Tuỳ chọn: ghi log ra file |
| `--port <port>` | Tuỳ chọn: mặc định 5580. Đổi cổng thì sửa cả `matter_server` trong `config.json` |

Kiểm tra chỉ nghe nội bộ:

```sh
lsof -nP -iTCP:5580 -sTCP:LISTEN     # macOS: chỉ được có 127.0.0.1:5580
ss -ltnp | grep 5580                 # Linux
```

Dừng matter-server bằng Ctrl+C (SIGINT) và chờ thoát hẳn rồi mới chạy lại. Hai tiến trình cùng một storage path, hoặc kill cứng, có thể để storage bị khoá và lần chạy sau sẽ lỗi.

## 6. Cấu hình bridge

```sh
cp config.example.json config.json
```

Sửa `config.json`:

- `knx.host_ip`: địa chỉ IPv4 LAN của máy này, ví dụ `192.168.1.50`. KNX client nhận địa chỉ này trong câu trả lời discovery, và nhóm multicast được join trên địa chỉ này. Để trống thì bridge lấy IPv4 không phải loopback đầu tiên, có thể sai interface.
- Xoá các mục mẫu trong `lights`, `thermostats`, `sensors`, `locks` và `knx.objects`. Chúng trỏ tới node ID không có trên matter-server của bạn (hoặc tệ hơn, trỏ nhầm sang thiết bị khác có cùng ID). Admin sẽ điền `lights`, `thermostats`, `sensors` và `knx.objects` khi áp dụng plan.
- Không ghi `admin.password`. Lần chạy đầu bridge tự sinh mật khẩu ngẫu nhiên, lưu vào `config.json` (quyền file 0600) và in ra log đúng một lần ở dòng cảnh báo. Muốn tự đặt thì dùng tối thiểu 8 ký tự.

`config.json` đã có trong `.gitignore`. File chứa mật khẩu admin và hash PIN mở khoá: giữ kín. Tra cứu đầy đủ các khoá: [knx.md](knx.md) và [admin.md](admin.md).

## 7. Chạy bridge

```sh
npm start                              # tương đương: node src/main.ts config.json
node src/main.ts /path/to/config.json  # dùng file config khác
BRIDGE_CONFIG=/path/to/config.json npm start
LOG_LEVEL=debug npm start              # ghi log mọi telegram KNX và lệnh
```

Log ra stdout (info, debug) và stderr (warn, error). Khi khởi động phải thấy dòng KNX server (`KNXnet/IP tunneling server <ip>:3671 ...`) và URL admin. Bridge kết nối tới matter-server và tự kết nối lại (chờ 1 s, tăng gấp đôi tới 30 s), nên thứ tự khởi động không quan trọng.

Dừng bằng Ctrl+C hoặc SIGTERM. Các tunnel đang mở sẽ nhận lệnh ngắt kết nối.

## 8. Raspberry Pi 5 với systemd

Dưới đây là cách bố trí mẫu, chưa kiểm chứng trên Pi 5. Chỉnh user, đường dẫn và tên interface cho phù hợp.

```sh
sudo useradd --system --create-home --home-dir /opt/matter-knx-bridge matterknx
sudo -u matterknx git clone https://github.com/tungvu9x/matter-knx-bridge.git /opt/matter-knx-bridge/app
cd /opt/matter-knx-bridge/app
sudo -u matterknx npm ci
sudo -u matterknx npm run build:admin
sudo -u matterknx cp config.example.json config.json   # rồi sửa như mục 6
sudo -u matterknx mkdir -p /opt/matter-knx-bridge/data/matter
```

`/etc/systemd/system/matter-server.service`:

```ini
[Unit]
Description=matterjs-server (Matter controller for matter-knx-bridge)
After=network-online.target
Wants=network-online.target

[Service]
User=matterknx
WorkingDirectory=/opt/matter-knx-bridge/app
ExecStart=/usr/bin/node node_modules/matter-server/dist/esm/bin.js \
  --storage-path /opt/matter-knx-bridge/data/matter \
  --listen-address 127.0.0.1 \
  --primary-interface eth0
# SIGINT để matter-server đóng storage sạch sẽ
KillSignal=SIGINT
TimeoutStopSec=30
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/matter-knx-bridge.service`:

```ini
[Unit]
Description=matter-knx-bridge (KNXnet/IP interface for Matter devices)
After=network-online.target matter-server.service
Wants=network-online.target

[Service]
User=matterknx
WorkingDirectory=/opt/matter-knx-bridge/app
ExecStart=/usr/bin/node src/main.ts /opt/matter-knx-bridge/app/config.json
Environment=LOG_LEVEL=info
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Kiểm tra đường dẫn `node` bằng `which node` (trình quản lý phiên bản cài ở chỗ khác). `admin.project_path` và `admin.audit_path` tính tương đối theo `WorkingDirectory` nếu không ghi đường dẫn tuyệt đối.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now matter-server matter-knx-bridge
journalctl -u matter-knx-bridge -f      # mật khẩu admin tự sinh hiện ở đây trong lần chạy đầu
```

Cả hai service không cần root: 3671, 2401 và 5580 đều lớn hơn 1024.

Hiệu năng trên Pi 5 (số thiết bị, số tunnel, độ trễ) chưa được đo.

## 9. Sao lưu

Sao lưu cùng nhau, và trước mỗi thay đổi lớn:

| Nội dung | Lý do |
|---|---|
| Storage của matter-server (`--storage-path`) | Thông tin xác thực fabric. Mất thư mục này là phải commission lại toàn bộ thiết bị |
| `config.json` (và `config.json.bak`) | Slot, gắn KNX, mật khẩu admin, hash PIN mở khoá |
| `project.json` | Tầng, phòng, gán thiết bị, bản địa chỉ đã áp dụng và đã xuất |
| `unlock-audit.log` | Nhật ký mở khoá |

Bản sao lưu là dữ liệu bí mật.

Khi chuyển sang máy khác: hoặc chuyển nguyên thư mục storage và dùng cùng phiên bản matter-server, hoặc gỡ fabric của controller cũ khỏi từng thiết bị rồi commission lại trên máy mới.

## 10. Cập nhật

```sh
git pull
npm ci
npm run build:admin
npm test
```

Sau đó khởi động lại cả hai tiến trình (matter-server dừng bằng SIGINT).

## 11. Xử lý sự cố

| Hiện tượng | Kiểm tra |
|---|---|
| `node` lỗi khi chạy file `.ts` hoặc `npm ci` cảnh báo engine | `node -v` phải là 22.x (>= 22.18) |
| KNX client không tìm thấy bridge | `knx.host_ip` đúng interface; firewall cho phép UDP 3671; client và bridge cùng subnet (multicast search không qua router). Có thể nhập thẳng IP:3671 |
| Admin hiện "UI not built" | Chạy `npm run build:admin` |
| Không tới được thiết bị Thread, commission bị treo | Route IPv6 tới prefix `fd...` (mục 4), border router đang online, thiết bị nằm trên mạng Thread của border router đó |
| Thiết bị xuất hiện hai lần, mDNS chập chờn | Máy có hai interface đang bật (Wi-Fi và Ethernet). Tắt một cái |
| matter-server không khởi động sau khi bị crash | Còn tiến trình khác đang chạy hoặc storage còn bị khoá. Dừng hết rồi chạy lại |
| Thanh trạng thái admin báo mất kết nối Matter | matter-server chưa chạy, hoặc URL / cổng `matter_server` không khớp |
| Lệnh không có tác dụng, `error` của thiết bị là `no confirmation from device` | Thiết bị không báo trạng thái mong đợi trong `pending_timeout_ms`. Kiểm tra thiết bị trên dashboard |
