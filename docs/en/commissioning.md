# Adding Matter devices (commissioning)

English | [Tiếng Việt](../vi/commissioning.md)

The bridge does not commission devices itself. matterjs-server is the Matter controller: it joins each device as an additional administrator (multi-admin) and keeps the fabric credentials in its storage directory. The bridge then talks to the devices through matter-server.

The usual path is to keep a device in the ecosystem where it is already installed (Apple Home, Google Home...) and share it with matter-server using a pairing code. No Bluetooth and no Thread credentials are needed for that, because the device is already on the network.

## Before you start

- matter-server and the bridge are running ([setup.md](setup.md)).
- For Thread devices, the host has an IPv6 route to the Thread network ([setup.md](setup.md), section 4).
- Note for each device: brand and model, Wi-Fi or Thread, the room, and how many ecosystems already control it.

### Fabric limit

Each ecosystem that controls a Matter device uses one fabric on that device. Most devices support 5 fabrics. When all are used (shown as 5/5), commissioning fails until you remove the device from one ecosystem. The admin app shows the fabric count per node in step 3 and flags full nodes in step 2.

Keep a list of which devices you shared with matter-server. You need it to remove the fabric again later (for example when moving to another host).

## 1. Get a pairing code

The code is valid for a limited time (typically a few minutes), so generate it right before step 2. Menu names depend on the app version and language.

**Apple Home**: open the accessory, go to its settings, choose **Turn On Pairing Mode**. The app shows an 11-digit setup code. An 8-digit code is a HomeKit code, not a Matter code, and does not work.

**Google Home**: open the device settings, **Linked Matter apps & services**, **Link apps & services**. The app shows a pairing code. To be verified with this bridge.

**Other ecosystems**: look for "share device", "multi-admin" or "pairing mode" in the device settings.

**New device not in any ecosystem**: commissioning with the QR code over Bluetooth is possible in the matter-server dashboard if the host has Bluetooth, but this has not been tested with the bridge. Commissioning into Apple Home first and sharing it is the tested path (Google Home: to be verified).

## 2. Commission in the dashboard

1. Open the admin app (`http://<bridge-ip>:2401`), step 2 **Matter**. The matterjs-server dashboard is embedded below the summary bar. It is English only. **Open in new tab** shows it full size.
2. In the dashboard, choose **Commission node**, then the option to use a setup code, and paste the code.
3. Wait for the node to appear with its endpoints and clusters. Thread devices can take longer than Wi-Fi devices.

What you should see per device type:

| Device | Clusters on the endpoint |
|---|---|
| Light, switch, plug | OnOff (6); LevelControl (8) for dimming; ColorControl (768) for colour or colour temperature |
| Air conditioner, thermostat | Thermostat (513); FanControl (514) on the same or another endpoint; humidity sensor optional |
| Presence / motion sensor | OccupancySensing (1030), optionally IlluminanceMeasurement (1024) |
| Door / window contact | BooleanState (69) |
| Door lock | DoorLock (257), PowerSource for battery |

The dashboard also shows the Thread network graph, which helps to judge the mesh quality around a device.

A switch with several channels is one node with several endpoints. Each endpoint becomes its own circuit in the bridge.

## 3. Identify and assign

Step 3 **Assign devices** in the admin lists every endpoint. The node list refreshes every 10 seconds, so a newly commissioned node shows up without reloading.

- **Identify** sends the Matter Identify command (cluster 3) to the endpoint for 10 seconds. The device blinks, beeps or otherwise shows itself, depending on the model. Use it to find which physical device is which before you name it.
- The admin suggests a circuit type from the clusters (for example dimmable light when LevelControl is present). You can change it.
- Pick the room and edit the generated circuit name.

Details: [admin.md](admin.md).

Door locks are not assigned in step 3. Add them by hand to `locks` in `config.json` ([knx.md](knx.md#door-locks)).

## Removing a device

To give up the fabric slot used by matter-server:

1. Remove the circuit from the project in the admin (step 3), regenerate group addresses and apply.
2. Remove the node in the matter-server dashboard. The dashboard tries to remove its fabric from the device.
3. Check in the original ecosystem (for example the accessory's connected services in Apple Home) that the matter-server fabric is gone. If not, remove it there.

## Troubleshooting

| Symptom | Check |
|---|---|
| "Code invalid" | 11-digit Matter code, not the 8-digit HomeKit code; code not expired; generate a new one |
| Commissioning fails with no free fabric | Device has 5/5 fabrics. Remove one ecosystem from it |
| Thread device not found or times out | IPv6 route to the Thread prefix on the host, border router online, device on that border router's Thread network |
| Device found twice, discovery erratic | Two active network interfaces on the host. Disable one |
| Node online in the dashboard but offline in the admin | Bridge not connected to matter-server (status bar shows Matter disconnected) |
