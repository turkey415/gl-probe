"""The router's fan (the Slate 7 has one): live speed, and three ways to run it.

- auto:   GL.iNet's own gl_fan runs it, steering the CPU toward a target temperature (GL.iNet's
          setting, 75 °C out of the box; lower it and the fan comes on sooner).
- manual: gl_fan is stopped and GL Probe holds the speed you set, from 0 (off) to 100 %.
- boost:  full speed for a while, then back to whichever of the two was set.

The fan's level is /sys/class/thermal/cooling_device0/cur_state, 0 to the board's maximum
(/proc/gl-hw-info/fan_pwm_max, 155 on the Slate 7); it only turns from about 60. Whatever the setting,
GL Probe runs the fan flat out from SAFE_C up. When GL Probe stops, gl-probe.init starts gl_fan again.
"""

import glob
import os
import subprocess
import threading
import time

CUR = "/sys/class/thermal/cooling_device0/cur_state"
TEMP = "/sys/class/thermal/thermal_zone0/temp"
GL_INIT = "/etc/init.d/gl_fan"
MIN_LEVEL = 60       # below this the Slate 7's fan doesn't turn
SAFE_C = 85          # full speed from here, whatever the setting
BOOST_SECS = 600
KEEP = 300           # history points: 10 minutes at 2 s


def read(path, default=None):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return default


def num(path, scale=1, default=None):
    v = read(path)
    try:
        return int(v) / scale
    except (TypeError, ValueError):
        return default


class Fan:
    def __init__(self, service, gl_call=None, root=""):
        self.s = service
        self.gl_call = gl_call
        self.root = root  # tests point the sysfs paths at a folder
        self.lock = threading.Lock()
        self.hist = []
        self.owned = False  # True while GL Probe holds the fan (gl_fan stopped)
        self.error = None
        rpm = sorted(glob.glob(self.p("/sys/class/hwmon/hwmon*/fan1_input")))
        self.rpm_path = rpm[0] if rpm else None

    def p(self, path):
        return self.root + path

    def present(self):
        return os.path.exists(self.p(CUR)) and self.rpm_path is not None

    def max_level(self):
        return int(num(self.p("/proc/gl-hw-info/fan_pwm_max")) or num(self.p("/sys/class/thermal/cooling_device0/max_state")) or 255)

    def level_for(self, pct):
        """0 % is off; 1-100 % spreads over the levels where the fan actually turns."""
        pct = max(0, min(100, int(pct)))
        if pct == 0:
            return 0
        top = self.max_level()
        lo = min(MIN_LEVEL, top)
        return round(lo + (top - lo) * pct / 100)

    def pct_of(self, level):
        """The level as the page's 0-100 % (the inverse of level_for)."""
        if not level:
            return 0
        top = self.max_level()
        lo = min(MIN_LEVEL, top)
        return max(1, min(100, round(100 * (level - lo) / (top - lo)))) if top > lo else 100

    # ---------- settings (kept in config.json) ----------
    @property
    def mode(self):
        return self.s.config.get("fan_mode", "auto")

    def effective(self):
        return "boost" if self.s.config.get("fan_boost_until", 0) > time.time() else self.mode

    def gl_target(self):
        try:
            return int((self.gl_call("fan", "get_config") or {}).get("temperature")) if self.gl_call else None
        except (ValueError, TypeError):
            return None

    def set(self, body):
        if "target" in body:
            t = int(body["target"])
            if not 40 <= t <= 85:
                raise ValueError("The target temperature is 40-85 °C")
            self.gl_call("fan", "set_config", {"temperature": t, "warn_temperature": max(t, 75)})
        if "pct" in body:
            self.s.set_option("fan_pct", max(0, min(100, int(body["pct"]))))
        if "mode" in body:
            if body["mode"] not in ("auto", "manual"):
                raise ValueError("Mode is auto or manual")
            self.s.set_option("fan_mode", body["mode"])
        if "boost" in body:
            self.s.set_option("fan_boost_until", time.time() + BOOST_SECS if body["boost"] else 0)
        self.apply()
        return self.state()

    # ---------- driving it ----------
    def gl_running(self):
        return subprocess.run(["pidof", "gl_fan"], capture_output=True).returncode == 0

    def gl_fan(self, start):
        # by its init script, not pgrep/pkill: its stop does `kill -9 $(pgrep -f /usr/bin/gl_fan)`,
        # which would also hit any caller whose command line names that path
        subprocess.run([GL_INIT, "start" if start else "stop"], capture_output=True, timeout=15)

    def apply(self):
        if not self.present():
            return
        mode = self.effective()
        temp = num(self.p(TEMP), 1000)
        with self.lock:
            if mode == "auto":
                if self.owned or not self.gl_running():
                    self.gl_fan(True)
                    self.owned = False
                return
            if not self.owned or self.gl_running():
                self.gl_fan(False)
                self.owned = True
            level = self.max_level() if mode == "boost" else self.level_for(self.s.config.get("fan_pct", 50))
            if temp is not None and temp >= SAFE_C:
                level = self.max_level()
            try:
                with open(self.p(CUR), "w") as f:
                    f.write(str(level))
                self.error = None
            except OSError as e:
                self.error = f"can't set the fan: {e.strerror or e}"

    def loop(self, stop):
        while not stop.is_set():
            try:
                if self.present():
                    if self.s.config.get("fan_boost_until") and self.s.config["fan_boost_until"] <= time.time():
                        self.s.set_option("fan_boost_until", 0)  # boost is over
                    self.apply()
                    with self.lock:
                        self.hist.append([time.time(), num(self.rpm_path), num(self.p(TEMP), 1000), num(self.p(CUR))])
                        del self.hist[:-KEEP]
            except Exception as e:  # noqa: BLE001 - the fan loop must keep going
                self.error = str(e)
            stop.wait(2)

    def release(self):
        """Hand the fan back to GL.iNet (GL Probe is stopping)."""
        if self.owned:
            self.gl_fan(True)
            self.owned = False

    def state(self):
        if not self.present():
            return {"present": False}
        level, top = num(self.p(CUR)), self.max_level()
        with self.lock:
            hist = list(self.hist)
        return {"present": True, "mode": self.mode, "effective": self.effective(), "pct": self.s.config.get("fan_pct", 50),
                "level": level, "max": top, "pct_now": self.pct_of(level), "rpm": num(self.rpm_path),
                "temp": num(self.p(TEMP), 1000), "target": self.gl_target(), "gl_running": self.gl_running(),
                "boost_left": max(0, round(self.s.config.get("fan_boost_until", 0) - time.time())), "safe_c": SAFE_C,
                "min_level": MIN_LEVEL, "error": self.error, "hist": hist, "now": time.time()}  # fmt: skip
