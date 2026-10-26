"""Probe Deck's tools in GL Probe: traceroute, host scan, mDNS, multicast, LAN cache, internet speed,
Wake, system stats and Tailscale.

The backends in deck/ are Probe Deck's own (appbase, mtr, wire, hosts, cache, inet, stats, wake,
tailscale), copied unchanged. They expect a "probe" object; Probe below is that, built from what the
router's tester already knows. Their pages are in www/index.html, built by tools/build_page.py.

The tools start the first time one of their pages is opened, so a router nobody looks at does no
extra work. Settings and history live in /etc/gl-probe/deck/ (small files, written only on changes).
Tailscale is GL Probe's own tailscaled on the router (service gl-probe-tailscale), see RouterTailscale.
"""

import ipaddress
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time

DECK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "deck")
if DECK not in sys.path:
    sys.path.insert(0, DECK)

import appbase  # noqa: E402  (Probe Deck's, from deck/)
import cache as cache_mod  # noqa: E402
import hosts as hosts_mod  # noqa: E402
import inet as inet_mod  # noqa: E402
import mtr as mtr_mod  # noqa: E402
import stats as stats_mod  # noqa: E402
import tailscale as ts_mod  # noqa: E402
import wake as wake_mod  # noqa: E402
import wire as wire_mod  # noqa: E402

OUI_URL = "https://standards-oui.ieee.org/oui/oui.csv"
APPS = [wire_mod.Wire, wire_mod.Mdns, wire_mod.Multicast, mtr_mod.Mtr, hosts_mod.HostScan, cache_mod.LanCache,
        inet_mod.Inet, stats_mod.Stats]  # fmt: skip


class Watch:
    """The bits of Probe Deck's Watchdog the borrowed pages read."""

    dtp = None

    def __init__(self, probe):
        self.p = probe

    @property
    def iface(self):
        return self.p.l3()

    @property
    def gw_mac(self):
        return (self.p.s.tester.snapshot().get("l2") or {}).get("gateway_mac")

    def seen_hosts(self, n):
        return []


class Probe:
    """What Probe Deck's add-ons expect from the probe, from the router's tester."""

    def __init__(self, service, conf_dir):
        self.s = service
        self.conf_dir = conf_dir
        self.conf_file = os.path.join(conf_dir, "deck.json")
        self.conf = {"wol_stagger": 2.0, "ts_geoip": False, **appbase.load_json(self.conf_file, {})}
        self.apps, self.peers, self.netmap, self.wake = {}, {}, None, None
        self.lock = threading.Lock()
        self.watch = Watch(self)

    def l3(self):
        """The interface that holds the router's own address on the tested network."""
        return "br-lan" if self.s.netmode.get("mode") == "ap" else self.s.iface

    @property
    def net(self):
        w = self.s.tester.wan
        out = {"ip": w.get("address"), "prefix": w.get("mask"), "gateway": w.get("gateway"), "dns": list(w.get("dns") or []),
               "iface": self.l3()}  # fmt: skip
        if out["ip"] and out["prefix"]:
            out["broadcast"] = str(ipaddress.ip_network(f"{out['ip']}/{out['prefix']}", strict=False).broadcast_address)
        servers = (self.s.tester.snapshot().get("dhcp") or {}).get("servers") or []
        out["dhcp"] = {"server": servers[0]} if servers else {}
        return out

    @property
    def link(self):
        return {"up": bool(self.s.tester.link.get("up"))}

    @property
    def neighbor(self):
        sw = self.s.tester.snapshot().get("switch") or {}
        return {"port": sw.get("port"), "switch": sw.get("name")} if sw.get("heard") else None

    @property
    def speed(self):
        try:
            return {"running": bool(self.s.speed.state().get("running"))}
        except AttributeError:
            return {}

    def save_conf(self, new):
        with self.lock:
            self.conf.update(new)
            appbase.save_json(self.conf_file, self.conf, private=True)


