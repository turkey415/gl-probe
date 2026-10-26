#!/bin/sh
# Installs GL Probe on a GL.iNet router (tried on the GL-BE3600 Slate 7), from a PC that can SSH to it
# as root:
#
#   ./install.sh root@192.168.8.1            install, or update to this copy
#   ./install.sh root@192.168.8.1 --uninstall
#
# It copies pc_net.py, pc_smart.py, gl_probe/ and netmode.lua to /usr/share/gl-probe, adds the services
# gl-probe (the tester and its page) and gl-probe-tailscale (off until turned on from the page), sets
# the side switch to change the network mode (on = Access point, off = Router), and lists everything
# in /etc/sysupgrade.conf so a firmware upgrade that keeps settings keeps GL Probe too.
#
# A router that ran the PorkChopCheck router tester (pcc-router) is moved over: its settings, users,
# certificate, port log and Tailscale state go to /etc/gl-probe, and the old services are removed.
set -eu

HOST="${1:-}"
if [ -z "$HOST" ]; then
	echo "usage: ./install.sh root@ROUTER [--uninstall]" >&2
	exit 2
fi
cd "$(dirname "$0")"
SSH="ssh -o ConnectTimeout=10 $HOST"
KEEP="/usr/share/gl-probe/
/etc/gl-probe/
/etc/init.d/gl-probe
/etc/init.d/gl-probe-tailscale
/etc/gl-switch.d/netmode.sh
/etc/rc.d/S95gl-probe-tailscale
/etc/rc.d/S99gl-probe
/etc/rc.d/K10gl-probe"

if [ "${2:-}" = "--uninstall" ]; then
	$SSH 'set -e
		for s in gl-probe gl-probe-tailscale; do [ -x /etc/init.d/$s ] && { /etc/init.d/$s stop; /etc/init.d/$s disable; } || true; done
		rm -rf /usr/share/gl-probe /etc/gl-probe /etc/init.d/gl-probe /etc/init.d/gl-probe-tailscale /etc/gl-switch.d/netmode.sh
		[ "$(uci -q get switch-button.@main[0].func)" = netmode ] && { uci -q delete switch-button.@main[0].func; uci commit switch-button; } || true
		sed -i "/gl-probe/d; \#/etc/gl-switch.d/netmode.sh#d" /etc/sysupgrade.conf
		/etc/init.d/gl_screen start >/dev/null 2>&1 || true
		echo "GL Probe removed; the screen is GL.iNet'"'"'s again."'
	exit 0
fi

$SSH 'command -v python3 >/dev/null' || { echo "No python3 on the router." >&2; exit 1; }

# move a PorkChopCheck router tester over (it was the same program under another name)
$SSH 'set -e
	if [ -d /etc/pcc-router ] || [ -x /etc/init.d/pcc-router ]; then
		echo "Moving the PorkChopCheck router tester over to GL Probe..."
		for s in pcc-router pcc-tailscale; do [ -x /etc/init.d/$s ] && { /etc/init.d/$s stop >/dev/null 2>&1; /etc/init.d/$s disable; } || true; done
		ts_was_on=0; [ -e /etc/rc.d/S95pcc-tailscale ] && ts_was_on=1 || true
		if [ -d /etc/pcc-router ] && [ ! -d /etc/gl-probe ]; then mv /etc/pcc-router /etc/gl-probe; fi
		rm -rf /usr/share/pcc-router /etc/init.d/pcc-router /etc/init.d/pcc-tailscale /etc/pcc-router
		sed -i "/pcc-router/d; /pcc-tailscale/d" /etc/sysupgrade.conf
		uci -q delete firewall.pcc_reflector && uci commit firewall || true
		[ "$ts_was_on" = 1 ] && touch /etc/gl-probe/.tailscale-was-on || true
	fi'

echo "Copying to $HOST..."
tar --exclude=__pycache__ -cf - pc_net.py pc_smart.py netmode.lua gl_probe \
	| $SSH 'rm -rf /usr/share/gl-probe && mkdir -p /usr/share/gl-probe /etc/gl-probe && chmod 700 /etc/gl-probe && tar -C /usr/share/gl-probe -xf -'
$SSH 'cat > /etc/init.d/gl-probe && chmod 755 /etc/init.d/gl-probe' < gl-probe.init
$SSH 'cat > /etc/init.d/gl-probe-tailscale && chmod 755 /etc/init.d/gl-probe-tailscale' < gl-probe-tailscale.init
# the side switch: GL.iNet runs /etc/gl-switch.d/<func>.sh with on/off when it is flipped
$SSH 'mkdir -p /etc/gl-switch.d && cat > /etc/gl-switch.d/netmode.sh && chmod 755 /etc/gl-switch.d/netmode.sh
	if [ -f /proc/gl-hw-info/switch-button ]; then
		uci -q get switch-button.@main[0] >/dev/null || uci add switch-button main >/dev/null
		uci set switch-button.@main[0].func=netmode; uci -q delete switch-button.@main[0].sub_func; uci commit switch-button
	fi' < switch-netmode.sh
printf '%s\n' "$KEEP" | $SSH 'while read -r line; do grep -qxF "$line" /etc/sysupgrade.conf || echo "$line" >> /etc/sysupgrade.conf; done'
$SSH '/etc/init.d/gl-probe enable && /etc/init.d/gl-probe restart
	if [ -e /etc/gl-probe/.tailscale-was-on ]; then rm -f /etc/gl-probe/.tailscale-was-on; /etc/init.d/gl-probe-tailscale enable; /etc/init.d/gl-probe-tailscale start; fi'
echo "Installed. Open https://192.168.8.1:8088 from the router's Wi-Fi (or the address on the screen's Mode page)."
echo "The first visit makes the admin account; it asks for the router's admin password."
