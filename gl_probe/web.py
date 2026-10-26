"""GL Probe's page and API: https://192.168.8.1:8088 in Router mode, or the address the screen's Mode
page shows in Access point mode. One page in Probe Deck's look (www/index.html, built by
tools/build_page.py) does everything, behind a login.

One port speaks both: a browser that starts TLS gets HTTPS, and plain http:// is sent to https://.
The certificate is made on the router (tls.py) and can be replaced from the HTTPS page. Logins and
users work like Probe Deck's (auth.py): admins change things, viewers look.

Open without a login:
GET /, /web/<page>.js, /vendor/us-map.json   (the page shows the login itself)
GET /api/auth/me      who is logged in, and whether the first admin still has to be made
POST /api/auth/login {"name", "password"}, /api/auth/setup {"name", "password", "owner"}, /api/auth/logout

Logged in:
GET /api/state, /api/tools?span=30, /api/wifi, /api/tls, /cert.pem, /ports.csv, /api/gxl, /api/screen.bmp
GET /api/deck/state, /api/x/<tool>[/<sub>[/<arg>]], /api/tailscale   (Probe Deck's tools, deckhost.py)
POST /api/recheck, /api/auth/password {"current", "new"}   (viewers too)
POST /api/x/<tool>/<action>   (admins, or what that tool lets viewers do)
Admins only:
POST /api/screen {"mode": "probe" | "gl"}, /api/netmode {"mode": "router" | "ap"},
     /api/wifi {"id", "ssid", "key", "hidden"} (any of them; left out = unchanged),
     /api/ping, /api/tick, /api/reflector, /api/speed, /api/blink, /api/log,
     /api/tls/generate {"names", "days"}, /api/tls/upload {"cert", "key"},
     /api/gxl/settings {"url", "key"}, /api/gxl/send, /api/wol/<action>, /api/settings, /api/tailscale
GET /api/users; POST /api/users {"action": "add" | "role" | "password" | "delete", "name", "role", "password"}

In Router mode GL.iNet's firewall keeps this port closed on the WAN side, so only the router's own
Wi-Fi and LAN reach it. In Access point mode there is no WAN side: the page is open to the network
on WAN, which is why it has a login.
"""

import json
import os
import re
import socket
import struct
import ssl
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

APP_RE = re.compile(r"/api/x/([a-z]+)(?:/([a-z_]+))?(?:/([^/]+))?$")

OPEN_GET = ("/", "/index.html", "/api/auth/me")
OPEN_POST = ("/api/auth/login", "/api/auth/setup", "/api/auth/logout")
VIEWER_POST = ("/api/recheck", "/api/auth/password")
MAX_BODY = 256 * 1024
WWW = os.path.join(os.path.dirname(os.path.abspath(__file__)), "www")
STATIC = {"/": ("index.html", "text/html; charset=utf-8"), "/index.html": ("index.html", "text/html; charset=utf-8"),
          "/vendor/us-map.json": ("vendor/us-map.json", "application/json")}


def static_file(path):
    """The page, its scripts and the map: only these, from www/."""
    if path in STATIC:
        rel, kind = STATIC[path]
    elif re.fullmatch(r"/web/[a-z]+\.js", path):
        rel, kind = path[1:], "text/javascript; charset=utf-8"
    else:
        return None, None
    try:
        with open(os.path.join(WWW, rel), "rb") as f:
            return f.read(), kind
    except OSError:
        return None, None


def screen_bmp(fb="/dev/fb0", w=284, h=76):
    """The router's screen as a 24-bit BMP (browsers show BMP; no image library needed). The
    framebuffer is 76 x 284 RGB565, drawn a quarter turn round, as screen.py writes it."""
    with open(fb, "rb") as f:
        raw = f.read(w * h * 2)
    row = (w * 3 + 3) & ~3
    out = bytearray(row * h)
    for y in range(h):
        o = (h - 1 - y) * row  # BMP rows go bottom up
        for x in range(w):
            i = ((w - 1 - x) * h + y) * 2
            v = raw[i] | raw[i + 1] << 8 if i + 1 < len(raw) else 0
            out[o + x * 3:o + x * 3 + 3] = bytes(((v & 31) << 3, ((v >> 5) & 63) << 2, (v >> 11) << 3))  # B, G, R
    head = struct.pack("<2sIHHI", b"BM", 54 + len(out), 0, 0, 54) + struct.pack("<IiiHHIIiiII", 40, w, h, 1, 24, 0, len(out), 2835, 2835, 0, 0)
    return head + bytes(out)