TS_NAME = "gl-probe-tailscale"
TS_SOCK = "/var/run/gl-probe-tailscale/tailscaled.sock"
TS_INIT = "/etc/init.d/" + TS_NAME


class RouterTailscale(ts_mod.Tailscale):
    """Probe Deck's Tailscale page on GL Probe's own Tailscale (service gl-probe-tailscale).

    GL.iNet's Tailscale only runs in Router mode: its helper stops it on every network change in
    Access point mode. So GL Probe runs the router's tailscaled itself, with its own state
    (/etc/gl-probe/tailscale), socket and port, in userspace networking (no tun device, nothing GL.iNet
    cleans up). It works in both modes. Leave GL.iNet's own Tailscale off, or the router joins twice.
    """

    def __init__(self, probe):
        ts_mod.SOCK = TS_SOCK  # the borrowed module talks to this tailscaled
        super().__init__(probe)

    def installed(self):
        return os.path.exists("/usr/sbin/tailscaled") and os.path.exists(TS_INIT)

    @staticmethod
    def init(*args):
        return subprocess.run([TS_INIT, *args], capture_output=True, text=True, timeout=30)

    def service(self):
        enabled = self.init("enabled").returncode == 0
        active = os.path.exists(TS_SOCK) and "running" in self.init("status").stdout
        return {"enabled": enabled, "active": active, "state": "active" if active else "inactive"}

    def action(self, body):
        if body.get("action") == "service":
            on = bool(body.get("on"))
            for step in (("enable", "start") if on else ("stop", "disable")):
                r = self.init(step)
                if r.returncode and step in ("start", "stop"):
                    raise ValueError((r.stderr.strip().splitlines() or [f"{step} failed"])[-1][:200])
            if on:
                for _ in range(20):  # wait for its socket, so the page shows it at once
                    if os.path.exists(TS_SOCK):
                        break
                    time.sleep(0.5)
            return
        super().action(body)

    @staticmethod
    def forwarding():
        pass  # userspace networking forwards subnet and exit-node traffic itself

    def snapshot(self, client_ip=""):
        out = super().snapshot(client_ip)
        out["forwarding"] = True
        out["gl_on"] = subprocess.run(["uci", "-q", "get", "tailscale.settings.enabled"], capture_output=True, text=True).stdout.strip() == "1"
        if out["gl_on"]:
            out.setdefault("health", []).insert(0, "GL.iNet's own Tailscale is on too, so the router may show up twice on your tailnet. Turn it off in GL.iNet's admin page.")
        return out


