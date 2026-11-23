# Setup

English | [Tiếng Việt](../vi/setup.md)

This guide installs matterjs-server and the bridge on one host: macOS for development, Raspberry Pi 5 for a permanent installation. After setup, continue with [commissioning.md](commissioning.md) and [admin.md](admin.md).

## 1. Requirements

| Item | Requirement |
|---|---|
| Host | macOS 14 or later (tested), or Raspberry Pi 5 with a 64-bit Linux (intended target, to be verified) |
| Node.js | 22.x, at least 22.18 (`package.json` `engines`: `>=22.18.0 <23`). Node runs the `.ts` sources directly |
| Network | Wired Ethernet recommended. Same L2 segment / VLAN as the KNX clients, the Matter devices and the Thread border router. mDNS and IPv6 multicast must not be filtered |
| Thread | A Thread border router on the LAN (for example HomePod mini, Apple TV 4K, Google Nest hub). The devices must be on that border router's Thread network |
| Disk | About 0.5 GB for `node_modules` and matter-server data |

Ports used:

| Port | Protocol | Who listens | Exposure |
|---|---|---|---|
| 3671 | UDP | Bridge, KNXnet/IP tunnelling (and multicast 224.0.23.12 for search) | LAN, KNX clients |
| 2401 | TCP (HTTP) | Bridge, admin web app | LAN, engineer only |
| 5580 | TCP (WebSocket + dashboard) | matter-server | `127.0.0.1` only |

## 2. Install Node.js 22

macOS with Homebrew:

```sh
brew install node@22
export PATH=/opt/homebrew/opt/node@22/bin:$PATH   # add to your shell profile
node -v   # must print v22.x, x >= 18
```

Only Node 22 is supported. If a newer Node from Homebrew comes first in `PATH`, `npm ci` warns about the engine mismatch and the bridge may not run. Put `node@22` first as shown.

Raspberry Pi: install Node 22 with any method that gives 22.18 or later (for example the NodeSource packages or a version manager such as nvm). Check with `node -v`.

## 3. Get the code

```sh
git clone https://github.com/lienminhjsc/matter-knx-bridge.git
cd matter-knx-bridge
npm ci                 # installs matter-server and the exact versions from package-lock.json
npm run build:admin    # builds the admin UI into admin-ui/dist/
npm test               # mock tests, no devices needed
```

Without `npm run build:admin` the admin port only shows a "UI not built" page.

## 4. Prepare the network

### macOS

Use one active network interface while working with Matter. With Wi-Fi and Ethernet both up, mDNS answers arrive twice and devices can appear twice or fail to resolve.

```sh
networksetup -listallhardwareports          # find the Wi-Fi device name (often en0 or en1)
networksetup -setairportpower <wifi-device> off

# Thread: an IPv6 route to the Thread prefix (fd...) announced by the border router
netstat -rn -f inet6 | grep -E '^fd'

# Border routers and commissioned Matter devices visible on the LAN (Ctrl+C after a few seconds)
dns-sd -B _meshcop._udp local.
dns-sd -B _matter._tcp local.

# Keep the Mac awake while testing
caffeinate -dimsu &
```

If the Thread route only shows up on the interface you just disabled, wait 1 to 2 minutes for the next router advertisement and check again. Without that route, Thread devices cannot be reached.

The macOS application firewall may ask to allow incoming connections for `node`. Allow it, otherwise KNX clients cannot reach UDP 3671 and browsers cannot reach 2401.

### Raspberry Pi / Linux

Linux must accept the route information that the Thread border router sends in router advertisements. These are the settings commonly documented for Matter controllers on Linux (for example in the OS requirements of the Open Home Foundation Python Matter server); replace `eth0` with your interface. To be verified on Raspberry Pi 5 with this bridge.

```sh
sudo sysctl -w net.ipv6.conf.eth0.accept_ra=1
sudo sysctl -w net.ipv6.conf.eth0.accept_ra_rt_info_max_plen=64
ip -6 route | grep -E '^fd'           # route to the Thread prefix via the border router
avahi-browse -rt _matter._tcp         # needs avahi-utils
```

Put the two `sysctl` lines in a file under `/etc/sysctl.d/` to keep them after reboot. If the host forwards IPv6 (`net.ipv6.conf.all.forwarding=1`), `accept_ra` must be `2`.

## 5. Run matterjs-server

matter-server is installed as a dependency and started through the `matter-server` npm script:

```sh
mkdir -p ./data/matter
npm run matter-server -- \
  --storage-path ./data/matter \
  --listen-address 127.0.0.1 \
  --primary-interface en0 \
  --disable-ota
```

| Option | Why |
|---|---|
| `--storage-path` | Fabric credentials and node data. This is what you must back up. `data/` is git-ignored |
| `--listen-address 127.0.0.1` | Without it matter-server listens on all interfaces. The admin proxy filters door lock commands; a direct connection to 5580 would bypass that |
| `--primary-interface` | Interface used for IPv6 link-local addresses (`en0`, `eth0`...). Use the interface that carries the Thread route |
| `--disable-ota` | Optional: no firmware updates while you test |
| `--log-file <path>` | Optional: write the log to a file |
| `--port <port>` | Optional: default 5580. If you change it, change `matter_server` in `config.json` too |

