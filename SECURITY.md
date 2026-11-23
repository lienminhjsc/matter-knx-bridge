# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |

Only the latest release receives fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub Security Advisories:

https://github.com/lienminhjsc/matter-knx-bridge/security/advisories/new

Do not open a public issue for a vulnerability. Include the version or commit, your setup (OS, Node version, how the bridge is exposed on the network), steps to reproduce and the impact you expect. If the issue involves a door lock, say so in the title.

The project is maintained by the KNXStore.vn team. You will get an acknowledgement as soon as possible, usually within a week. Fixes are released as a new version with a note in [CHANGELOG.md](CHANGELOG.md); reporters are credited unless they ask not to be.

## Scope

In scope:

- **Admin authentication**: Basic auth, session cookie handling, access to the JSON API or static files without login.
- **Door locks**: any way to unlock a door without the unlock PIN (admin), without `unlock_enabled` (KNX), or through the embedded dashboard; bypass of the wrong-PIN lockout; missing audit entries.
- **Dashboard proxy**: bypass of the DoorLock filter on `/matter/ws`, access to matter-server without an admin session, request smuggling through the proxy.
- **KNX exposure**: crashes or resource exhaustion from malformed KNXnet/IP packets, commands reaching channels that are not bound, unlock telegrams accepted when `unlock_enabled` is false.
- **Secrets handling**: admin password, PIN hash, or fabric data leaking into logs, API responses or files outside the documented ones.

Out of scope:

- The fact that KNXnet/IP tunnelling has no authentication (see threat model).
- Plain HTTP on the admin port (documented; put a TLS proxy or VPN in front if you need it).
- Vulnerabilities in matterjs-server, matter.js or the Matter devices themselves. Report those upstream (for matterjs-server: https://github.com/matter-js/matterjs-server).
- Attacks that require shell access to the bridge host or write access to `config.json`.

## Threat model

The bridge is designed for a **trusted local network** (one home or building LAN, or a dedicated VLAN for building automation).

- **KNXnet/IP has no authentication.** Anyone who can send UDP packets to port 3671 can open a tunnel and write every bound group address, including `lock.N.unlock` when `unlock_enabled` is true. KNX IP Secure is not supported. Restrict who can reach port 3671 with network segmentation.
- **Admin on port 2401** uses HTTP Basic auth and a session cookie over plain HTTP. Credentials can be sniffed on an untrusted network. The unlock PIN is a second factor for unlocking from the admin, stored as an scrypt hash; 5 wrong attempts lock unlocking for 5 minutes, counted globally.
- **matterjs-server on port 5580** has no authentication of its own. It must listen on `127.0.0.1` only (`--listen-address 127.0.0.1`). The admin proxy is the only intended way to reach the dashboard, and it filters DoorLock commands; a direct connection is not filtered. The filter is not a sandbox: the dashboard has full controller rights, so the admin password effectively controls every commissioned device (for example, opening a commissioning window on a lock to pair it elsewhere). The unlock PIN guards the direct unlock paths, not against a malicious admin.
- **Door locks**: unlocking over KNX is disabled by default per lock. Lock and unlock channels only act on `true`, so a 0 telegram never unlocks. Enabling `unlock_enabled` means accepting the KNX risk above for that door.
- **Files with secrets**: `config.json` (admin password in clear text, PIN hash), `config.json.bak`, `project.json`, `unlock-audit.log` (IP addresses) and the matter-server storage directory (fabric credentials that control every commissioned device). Keep them readable only by the service user and out of version control and support tickets.

Recommendations:

- Never expose ports 3671, 2401 or 5580 to the Internet. Do not forward them on the router.
- For remote access, use a VPN into the LAN, not port forwarding.
- Set `admin.host` to the LAN address of the host, not `0.0.0.0`, if the host has several interfaces.
- Keep Node.js and dependencies up to date (`npm ci` after `git pull`).
- Review `unlock-audit.log` after commissioning and from time to time.
