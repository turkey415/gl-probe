# GL Probe

Turns a GL.iNet travel router into a pocket switch-port tester. Plug its **WAN port** into a jack and
it tells you what's on the other end, on the router's own screen and on one web page in
[Probe Deck](https://github.com/turkey415/probe-deck)'s look, with Probe Deck's tools and Tailscale
page built in.

Tried on the **GL-BE3600 (Slate 7)**: OpenWrt 23.05 / GL firmware 4.10, a 2.5 GbE WAN port, a
284 × 76 touchscreen, a side switch, and Python 3.11 already installed. Other GL.iNet routers with
Python 3 should run the tester and the page; the screen code is for the Slate 7's display.

The frame decoders (`pc_net.py`) and smart-device discovery (`pc_smart.py`) are copied from
[PorkChopCheck](https://github.com/turkey415/PorkChopCheck), so GL Probe reads a port the same way
the desktop app does. GL Probe started there, as its `router/` folder.

## The page

**https://192.168.8.1:8088** in Router mode, or the address on the screen's Mode page in Access point
mode. Plain `http://` on the same port is sent to `https://`. One page does everything; on a phone
the sidebar is a drawer (☰).

| Group | Page | What it does |
|---|---|---|
| Port | **Overview** | The verdict (worst finding first), switch and port from CDP/LLDP, link speed and duplex, VLANs, link drops, time to online, address and checks, DHCP servers and phone options, 802.1X, spanning tree, trunk, gateway MAC, IPv6 routers, broadcasts, events |
| | **Port log** | One row per switch port; save it with a seat label. **Send to GXL** sends labelled rows to a GXL Event Server. Download as CSV |
| Tests | **Ping** | Four pings a second, always running, with a 30 s / 5 min / 30 min graph and what ping did around every event |
| | **Tick test** | Game-rate UDP to a reflector, graded for Counter-Strike; and this router's own reflector |
| | **LAN speed** | iperf3 up and down to a server (GXL runs one on 5202, Perf-Deck on 5201) |
| | **Internet speed** | Cloudflare download and upload with latency under load (Probe Deck's) |
| | **Port finder** | Blinks the switch port's LED by bouncing the WAN link |
| Network | **Traceroute, Host scan, mDNS, Multicast, LAN cache, Wake** | Probe Deck's pages |
| Router | **Network mode** | Router or Access point, without a reset |
| | **Wi-Fi** | Change names and passwords, hide or show each network |
| | **Screen** | The router's screen, live, and whether GL Probe or GL.iNet draws it |
| System | **System stats** | CPU, temperature, memory, flash, interfaces, busiest processes (Probe Deck's) |
| | **Tailscale** | Probe Deck's Tailscale page: live map, armed switch, settings, connections, Headscale |
| | **HTTPS, Users** | The certificate (make one, upload your own, download it) and accounts |

Plugging into a new jack starts over: everything learned from the last port is forgotten.

## The screen

Pages: Summary, Switch, Port, Layer 2, Ping, Mode. Tap or swipe for the next page. **Hold 1.5 s** to
hand the screen to GL.iNet's own screen program (the Screen page brings it back). Every page shows the
mode in its top corner: grey `ROUTER`, blue `AP`, amber `> AP` while changing.

## Router or Access point

The router switches between **Router** and **Access point** mode without a reset, and keeps all its
settings and GL Probe. The change uses GL.iNet's own call, the one its Network Mode page makes, and
takes a few seconds; Wi-Fi drops briefly. Three ways to change it:

- **Side switch:** on = Access point, off = Router. The installer sets the switch to do this.
- **The screen:** hold the **Mode** page for 3 s (at 1.5 s it says "Keep holding").
- **The page:** Router › Network mode.

In **Access point** mode the WAN port joins the LAN, the router stops handing out addresses, and it
takes one from the network on WAN. 192.168.8.1 stops working: the page moves to that address (the
screen shows it). AP mode needs a cable in WAN. After a reboot the router keeps its mode: GL.iNet
replays the switch's position at boot, and GL Probe ignores that replay.

## Login and HTTPS

- **Certificate:** made on the router (openssl) on first start, naming the router, 192.168.8.1 and the
  WAN or AP address. Install it from System › HTTPS to stop the browser warning, make a new one, or
  upload your own (e.g. signed by your own CA). Files: `/etc/gl-probe/tls/`.
- **Login:** the first visit makes the admin account and asks for the router's own admin password
  (GL.iNet's) to prove you own it. Admins add users as admin or viewer. Viewers look and re-check the
  port; everything that changes the router is admin-only.
- **Locked out?** Over SSH: `PYTHONPATH=/usr/share/gl-probe python3 -m gl_probe.auth passwd NAME`
  (also `add NAME admin`, `del NAME`, `list`).

## Tailscale

GL.iNet's own Tailscale only runs in Router mode: its helper stops it on every network change in
Access point mode. So GL Probe runs the router's tailscaled itself as the service
`gl-probe-tailscale`, with its own state (`/etc/gl-probe/tailscale`), socket and port (41642), in
userspace networking. It works in both modes. Turn it on, log in and change everything from
System › Tailscale. Leave GL.iNet's own Tailscale off, or the router joins the tailnet twice.

## Installing

From this folder, on a PC that can SSH to the router as root (add the PC's key in LuCI:
System › Administration › SSH-Keys):

```
./install.sh root@192.168.8.1              # install, or update to this copy
./install.sh root@192.168.8.1 --uninstall  # remove it and give the screen back
```

It copies `pc_net.py`, `pc_smart.py`, `gl_probe/` and `netmode.lua` to `/usr/share/gl-probe`, adds the
services `gl-probe` and `gl-probe-tailscale` (off until turned on), installs `switch-netmode.sh` as
`/etc/gl-switch.d/netmode.sh` and points the side switch at it, and lists everything in
`/etc/sysupgrade.conf` so a firmware upgrade that keeps settings keeps GL Probe. Settings are in
`/etc/gl-probe/`. A router that ran PorkChopCheck's router tester is moved over: settings, users,
certificate, port log and Tailscale state.

## How it's built

- `gl_probe/service.py` runs the threads: the WAN's link and ethtool, a raw socket on the WAN with
  every frame through `pc_net.classify` (`tester.py` has the logic, no I/O), the DHCP client's status,
  gateway / DNS / internet checks, the screen and touch (`screen.py`, bitmap fonts made by
  `tools/make_font.py` from Noto Sans Mono, SIL Open Font License), ping, the port log, the network
  mode and the side switch, and the page (`web.py`).
- `netmode.lua` changes mode with `ubus call gl-session call` (module `netmode`, `set_mode`), inside
  GL.iNet's web server, wrapped in `flock`. `wifi.py` uses the same route for Wi-Fi.
- The page, `gl_probe/www/index.html`, is built by `tools/build_page.py ~/probe-deck`: Probe Deck's
  stylesheet, helpers, Wake and Tailscale code and views, its page scripts, GL Probe's own views
  (`tools/views.html`) and their script (`gl_probe/www/web/glp.js`).
- `gl_probe/deck/` has Probe Deck's backends, copied unchanged; `deckhost.py` gives them a "probe"
  built from the tester. They start the first time one of their pages opens.

Tests: `python3 tests/test_gl_probe.py` checks the logic with real-shaped CDP, LLDP, DHCP and 802.1X
frames, draws every screen page, and drives the page's API.