class Deck:
    def __init__(self, service, conf_dir):
        self.s = service
        self.conf_dir = os.path.join(conf_dir, "deck")
        os.makedirs(self.conf_dir, exist_ok=True)
        self.p = Probe(service, self.conf_dir)
        self.started = False
        self.lock = threading.Lock()
        self.ts = None
        self.ts_at, self.ts_dot = 0, None
        hosts_mod.IEEE = os.path.join(conf_dir, "ieee-data")

    # ---------- starting on first use ----------
    def start(self):
        with self.lock:
            if self.started:
                return
            self.started = True
        p = self.p
        p.wake = wake_mod.Wake(p, p.l3(), self.conf_dir)
        for cls in APPS:
            try:
                app = cls(p, self.conf_dir, self.conf_dir)
                if cls is hosts_mod.HostScan or cls is cache_mod.LanCache:
                    if not os.path.exists(app.conf_file):  # on a router: scan when asked, not every few minutes
                        app.conf["every"] = 0
                p.apps[app.name] = app
            except Exception as e:  # noqa: BLE001 - one broken tool shouldn't take the rest down
                print(f"deck: {cls.__name__} didn't start: {e}", flush=True)
        for app in p.apps.values():
            threading.Thread(target=app.start, daemon=True, name="deck-" + app.name).start()
        threading.Thread(target=self.fetch_ouis, daemon=True).start()

    def tailscale(self):
        if not self.ts:
            self.ts = RouterTailscale(self.p)
        return self.ts

    def fetch_ouis(self):
        """Makers for the host scan: IEEE's list, downloaded once (about 3 MB)."""
        d = hosts_mod.IEEE
        if os.path.exists(os.path.join(d, "oui.csv")):
            return
        for _ in range(20):
            if self.p.net.get("ip"):
                break
            time.sleep(15)
        os.makedirs(d, exist_ok=True)
        tmp = os.path.join(d, "oui.csv.tmp")
        r = subprocess.run(["curl", "-fsSL", "-m", "120", "-o", tmp, OUI_URL], capture_output=True)
        if r.returncode == 0 and os.path.getsize(tmp) > 100_000:
            os.replace(tmp, os.path.join(d, "oui.csv"))
            app = self.p.apps.get("hosts")
            if app:
                app.ouis = None  # reload
        elif os.path.exists(tmp):
            os.remove(tmp)

    def on_mode_change(self):
        """The router changed mode: the tested network is on another interface now."""
        w = self.p.apps.get("wire")
        if w and w.sock:
            try:
                w.sock.close()  # its loop reopens on the new interface
            except OSError:
                pass
        if self.p.wake:
            self.p.wake.iface = self.p.l3()

    # ---------- the page's requests ----------
    def state(self, user):
        """The sidebar lights and Wake's list. The tools themselves start when one of their pages opens."""
        p = self.p
        apps = {}
        for k, a in p.apps.items():
            try:
                apps[k] = a.status()
            except Exception:  # noqa: BLE001
                apps[k] = None
        if time.time() - self.ts_at > 30:  # Tailscale's light: asked every 30 s, not every poll
            self.ts_at = time.time()
            try:
                ts = self.tailscale().snapshot().get("state")
                self.ts_dot = {"dot": "on" if ts == "Running" else "warn" if ts == "NeedsLogin" else ""}
            except Exception:  # noqa: BLE001
                self.ts_dot = None
        if self.ts_dot:
            apps["ts"] = self.ts_dot
        try:
            temp = round(int(open("/sys/class/thermal/thermal_zone0/temp").read()) / 1000, 1)
        except (OSError, ValueError):
            temp = None
        from . import __version__
        return {"version": __version__, "name": socket.gethostname(), "ip": p.net.get("ip"), "mode": self.s.netmode.get("mode"), "link": p.link,
                "temp": temp, "apps": apps, "wol": p.wake.snapshot() if p.wake else {"hosts": [], "job": None, "stagger": p.conf.get("wol_stagger", 2), "seen": []}, "watch": None, "me": user}  # fmt: skip

    def app_get(self, name, sub, arg, query, user):
        self.start()
        app = self.p.apps.get(name)
        if not app:
            raise LookupError(name)
        return app.get(sub, arg, query, user)

    def app_post(self, name, action, body, user):
        self.start()
        app = self.p.apps.get(name)
        if not app:
            raise LookupError(name)
        if user["role"] != "admin" and action not in app.VIEWER_POST:
            raise PermissionError("Admins only: you're logged in as a viewer")
        return app.post(action, body, user)

    def wol(self, action, body):
        self.start()
        w = self.p.wake
        if action == "save":
            return {"id": w.upsert(body)}
        if action == "delete":
            w.delete(str(body.get("id")))
        elif action == "import":
            return w.import_text(body.get("text", ""))
        elif action == "wake":
            ids = body.get("ids")
            if ids is not None and not (isinstance(ids, list) and all(isinstance(x, str) for x in ids)):
                raise ValueError("Bad ids")
            w.wake(ids=ids, mac=body.get("mac"))
        elif action == "stop":
            w.stop()
        else:
            raise LookupError(action)
        return {}

    def settings(self, body):
        if "wol_stagger" in body:
            v = float(body["wol_stagger"])
            if not 0 <= v <= 60:
                raise ValueError("Stagger is 0-60 s")
            self.p.save_conf({"wol_stagger": v})
        return {}