def tools_state(service, span):
    return {
        "ping": service.pinger.state(span, service.tester.snapshot()["events"]),
        "tick": service.tick.state(), "reflector": service.reflector.state(), "speed": service.speed.state(),
        "blink": service.blink.state(), "log": service.log.list(),
        "options": {k: service.config.get(k) for k in ("ping_target", "tick_server", "iperf_server", "iperf_port")},
    }  # fmt: skip


def make_handler(service):
    class Handler(BaseHTTPRequestHandler):
        server_version = "GL-Probe"
        timeout = 60

        def log_message(self, *args):  # quiet: procd keeps the log small
            pass

        @property
        def is_tls(self):
            return isinstance(self.connection, ssl.SSLSocket)

        def _send(self, code, body, kind="application/json", headers=()):
            data = body if isinstance(body, bytes) else body.encode()
            self.send_response(code)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            for k, v in headers:
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def _json(self, code, obj, headers=()):
            self._send(code, json.dumps(obj, default=str), headers=headers)

        def _to_https(self):
            """Plain http:// while HTTPS works: send the browser to https:// on the same port."""
            tls = getattr(service, "tls", None)
            if self.is_tls or not tls or not tls.ctx:
                return False
            host = self.headers.get("Host") or f"{self.server.server_address[0]}:{self.server.server_address[1]}"
            body = b"Moved to HTTPS"
            self.send_response(308)
            self.send_header("Location", f"https://{host}{self.path}")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return True

        def _user(self):
            return service.auth.user(self.headers)

        def do_GET(self):
            if self._to_https():
                return
            url = urlparse(self.path)
            if url.path in ("/deck", "/deck/"):  # the old address of the tools page
                self.send_response(308)
                self.send_header("Location", "/")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            data, kind = static_file(url.path)
            if data is not None:
                return self._send(200, data, kind)
            deck = getattr(service, "deck", None)
            user = self._user()
            if url.path == "/api/auth/me":
                return self._json(200, {"user": user, "setup": service.auth.needs_setup()})
            if not user:
                return self._json(401, {"error": "log in first", "login": True})
            if url.path == "/api/tools":
                try:
                    span = int(parse_qs(url.query).get("span", ["30"])[0])
                except ValueError:
                    span = 30
                return self._json(200, tools_state(service, max(10, min(span, 1800))))
            if url.path == "/api/wifi":
                try:
                    nets, err = service.wifi.networks(), None
                except ValueError as e:
                    nets, err = [], str(e)
                return self._json(200, {"networks": nets, "error": err, "save": service.wifi.state})
            if url.path == "/api/tls":
                return self._json(200, service.tls.info() or {"error": service.tls.error or "no certificate"})
            if url.path == "/cert.pem":
                try:
                    data = service.tls.cert.read_bytes()
                except OSError:
                    return self._json(404, {"error": "no certificate"})
                return self._send(200, data, "application/x-pem-file", [("Content-Disposition", 'attachment; filename="gl-probe.pem"')])
            if url.path == "/api/users":
                if user["role"] != "admin":
                    return self._json(403, {"error": "Admins only"})
                return self._json(200, {"users": service.auth.listing(), "me": user["name"]})
            if url.path == "/api/screen.bmp":
                try:
                    return self._send(200, screen_bmp(), "image/bmp")
                except OSError:
                    return self._json(404, {"error": "no screen"})
            if url.path == "/api/gxl" and getattr(service, "gxl", None):
                return self._json(200, service.gxl.state())
            if url.path == "/ports.csv":
                return self._send(200, service.log.csv_text().encode(), "text/csv", [("Content-Disposition", 'attachment; filename="ports.csv"')])
            if deck and url.path == "/api/deck/state":
                return self._json(200, deck.state(user))
            if deck and url.path == "/api/tailscale":
                return self._json(200, deck.tailscale().snapshot(self.client_address[0]))
            m = APP_RE.match(url.path)
            if deck and m:
                try:
                    out = deck.app_get(m.group(1), m.group(2), m.group(3), {k: v[0] for k, v in parse_qs(url.query).items()}, user)
                except LookupError:
                    return self._json(404, {"error": "not found"})
                except ValueError as e:
                    return self._json(400, {"error": str(e)})
                if hasattr(out, "body"):  # a download (appbase.Reply)
                    return self._send(out.code, out.body if isinstance(out.body, bytes) else str(out.body).encode(), out.ctype, out.headers)
                return self._json(200, out)
            if url.path == "/api/state":
                snap = service.screen_snap()
                snap["screen"] = service.config["screen"]
                snap["host"] = socket.gethostname()
                snap["page"] = service.page
                return self._json(200, snap)
            self._json(404, {"error": "not found"})

        def do_POST(self):
            if self._to_https():
                return
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                return self._json(413, {"error": "too big"})
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                return self._json(400, {"error": "not JSON"})
            if not isinstance(body, dict):
                return self._json(400, {"error": "not JSON"})
            # forms on other sites can't send JSON without asking first, so this stops them posting here
            if "application/json" not in (self.headers.get("Content-Type") or ""):
                return self._json(415, {"error": "send JSON"})
            ip = self.client_address[0]
            try:
                if self.path in OPEN_POST:
                    return self._auth(body, ip)
                user = self._user()
                if not user:
                    return self._json(401, {"error": "log in first", "login": True})
                if self.path not in VIEWER_POST and user["role"] != "admin" and not self.path.startswith("/api/x/"):
                    return self._json(403, {"error": "Admins only: you're logged in as a viewer"})
                return self._post(body, user)
            except PermissionError as e:
                return self._json(403, {"error": str(e)})
            except (ValueError, OSError) as e:
                return self._json(400, {"error": str(e) or "could not do that"})

        def _auth(self, body, ip):
            au = service.auth
            if self.path == "/api/auth/logout":
                au.logout(self.headers)
                return self._json(200, {"ok": True}, [("Set-Cookie", au.cookie(None, self.is_tls))])
            if self.path == "/api/auth/setup":
                tok = au.setup(body.get("name"), body.get("password"), body.get("owner"), ip)
            else:
                tok = au.login(body.get("name"), body.get("password"), ip)
            return self._json(200, {"ok": True}, [("Set-Cookie", au.cookie(tok, self.is_tls))])

        def _post(self, body, user):
            if self.path == "/api/recheck":
                threading.Thread(target=service.dhcp_probe, daemon=True).start()
                service.recheck.set()
                return self._json(200, {"ok": True})
            if self.path == "/api/auth/password":
                service.auth.change_own(user["name"], body.get("current"), body.get("new"), service.auth.token(self.headers))
                return self._json(200, {"ok": True})
            if self.path == "/api/screen":
                try:
                    service.set_screen(body.get("mode"))
                except ValueError:
                    return self._json(400, {"error": "mode is probe or gl"})
                return self._json(200, {"screen": service.config["screen"]})
            if self.path == "/api/netmode":
                service.set_netmode(body.get("mode"))
                return self._json(200, {"ok": True})
            if self.path == "/api/wifi":
                hidden = body.get("hidden")
                service.wifi.change(str(body.get("id") or ""), body.get("ssid"), str(body.get("key") or ""),
                                    None if hidden is None else bool(hidden))
                return self._json(200, {"ok": True})
            if self.path == "/api/tls/generate":
                service.tls.generate(body.get("names") or ", ".join(service.tls.default_names()), body.get("days") or 3650)
                return self._json(200, service.tls.info() or {})
            if self.path == "/api/tls/upload":
                service.tls.upload(body.get("cert"), body.get("key"))
                return self._json(200, service.tls.info() or {})
            deck = getattr(service, "deck", None)
            m = APP_RE.match(self.path)
            if deck and m and m.group(2):
                try:
                    return self._json(200, deck.app_post(m.group(1), m.group(2), body, user) or {})
                except LookupError:
                    return self._json(404, {"error": "not found"})
            if deck and self.path.startswith("/api/wol/"):
                try:
                    return self._json(200, deck.wol(self.path[len("/api/wol/"):], body) or {})
                except LookupError:
                    return self._json(404, {"error": "not found"})
            if deck and self.path == "/api/settings":
                return self._json(200, deck.settings(body))
            if deck and self.path == "/api/tailscale":
                ts = deck.tailscale()
                if body.get("action") == "cert":
                    service.tls.generate(ts.cert_names(service.tls))
                else:
                    ts.action(body)
                return self._json(200, {"ok": True})
            if self.path == "/api/gxl/settings":
                return self._json(200, service.gxl.settings(body))
            if self.path == "/api/gxl/send":
                return self._json(200, service.gxl.send())
            if self.path == "/api/users":
                au, act, name = service.auth, body.get("action"), str(body.get("name") or "")
                if act == "add":
                    au.add(name, body.get("role") or "viewer", body.get("password"))
                elif act == "role":
                    au.update(name, role=body.get("role"))
                elif act == "password":
                    au.update(name, pw=body.get("password"))
                elif act == "delete":
                    au.delete(name, user["name"])
                else:
                    raise ValueError("Unknown action")
                return self._json(200, {"users": au.listing(), "me": user["name"]})
            return self._tool(body)

        def _tool(self, body):
            src = service.tester.wan.get("address")
            if self.path == "/api/ping":
                service.set_option("ping_target", str(body.get("target") or "gateway").strip()[:120])
            elif self.path == "/api/tick":
                if body.get("action") == "stop":
                    service.tick.stop()
                else:
                    server = str(body.get("server") or "").strip()
                    if not server:
                        raise ValueError("Enter the reflector's address")
                    if not src:
                        raise ValueError("No address on the WAN yet")
                    service.set_option("tick_server", server)
                    service.tick.start(src, server, int(body.get("rate") or 64), int(body.get("secs") or 30))
            elif self.path == "/api/reflector":
                service.reflector.set(bool(body.get("on")))
            elif self.path == "/api/speed":
                server, port = str(body.get("server") or "").strip(), int(body.get("port") or 5201)
                if not server:
                    raise ValueError("Enter the iperf3 server's address")
                if not src:
                    raise ValueError("No address on the WAN yet")
                service.set_option("iperf_server", server)
                service.set_option("iperf_port", port)
                service.speed.start(src, server, port)
            elif self.path == "/api/blink":
                service.blink.set(bool(body.get("on")))
            elif self.path == "/api/log":
                return self._json(200, service.log.save(service.tester.snapshot(), str(body.get("label") or "")))
            else:
                return self._json(404, {"error": "not found"})
            self._json(200, {"ok": True})

    return Handler


class Server(ThreadingHTTPServer):
    """HTTP and HTTPS on one port: a connection that opens with a TLS handshake (first byte 0x16) is
    wrapped in TLS, anything else is plain HTTP (and gets sent to https:// by the handler)."""

    daemon_threads = True

    def __init__(self, addr, handler, tls=None):
        super().__init__(addr, handler)
        self.tls = tls

    def finish_request(self, request, client_address):
        ctx = self.tls.ctx if self.tls else None
        wrapped = None
        if ctx:
            try:
                request.settimeout(10)
                if request.recv(1, socket.MSG_PEEK) == b"\x16":
                    wrapped = request = ctx.wrap_socket(request, server_side=True)
                request.settimeout(None)
            except (OSError, ssl.SSLError):
                return  # e.g. a browser that hasn't accepted the self-signed certificate yet
        try:
            super().finish_request(request, client_address)
        finally:
            if wrapped:
                try:
                    wrapped.close()
                except OSError:
                    pass


def serve(service, port):
    Server(("0.0.0.0", port), make_handler(service), getattr(service, "tls", None)).serve_forever()
