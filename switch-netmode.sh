#!/bin/sh
# GL Probe: the side switch picks the network mode. Installed as /etc/gl-switch.d/netmode.sh,
# so GL.iNet's switch handler (/etc/rc.button/switch) runs it with "on" or "off".
#   on  = Access point
#   off = Router
# At boot GL.iNet replays the switch's position (with SERVICE set). That is ignored, so the router
# never changes mode on its own after a reboot: only a flip of the switch (or the screen) changes it.

[ -n "$SERVICE" ] && exit 0
[ "$1" = "on" ] && mode=ap || mode=router
logger -t gl-probe "side switch $1: $mode mode"
exec flock -n /var/lock/gl-probe-netmode.lock lua /usr/share/gl-probe/netmode.lua set "$mode"
