# Field tests / Thử nghiệm thực tế

Long-running tests of matter-knx-bridge on real sites with real devices. Each test has one report file that is updated during the test and closed with a conclusion. The README status table is only changed from "To be verified" to "Verified" when a closed report supports it.

Các đợt chạy thử dài ngày trên công trình và thiết bị thật. Mỗi đợt có một file report, cập nhật trong suốt đợt test và chốt kết luận khi kết thúc. Bảng Status trong README chỉ đổi từ "Cần kiểm chứng" sang "Đã kiểm chứng" khi có report đã chốt làm căn cứ.

| Test | Site | Period | Bridge version | Status |
|---|---|---|---|---|
| [knxstore-office-01](knxstore-office-01.md) | KNXStore.vn office | to be filled | to be filled | Not started |

## Starting a new report / Tạo report mới

1. Copy [TEMPLATE.md](TEMPLATE.md) to `<site>-<nn>.md` (for example `knxstore-office-02.md`) and add a row to the table above.
2. Fill sections 1 to 4 before the test starts. Update sections 5 to 7 every week. Fill section 8 when the test ends.
3. One pull request per weekly update is fine. Title: `Field test <name>: week N`.

## What must not be published / Không được đưa lên repo

- IP addresses, MAC addresses, Wi-Fi names or any network plan of a real site. Write "same VLAN as KNX clients", not the subnet.
- Matter pairing codes, QR codes, fabric data, `config.json`, `project.json`, admin password, unlock PIN.
- Device serial numbers, customer names, addresses, photos that show the site.
- Log excerpts: remove IP addresses before pasting (`sed -E 's/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/x.x.x.x/g'`).

## Collecting the numbers from the log / Lấy số liệu từ log

The bridge writes one line per event: `<ISO time> <LEVEL> [<tag>] <message>`. Set `LOG_LEVEL=debug` for the whole test, otherwise commands are not logged and the command count in section 5 cannot be filled.

Set the log file and the week, then run:

```sh
LOG=/path/to/bridge.log          # file collected by launchd or systemd
FROM=2026-12-01; TO=2026-12-08   # week start (included) and end (excluded), UTC dates
week() { awk -v f="$FROM" -v t="$TO" 'substr($1,1,10)>=f && substr($1,1,10)<t' "$LOG"; }

echo "bridge starts:          $(week | grep -c 'KNXnet/IP tunneling server')"
echo "matter-server lost:     $(week | grep -c '\[matter\] connection lost')"
echo "matter-server connects: $(week | grep -c '\[matter\] connected to')"
echo "commands (debug):       $(week | grep -c 'DEBUG \[cmd\]')"
echo "command timeouts:       $(week | grep -c 'no confirming state within')"
echo "KNX tunnels opened:     $(week | grep -c 'tunnel .* connected from')"
echo "KNX bad packets:        $(week | grep -c '\[knx\] bad packet')"
echo "errors:                 $(week | grep -c ' ERROR ')"
week | grep 'no confirming state within' | sed -E 's/.*\[cmd\] ([^ ]+) .*/\1/' | sort | uniq -c   # timeouts per channel
```

"bridge starts" counts every start of the bridge process, including planned restarts; note planned restarts in section 7 so they can be told apart from crashes.

Latency is not in the log. Measure it by hand in the ETS group monitor (or the bus monitor of the KNX client): time between the command telegram and the matching feedback telegram, 20 samples per device type, report median and maximum.