Check that it only listens locally:

```sh
lsof -nP -iTCP:5580 -sTCP:LISTEN     # macOS: must show 127.0.0.1:5580 only
ss -ltnp | grep 5580                 # Linux
```

Stop matter-server with Ctrl+C (SIGINT) and wait until it has exited before starting it again. Two instances on the same storage path, or a hard kill, can leave the storage locked and the next start fails.

## 6. Configure the bridge

```sh
cp config.example.json config.json
```

Edit `config.json`:

- `knx.host_ip`: the LAN IPv4 of this host, for example `192.168.1.50`. KNX clients get this address in discovery answers, and the multicast group is joined on it. If empty, the bridge picks the first non-loopback IPv4, which may be the wrong interface.
- Remove the example entries in `lights`, `thermostats`, `sensors`, `locks` and `knx.objects`. They refer to node IDs that do not exist on your matter-server (or, worse, to different devices with the same IDs). The admin app fills `lights`, `thermostats`, `sensors` and `knx.objects` when you apply a plan.
- Leave `admin.password` out. On first start the bridge generates a random password, saves it to `config.json` (file mode 0600) and prints it once in the log as a warning line. To choose your own, set at least 8 characters.

`config.json` is git-ignored. It holds the admin password and the unlock PIN hash: keep it private. Full key reference: [knx.md](knx.md) and [admin.md](admin.md).

## 7. Run the bridge

```sh
npm start                              # same as: node src/main.ts config.json
node src/main.ts /path/to/config.json  # another config file
BRIDGE_CONFIG=/path/to/config.json npm start
LOG_LEVEL=debug npm start              # log every KNX telegram and command
```

Log lines go to stdout (info, debug) and stderr (warn, error). On start you should see the KNX server line (`KNXnet/IP tunneling server <ip>:3671 ...`) and the admin URL. The bridge connects to matter-server and reconnects by itself (1 s backoff doubling up to 30 s), so the start order does not matter.

Stop with Ctrl+C or SIGTERM. Open tunnels receive a disconnect.

## 8. Raspberry Pi 5 with systemd

The following is an example layout, not yet verified on a Pi 5. Adjust user, paths and interface names.

```sh
sudo useradd --system --create-home --home-dir /opt/matter-knx-bridge matterknx
sudo -u matterknx git clone https://github.com/lienminhjsc/matter-knx-bridge.git /opt/matter-knx-bridge/app
cd /opt/matter-knx-bridge/app
sudo -u matterknx npm ci
sudo -u matterknx npm run build:admin
sudo -u matterknx cp config.example.json config.json   # then edit as in section 6
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
# SIGINT lets matter-server close its storage cleanly
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

Check the `node` path with `which node` (a version manager installs it elsewhere). `admin.project_path` and `admin.audit_path` are relative to `WorkingDirectory` unless you give absolute paths.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now matter-server matter-knx-bridge
journalctl -u matter-knx-bridge -f      # the generated admin password appears here on first start
```

Neither service needs root: 3671, 2401 and 5580 are above 1024.

Performance on a Pi 5 (number of devices, tunnels, latency) has not been measured yet.

## 9. Backup

Back up together, and before every larger change:

| What | Why |
|---|---|
| matter-server storage (`--storage-path`) | Fabric credentials. Losing it means commissioning every device again |
| `config.json` (and `config.json.bak`) | Slots, KNX bindings, admin password, unlock PIN hash |
| `project.json` | Floors, rooms, assignments, applied and exported address snapshots |
| `unlock-audit.log` | Unlock audit trail |

Treat the backup as secret.

When moving from one host to another, either move the storage directory with the same matter-server version, or remove the old controller's fabric from each device and commission again on the new host.

## 10. Update

```sh
git pull
npm ci
npm run build:admin
npm test
```

Then restart both processes (matter-server with SIGINT).

## 11. Troubleshooting

| Symptom | Check |
|---|---|
| `node` fails on `.ts` files or `npm ci` warns about the engine | `node -v` must be 22.x (>= 22.18) |
| KNX client does not find the bridge | `knx.host_ip` is the right interface; firewall allows UDP 3671; client and bridge on the same subnet (multicast search does not cross routers). Connect by IP:3671 as a fallback |
| Admin shows "UI not built" | Run `npm run build:admin` |
| Thread device not reachable, commissioning hangs | IPv6 route to the `fd...` prefix (section 4), border router online, device on that border router's Thread network |
| Devices appear twice, mDNS is erratic | Two active interfaces on the host (Wi-Fi and Ethernet). Disable one |
| matter-server fails to start after a crash | Another instance still running or storage left locked. Stop all instances, start again |
| Admin status shows Matter disconnected | matter-server not running, or `matter_server` URL / port mismatch |
| Command has no effect, device `error` = `no confirmation from device` | Device did not report the expected state within `pending_timeout_ms`. Check the device in the dashboard |
