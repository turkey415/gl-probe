'use strict';
// GL Probe's own pages: Overview, Port log, Network mode, Wi-Fi, Ping, Tick test, LAN speed, Port finder,
// Screen, HTTPS, Users. Uses Probe Deck's helpers ($, esc, setHTML, setSeg, api, flash, Chart, legend…).
// The page glue (index.html) polls /api/state into S and calls GLP.render(S).
window.GLP = (() => {
  const kv = rows => rows.filter(Boolean).map(([k, v, cls, t]) => `<div${t ? ` title="${esc(t)}"` : ''}><dt>${esc(k)}</dt><dd${cls ? ` class="${cls}"` : ''}>${esc(v ?? '—')}</dd></div>`).join('');
  const short = p => (p || '?').replace(/^GigabitEthernet/, 'Gi').replace(/^FastEthernet/, 'Fa').replace(/^TenGigabitEthernet/, 'Te').replace(/^TwentyFiveGigE/, 'Twe');
  const MODES = { router: 'Router', ap: 'Access point' };
  const VC = { good: 'on', warn: 'warn', bad: 'err' };
  const ms = c => !c ? ['…', ''] : c.ok ? [c.ms != null ? (c.ms < 1 ? '<1' : c.ms.toFixed(1)) + ' ms' : 'ok', 'ok'] : ['no answer', 'bad'];
  const time = t => new Date(t * 1000).toLocaleTimeString([], { hour12: false });
  const msg = (id, text, ok) => flash($(id), text, ok);
  async function act(path, body, out, okText) {
    try { const r = await api(path, body); if (out && okText) msg(out, okText, true); return r || {}; }
    catch (e) { if (out) msg(out, e.message); else alert(e.message); return null; }
  }

  // ---------- overview ----------
  function renderPort(s) {
    const sw = s.switch, lk = s.link, w = s.wan || {}, t = s.timing || {}, l2 = s.l2, o = s.dhcp.options || {};
    $('#gp-lamp').innerHTML = `<span class="dot ${VC[s.verdict] || ''}"></span>${esc(s.findings[0][1])}`;
    $('#gp-wport').classList.toggle('off', !sw.heard);
    $('#gp-port').textContent = sw.heard ? short(sw.port) : lk.up ? '—' : 'NO LINK';
    $('#gp-switch').textContent = sw.heard ? sw.name || '?' : lk.up ? 'Waiting for CDP / LLDP (the switch sends one every 30 to 60 s)' : 'Plug the WAN port into a jack';
    $('#gp-plat').textContent = sw.heard ? [sw.platform, sw.mgmt_ip].filter(Boolean).join(' · ') : '';
    setSeg('#gp-speed', lk.up && lk.speed ? lk.speed : '----', 5); $('#gp-wlink').classList.toggle('off', !lk.up);
    $('#gp-dup').textContent = lk.up ? `Mbps ${lk.duplex || ''}${lk.downshift ? ` · both ends can do ${lk.downshift / 1000} G: check the cable` : ''}` : 'no link';
    $('#gp-wlink').classList.toggle('alarm', !!lk.downshift || (lk.up && /half/i.test(lk.duplex || '')));
    setSeg('#gp-vlan', sw.vlan != null ? sw.vlan : '----', 4); $('#gp-wvlan').classList.toggle('off', sw.vlan == null);
    $('#gp-vlan2').textContent = sw.voice_vlan ? `voice ${sw.voice_vlan}` : sw.vlan_name || (sw.vlan != null ? 'native' : '—');
    setSeg('#gp-drops', lk.drops ?? 0, 3); $('#gp-wdrops').classList.toggle('alarm', lk.drops > 0);
    setSeg('#gp-online', t.gateway != null ? Math.round(t.gateway) : '--', 3); $('#gp-wonline').classList.toggle('off', t.gateway == null);
    $('#gp-wonline').classList.toggle('alarm', t.gateway > 25);
    $('#gp-online2').textContent = t.gateway != null ? `s · address in ${t.address ?? '-'} s` : 'seconds to the gateway';
    const bad = s.findings.filter(f => f[0] !== 'good');
    $('#gp-verdict').hidden = !bad.length;
    $('#gp-verdict').className = 'note' + (s.verdict === 'bad' ? ' crit' : '');
    setHTML('#gp-verdict', bad.map(f => `<div>${esc(f[1])}</div>`).join(''));
    $('#gp-heard').textContent = sw.heard ? 'heard by ' + sw.protocols.join(' + ') : '';
    setHTML('#gp-sw', sw.heard ? kv([['Switch', sw.name], ['Port', sw.port], ['VLAN', (sw.vlan ?? '-') + (sw.vlan_name ? ` (${sw.vlan_name})` : '')], ['Voice VLAN', sw.voice_vlan],
      ['Model', sw.platform], ['Management IP', sw.mgmt_ip], ['PoE', sw.poe], ['Duplex (switch)', sw.duplex]]) : '<div><dd class="sub">No CDP or LLDP heard yet.</dd></div>');
    const [g, gc] = ms(s.checks.gateway), [d, dc] = ms(s.checks.dns), [i, ic] = ms(s.checks.internet);
    setHTML('#gp-net', kv([['Address', w.address ? `${w.address}/${w.mask}` : 'none', w.address ? '' : 'bad'], ['Gateway', `${w.gateway || '-'} · ${g}`, gc],
      ['DNS', `${(w.dns || []).join(', ') || '-'} · ${d}`, dc], ['Internet', i, ic], ['Public IP', s.public_ip], ['Domain', o.domain || w.domain],
      ['Lease', o.lease ? Math.round(o.lease / 60) + ' min' : null]]));
    const stp = l2.stp;
    setHTML('#gp-l2', kv([['DHCP servers', s.dhcp.servers.join(', ') || '-', s.dhcp.servers.length > 1 ? 'bad' : ''],
      ['Phone options', [o.tftp_ips && '150: ' + o.tftp_ips.join(', '), o.tftp_name && '66: ' + o.tftp_name, o.opt43 && '43: ' + o.opt43].filter(Boolean).join(' · ') || 'none'],
      ['802.1X', l2.dot1x ? 'switch asks for a login' : 'none seen', l2.dot1x ? 'warn' : ''],
      ['Spanning tree', stp ? `${stp.proto} root ${stp.root_mac}${stp.vlan ? ' vlan ' + stp.vlan : ''}${stp.role ? ' · ' + stp.role : ''}` : 'none seen'],
      ['STP changes', l2.stp_changes, l2.stp_changes > 5 ? 'warn' : ''], ['Trunk (DTP)', l2.dtp ? `${l2.dtp.oper} (${l2.dtp.admin})` : '-'],
      ['VLAN tags seen', l2.vlans_tagged.join(', ') || 'none'], ['Gateway MAC', (l2.gateway_mac || '-') + (l2.gateway_kind ? ' · ' + l2.gateway_kind : '')],
      ['IPv6 routers', l2.ipv6_routers.join(', ') || 'none', l2.ipv6_routers.length > 1 ? 'warn' : ''],
      ['Broadcasts per second', l2.broadcasts_per_s, l2.broadcasts_per_s > 50 ? 'warn' : '']]));
    setHTML('#gp-events', s.events.slice().reverse().map(e => `<div class="ev"><span class="sub mono">${time(e.t)}</span><span class="dot ${e.sev === 'bad' ? 'err' : e.sev === 'warn' ? 'warn' : 'on'}"></span><span>${esc(e.text)}</span></div>`).join('')
      || '<div class="sub">Nothing yet.</div>');
  }
  $('#gp-recheck').onclick = async () => { $('#gp-recheck').disabled = true; await act('/api/recheck'); setTimeout(() => { $('#gp-recheck').disabled = false; }, 4000); };

  // ---------- network mode ----------
  function renderMode(s) {
    const m = s.netmode || {}, changing = m.state === 'changing';
    const name = changing ? 'TO ' + (MODES[m.want] || m.want || '?').toUpperCase() : (MODES[m.mode] || m.mode || '?').toUpperCase();
    $('#gp-mode').textContent = name;
    $('#gp-mode').style.color = changing ? 'var(--warn)' : m.mode === 'ap' ? 'var(--accent)' : '';
    $('#gp-mode2').textContent = changing ? 'Wi-Fi drops for about a minute' : m.mode === 'ap' ? 'the WAN port joins the LAN' : 'the WAN port is the uplink';
    const addr = m.mode === 'ap' ? (s.wan || {}).address : m.lan_ip || '192.168.8.1';
    $('#gp-maddr').textContent = addr ? `${addr}:8088` : 'no address yet';
    $('#gp-msw').textContent = !m.switch_set ? 'not set' : m.switch ? m.switch.toUpperCase() : '—';
    $('#gp-msw2').textContent = m.switch_set && m.switch && (m.switch === 'on') !== (m.mode === 'ap') && !changing ? 'the other way from the mode: the next flip sets it' : 'on = AP · off = Router';
    $('#gp-mlamp').innerHTML = `<span class="dot ${changing ? 'live' : m.state === 'error' ? 'err' : 'on'}"></span>${changing ? 'changing' : esc(MODES[m.mode] || '—')}`;
    $('#gp-merr').hidden = !(m.state === 'error' && m.error); $('#gp-merr').textContent = m.error || '';
    $('#gp-to-router').disabled = changing || m.mode === 'router'; $('#gp-to-ap').disabled = changing || m.mode === 'ap';
    $('#gp-to-router').className = 'btn' + (m.mode === 'router' ? ' primary' : ''); $('#gp-to-ap').className = 'btn' + (m.mode === 'ap' ? ' primary' : '');
  }
  for (const [id, mode] of [['#gp-to-router', 'router'], ['#gp-to-ap', 'ap']]) $(id).onclick = () => {
    if (!confirm(mode === 'ap' ? 'Switch to Access point mode?\n\nThe WAN port joins the LAN, the router stops handing out addresses and takes one from the network on WAN. This page moves to that address (the router\'s screen shows it). Wi-Fi drops for about a minute.'
      : 'Switch to Router mode?\n\nThe router hands out 192.168.8.x again and this page goes back to https://192.168.8.1:8088. Wi-Fi drops for about a minute.')) return;
    act('/api/netmode', { mode }, '#gp-mmsg', 'Changing…');
  };

  // ---------- Wi-Fi ----------
  let wnets = [], wedit = null;
  async function loadWifi() {
    let j;
    try { j = await (await fetch('/api/wifi', { cache: 'no-store' })).json(); } catch { return; }
    wnets = j.networks || [];
    const sv = j.save || {};
    $('#gp-wlamp').innerHTML = sv.state === 'saving' ? `<span class="dot live"></span>saving ${esc(sv.ssid)}…` : sv.state === 'error' ? `<span class="dot err"></span>${esc(sv.error)}`
      : sv.state === 'done' && Date.now() / 1000 - sv.t < 300 ? `<span class="dot on"></span>saved ${esc(sv.ssid)}` : `<span class="dot on"></span>${wnets.filter(n => n.on).length} on`;
    setHTML('#gp-wf', j.error ? `<tr><td class="sub" colspan="4">${esc(j.error)}</td></tr>` : wnets.map(n => `<tr><td class="l"><span class="dot ${n.on ? 'on' : ''}"></span> <b>${esc(n.ssid)}</b>${n.secured ? '' : ' <span class="chip">open</span>'}</td>
      <td class="l">${esc(n.label)}</td><td class="l"><button class="key${n.hidden ? '' : ' sel'} admin-only" data-vis="${esc(n.id)}" title="${n.hidden ? 'Hidden: phones must type the name. Tap to broadcast it.' : 'Visible in Wi-Fi lists. Tap to hide it.'}">${n.hidden ? 'Hidden' : 'Visible'}</button></td>
      <td><button class="btn sm admin-only" data-w="${esc(n.id)}">Change</button></td></tr>`).join('') || '<tr><td class="sub" colspan="4">No networks.</td></tr>');
  }
  $('#gp-wf').addEventListener('click', async e => {
    const v = e.target.closest('[data-vis]'), b = e.target.closest('[data-w]');
    if (v) {
      const n = wnets.find(x => x.id === v.dataset.vis); if (!n) return;
      if (!confirm(n.hidden ? `Make "${n.ssid}" visible in everyone's Wi-Fi list? Wi-Fi restarts for a moment.` : `Hide "${n.ssid}"? Phones already joined stay joined; new ones must type the name. Wi-Fi restarts for a moment.`)) return;
      await act('/api/wifi', { id: n.id, hidden: !n.hidden }); setTimeout(loadWifi, 1500);
    }
    if (b) {
      wedit = wnets.find(x => x.id === b.dataset.w); if (!wedit) return;
      $('#gp-wcard').hidden = false; $('#gp-wtitle').textContent = 'Change ' + wedit.label;
      $('#gp-wssid').value = wedit.ssid || ''; $('#gp-wkey').value = ''; $('#gp-wkey').disabled = !wedit.secured;
      $('#gp-wkey').placeholder = wedit.secured ? '' : 'open network: set a password in GL.iNet first'; $('#gp-wssid').focus();
    }
  });
  $('#gp-wshow').onchange = () => { $('#gp-wkey').type = $('#gp-wshow').checked ? 'text' : 'password'; };
  $('#gp-wcancel').onclick = () => { $('#gp-wcard').hidden = true; wedit = null; };
  $('#gp-wform').onsubmit = async e => {
    e.preventDefault(); if (!wedit) return;
    const ssid = $('#gp-wssid').value.trim(), key = $('#gp-wkey').value;
    if (key && (key.length < 8 || key.length > 63)) return msg('#gp-wmsg', 'The password must be 8 to 63 characters');
    if (!confirm(`Save "${ssid}"${key ? ' with the new password' : ''}? Wi-Fi restarts; phones on it join again${key ? ' with the new password' : ''}.`)) return;
    if (await act('/api/wifi', { id: wedit.id, ssid, key }, '#gp-wmsg', 'Saving…')) { $('#gp-wcard').hidden = true; $('#gp-wkey').value = ''; wedit = null; setTimeout(loadWifi, 1500); }
  };

  // ---------- tools: ping, tick test, LAN speed, port finder, port log ----------
  let span = 30, T = null;
  const pChart = new Chart('#gp-pchart', { ago: true, minTop: 5, axis: v => parseFloat(v.toPrecision(3)) + '' });
  async function loadTools() {
    try { const r = await fetch('/api/tools?span=' + span, { cache: 'no-store' }); if (!r.ok) return; T = await r.json(); } catch { return; }
    renderTools();
  }
  function renderTools() {
    const p = T.ping, k = T.tick, rf = T.reflector, sp = T.speed, b = T.blink, op = T.options || {};
    // ping
    $('#gp-plamp').innerHTML = `<span class="dot ${p.sent ? (p.loss_pct ? 'warn' : 'on') : ''}"></span>${esc(p.target || 'no target yet')}`;
    setSeg('#gp-ploss', p.loss_pct != null ? p.loss_pct.toFixed(1) : '---', 4); $('#gp-ploss2').textContent = p.sent ? `% · ${p.lost} of ${p.sent}` : '%';
    $('#gp-pw-loss').classList.toggle('alarm', p.loss_pct > 0);
    setSeg('#gp-pavg', p.avg != null ? p.avg.toFixed(1) : '---', 4); setSeg('#gp-pjit', p.jitter != null ? p.jitter.toFixed(1) : '---', 4); setSeg('#gp-pp99', p.p99 != null ? p.p99.toFixed(1) : '---', 4);
    const n = p.cols.length, pts = [];
    p.cols.forEach((c, i) => { if (c[2]) pts.push([p.span - (i + 0.5) * p.span / n, c[1] ? null : c[0]]); });
    const ser = [{ name: 'Round trip (ms)', color: C.s[0], pts }];
    legend('#gp-plg', ser); pChart.set(ser, p.span);
    setHTML('#gp-pev', p.events.slice().reverse().map(e => `<div class="ev"><span class="sub mono">${time(e.t)}</span><span class="dot ${e.hit ? 'err' : 'on'}"></span><span>${esc(e.text)} <span class="sub">· ${esc(e.impact)}</span></span></div>`).join('')
      || '<div class="sub">No events in this window.</div>');
    if (document.activeElement !== $('#gp-pt') && document.activeElement !== $('#gp-ptc')) {
      const known = ['gateway', 'dns', 'internet'].includes(op.ping_target);
      $('#gp-pt').value = known ? op.ping_target : 'custom'; $('#gp-ptc').hidden = $('#gp-ptgo').hidden = known;
      if (!known) $('#gp-ptc').value = op.ping_target || '';
    }
    // tick test
    const run = !!k.running;
    $('#gp-tgo').textContent = run ? 'Stop' : 'Start'; $('#gp-tgo').className = 'btn ' + (run ? 'danger' : 'primary');
    if (!$('#gp-ftick')._f) { $('#gp-ts').value = op.tick_server || ''; $('#gp-ftick')._f = 1; }
    const s = k.summary || {};
    $('#gp-tlamp').innerHTML = k.server ? `<span class="dot ${run ? 'live' : VC[{ excellent: 'good', good: 'good', fair: 'warn', bad: 'bad' }[k.grade]] || ''}"></span>${esc(k.server)}${run ? ' · running' : ''}` : '<span class="dot"></span>not run yet';
    $('#gp-thead').textContent = k.headline || (k.server ? '…' : 'Point it at a reflector and press Start.');
    $('#gp-thead').style.color = k.grade === 'bad' ? 'var(--crit)' : k.grade === 'fair' ? 'var(--warn)' : '';
    const g = Object.fromEntries((k.ratings || []).map(x => [x.key, x.grade]));
    const well = (name, v, u, gr) => `<div class="well${gr === 'bad' ? ' alarm' : ''}"><span class="k">${name}</span><div class="big-port" style="font-size:24px;color:${gr === 'bad' ? 'var(--crit)' : gr === 'fair' ? 'var(--warn)' : ''}">${esc(v)}</div><span class="un">${u}</span></div>`;
    setHTML('#gp-twells', s.n ? [well('Loss', s.loss_pct.toFixed(2) + '%', `${s.lost} of ${s.n}`, g.loss), well('Lost in a row', String(s.burst), 'longest run', g.burst),
      well('Late', String(s.late), 'a tick late', g.late), well('Ping', s.p50 != null ? s.p50.toFixed(2) : '—', 'ms typical', g.ping), well('Jitter', s.jitter != null ? s.jitter.toFixed(2) : '—', 'ms', g.jitter)].join('') : '');
    $('#gp-tdetail').textContent = k.error ? 'Error: ' + k.error : k.lost_at && k.lost_at.length ? `Lost at ${k.lost_at.map(x => x + ' s').join(', ')}` : '';
    setHTML('#gp-trate', (k.ratings || []).map(x => `<tr><td class="l">${esc(x.label)}</td><td>${esc(x.value)}</td><td class="l"><span class="dot ${VC[{ excellent: 'good', good: 'good', fair: 'warn', bad: 'bad', info: '' }[x.grade]] || ''}"></span> ${esc(x.grade)}</td></tr>`).join('') || '<tr><td class="sub" colspan="3">No test yet.</td></tr>');
    $('#gp-rlamp').innerHTML = `<span class="dot ${rf.on ? 'on' : ''}"></span>${rf.on ? 'on' : 'off'}`;
    $('#gp-rinfo').textContent = rf.on ? `UDP ${rf.port}, ${rf.answered || 0} packets answered${rf.peers && rf.peers.length ? ', testers: ' + rf.peers.join(', ') : ''}.` : 'Off.';
    $('#gp-rgo').textContent = rf.on ? 'Turn off' : 'Turn on';
    // LAN speed
    if (!$('#gp-flan')._f) { $('#gp-ss').value = op.iperf_server || ''; $('#gp-sp').value = op.iperf_port || ''; $('#gp-flan')._f = 1; }
    $('#gp-sgo').disabled = !!sp.running;
    $('#gp-slamp').innerHTML = sp.running ? `<span class="dot live"></span>testing ${esc(sp.server)}` : sp.server ? `<span class="dot ${sp.error ? 'err' : 'on'}"></span>${esc(sp.server)}` : '<span class="dot"></span>not run yet';
    setSeg('#gp-sdown', sp.down_mbps != null ? Math.round(sp.down_mbps) : '----', 4); setSeg('#gp-sup', sp.up_mbps != null ? Math.round(sp.up_mbps) : '----', 4);
    setSeg('#gp-sretr', sp.up_retr != null ? sp.up_retr : '---', 4);
    $('#gp-sdetail').textContent = sp.error ? 'Error: ' + sp.error : sp.ended ? 'Finished ' + fmtWhen(sp.ended) : '';
    // port finder
    $('#gp-blamp').innerHTML = `<span class="dot ${b.running ? 'live' : ''}"></span>${b.running ? 'blinking' : 'off'}`;
    setSeg('#gp-bcount', b.cycles || 0, 3); $('#gp-bstate').textContent = b.running ? 'blinking now: walk the switch' : 'off';
    $('#gp-bgo').textContent = b.running ? 'Stop' : 'Start'; $('#gp-bgo').className = 'btn ' + (b.running ? 'danger' : 'primary');
    // port log
    setHTML('#gp-log', T.log.slice(0, 200).map(x => `<tr><td class="l sub">${esc(x.time.slice(5, 16))}</td><td class="l">${esc(x.switch.split('.')[0])}</td><td class="l mono">${esc(short(x.port))}</td><td>${esc(x.vlan)}</td><td>${esc(x.speed)}</td><td class="l">${esc(x.label)}</td>
      <td class="l"><span class="dot ${VC[x.verdict] || ''}"></span> ${esc((x.findings || '').split(';')[0])}</td></tr>`).join('') || '<tr><td class="sub" colspan="7">Nothing logged yet.</td></tr>');
  }
  $('#gp-spans').addEventListener('click', e => { const b = e.target.closest('[data-s]'); if (!b) return; span = +b.dataset.s; for (const x of document.querySelectorAll('#gp-spans .key')) x.classList.toggle('sel', x === b); loadTools(); });
  $('#gp-pt').onchange = () => { const c = $('#gp-pt').value === 'custom'; $('#gp-ptc').hidden = $('#gp-ptgo').hidden = !c; if (!c) act('/api/ping', { target: $('#gp-pt').value }).then(loadTools); };
  $('#gp-ptgo').onclick = () => act('/api/ping', { target: $('#gp-ptc').value }).then(loadTools);
  $('#gp-ftick').onsubmit = e => { e.preventDefault(); act('/api/tick', T && T.tick.running ? { action: 'stop' } : { server: $('#gp-ts').value, rate: +document.querySelector('input[name=gp-tr]:checked').value, secs: +$('#gp-td').value }, '#gp-tmsg').then(loadTools); };
  $('#gp-rgo').onclick = () => act('/api/reflector', { on: !(T && T.reflector.on) }).then(loadTools);
  $('#gp-flan').onsubmit = e => { e.preventDefault(); act('/api/speed', { server: $('#gp-ss').value, port: +($('#gp-sp').value || 5201) }, '#gp-smsg', 'Running: about 10 s').then(loadTools); };
  $('#gp-bgo').onclick = () => act('/api/blink', { on: !(T && T.blink.running) }).then(loadTools);
  $('#gp-flog').onsubmit = async e => { e.preventDefault(); if (await act('/api/log', { label: $('#gp-lab').value }, '#gp-logmsg', 'Saved')) { $('#gp-lab').value = ''; loadTools(); } };

  // ---------- Send to GXL ----------
  async function loadGxl() {
    const g = await (await fetch('/api/gxl', { cache: 'no-store' })).json().catch(() => null);
    if (!g) return;
    if (document.activeElement !== $('#gp-gxurl')) $('#gp-gxurl').value = g.url || '';
    $('#gp-gxkey').placeholder = g.key_set ? 'saved (type to change)' : '';
    if (g.sent && !$('#gp-gxmsg').textContent) $('#gp-gxmsg').textContent = `Last sent ${fmtWhen(g.sent.t)}: GXL updated ${g.sent.updated} of ${g.sent.count}` + (g.sent.unknown.length ? `; it doesn't have ${g.sent.unknown.join(', ')}` : '');
  }
  $('#gp-gxsave').onclick = async () => { if (await act('/api/gxl/settings', { url: $('#gp-gxurl').value, key: $('#gp-gxkey').value }, '#gp-gxmsg', 'Saved')) { $('#gp-gxkey').value = ''; loadGxl(); } };
  $('#gp-gxsend').onclick = async () => {
    $('#gp-gxmsg').textContent = 'Sending…';
    const r = await act('/api/gxl/send', {}, '#gp-gxmsg');
    if (r) msg('#gp-gxmsg', `Sent ${r.count}: GXL updated ${r.updated}` + (r.unknown.length ? `; it doesn't have ${r.unknown.join(', ')}` : ''), true);
  };

  // ---------- screen ----------
  let scrTimer = 0;
  function screenLoop() {
    clearTimeout(scrTimer);
    if (view !== 'screen') return;
    $('#gp-scr').src = '/api/screen.bmp?t=' + Date.now();
    scrTimer = setTimeout(screenLoop, 2000);
  }
  function renderScreen(s) {
    $('#gp-scr-probe').className = 'btn' + (s.screen === 'probe' ? ' primary' : ''); $('#gp-scr-gl').className = 'btn' + (s.screen === 'gl' ? ' primary' : '');
  }
  $('#gp-scr-probe').onclick = () => act('/api/screen', { mode: 'probe' }, '#gp-scrmsg', 'GL Probe draws the screen');
  $('#gp-scr-gl').onclick = () => act('/api/screen', { mode: 'gl' }, '#gp-scrmsg', 'GL.iNet draws the screen');

  // ---------- fan ----------
  const fC1 = new Chart('#gp-fc1', { ago: true, minTop: 1000, axis: v => v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k' : v + '' });
  const fC2 = new Chart('#gp-fc2', { ago: true, minTop: 90, axis: v => v + '°' });
  let F = null, fBusy = 0;
  async function loadFan() {
    try { const r = await fetch('/api/fan', { cache: 'no-store' }); if (!r.ok) return; F = await r.json(); } catch { return; }
    const f = F;
    if (!f.present) { $('#gp-flamp').innerHTML = '<span class="dot"></span>no fan on this router'; return; }
    const eff = f.effective, hot = f.temp >= f.safe_c;
    $('#gp-flamp').innerHTML = `<span class="dot ${hot ? 'err' : f.rpm ? 'on' : ''}"></span>${f.rpm ? 'spinning' : 'stopped'}`;
    setSeg('#gp-frpm', f.rpm != null ? Math.round(f.rpm) : '----', 4); $('#gp-fw-rpm').classList.toggle('off', !f.rpm);
    setSeg('#gp-fnow', f.pct_now ?? '---', 3);
    $('#gp-fnow2').textContent = `% of full · level ${f.level ?? '-'} of ${f.max}`;
    setSeg('#gp-ftemp', f.temp != null ? f.temp.toFixed(1) : '---', 4); $('#gp-fw-temp').classList.toggle('alarm', f.temp >= (f.target || 75));
    $('#gp-ftemp2').textContent = eff === 'auto' && f.target ? `°C · target ${f.target} °C` : '°C';
    $('#gp-fmode').textContent = eff === 'boost' ? 'BOOST' : eff === 'manual' ? 'MANUAL' : 'AUTO';
    $('#gp-fmode').style.color = eff === 'boost' ? 'var(--warn)' : '';
    $('#gp-fmode2').textContent = eff === 'boost' ? `full speed · ${Math.ceil(f.boost_left / 60)} min left, then ${f.mode}` : eff === 'manual' ? `GL Probe holds ${f.pct} %` + (hot ? ' · flat out: CPU too hot' : '') : `GL.iNet's control · aims for ${f.target ?? '?'} °C`;
    $('#gp-ferr').hidden = !f.error; $('#gp-ferr').textContent = f.error || '';
    $('#gp-fboost').textContent = eff === 'boost' ? 'Stop boost' : 'Boost: full for 10 min';
    $('#gp-fboost').className = 'btn ' + (eff === 'boost' ? 'danger' : 'primary');
    if (Date.now() - fBusy > 4000) {
      for (const r of document.querySelectorAll('input[name=gp-fmode]')) r.checked = r.value === f.mode;
      $('#gp-fauto').hidden = f.mode !== 'auto'; $('#gp-fman').hidden = f.mode !== 'manual';
      if (document.activeElement !== $('#gp-ftarget') && f.target) { $('#gp-ftarget').value = f.target; $('#gp-ftarget2').textContent = f.target + ' °C'; }
      if (document.activeElement !== $('#gp-fpct')) { $('#gp-fpct').value = f.pct; $('#gp-fpct2').textContent = f.pct + ' %'; }
    }
    const ago = t => f.now - t;
    const s1 = [{ name: 'rpm', color: C.s[0], pts: f.hist.map(h => [ago(h[0]), h[1]]) }], s2 = [{ name: 'CPU °C', color: C.s[1], pts: f.hist.map(h => [ago(h[0]), h[2]]) }];
    legend('#gp-flg1', s1); legend('#gp-flg2', s2); fC1.set(s1, 600); fC2.set(s2, 600);
  }
  async function fanSet(body, text) { fBusy = Date.now(); const r = await act('/api/fan', body, '#gp-fmsg', text); if (r) { F = r; } loadFan(); }
  for (const r of document.querySelectorAll('input[name=gp-fmode]')) r.onchange = () => {
    $('#gp-fauto').hidden = r.value !== 'auto'; $('#gp-fman').hidden = r.value !== 'manual';
    fanSet({ mode: r.value }, r.value === 'auto' ? 'GL.iNet runs the fan' : 'GL Probe holds the speed');
  };
  $('#gp-ftarget').oninput = () => { $('#gp-ftarget2').textContent = $('#gp-ftarget').value + ' °C'; fBusy = Date.now(); };
  $('#gp-ftarget').onchange = () => fanSet({ target: +$('#gp-ftarget').value }, `Target ${$('#gp-ftarget').value} °C`);
  $('#gp-fpct').oninput = () => { $('#gp-fpct2').textContent = $('#gp-fpct').value + ' %'; fBusy = Date.now(); };
  $('#gp-fpct').onchange = () => fanSet({ pct: +$('#gp-fpct').value }, `Speed ${$('#gp-fpct').value} %`);
  $('#gp-fpre').addEventListener('click', e => { const b = e.target.closest('[data-p]'); if (b) { $('#gp-fpct').value = b.dataset.p; $('#gp-fpct2').textContent = b.dataset.p + ' %'; fanSet({ pct: +b.dataset.p }, `Speed ${b.dataset.p} %`); } });
  $('#gp-fboost').onclick = () => fanSet({ boost: !(F && F.effective === 'boost') }, F && F.effective === 'boost' ? 'Boost stopped' : 'Full speed for 10 minutes');
  setInterval(() => { if (ME && view === 'fan' && !document.hidden) loadFan(); }, 2000);

  // ---------- HTTPS ----------
  async function loadTls() {
    const t = await (await fetch('/api/tls', { cache: 'no-store' })).json().catch(() => ({}));
    setHTML('#gp-tlsinfo', t.sha256 ? kv([['Names', (t.names || []).join(', ')], ['Issued by', t.self_signed ? 'itself (self-signed)' : t.issuer], ['Valid from', fmtWhen(t.from)],
      ['Valid until', fmtWhen(t.to), t.to - t.now < 30 * 86400 ? 'bad' : ''], ['Key', t.key], ['SHA-256', t.sha256, 'mono']]) : `<div><dd class="bad">${esc(t.error || 'No certificate')}</dd></div>`);
    $('#gp-tlswarn').hidden = !(t.missing || []).length;
    $('#gp-tlswarn').textContent = (t.missing || []).length ? `It doesn't name ${t.missing.join(', ')}. Make a new one (the names box includes it).` : '';
    if (!$('#gp-tlsnames').value) $('#gp-tlsnames').value = t.suggest || '';
  }
  $('#gp-ftls').onsubmit = async e => {
    e.preventDefault();
    if (!confirm('Make a new certificate? The browser warns once more, and devices that trusted the old one need the new one.')) return;
    if (await act('/api/tls/generate', { names: $('#gp-tlsnames').value }, '#gp-tlsmsg', 'New certificate in use. Reload the page and accept it.')) { $('#gp-tlsnames').value = ''; loadTls(); }
  };
  $('#gp-fup').onsubmit = async e => {
    e.preventDefault();
    if (await act('/api/tls/upload', { cert: $('#gp-tlscert').value, key: $('#gp-tlskey').value }, '#gp-tlsmsg', 'Your certificate is in use. Reload the page.')) { $('#gp-tlscert').value = $('#gp-tlskey').value = ''; loadTls(); }
  };
  $('#gp-tlsfile').onchange = async e => {
    for (const f of e.target.files) {
      const t = await f.text();
      if (/PRIVATE KEY-----/.test(t)) $('#gp-tlskey').value = t;
      else if (/BEGIN CERTIFICATE/.test(t)) $('#gp-tlscert').value = ($('#gp-tlscert').value ? $('#gp-tlscert').value.trim() + '\n' : '') + t;
    }
  };

  // ---------- users ----------
  async function loadUsers() {
    $('#gp-unote').hidden = isAdmin();
    if (!isAdmin()) return;
    const u = await (await fetch('/api/users', { cache: 'no-store' })).json().catch(() => ({ users: [] }));
    renderUsers(u);
  }
  function renderUsers(u) {
    setHTML('#gp-users', (u.users || []).map(x => `<tr><td class="l"><b>${esc(x.name)}</b>${x.name === u.me ? ' <span class="sub">(you)</span>' : ''}</td>
      <td class="l"><select data-role="${esc(x.name)}"><option value="admin"${x.role === 'admin' ? ' selected' : ''}>Admin</option><option value="viewer"${x.role === 'viewer' ? ' selected' : ''}>Viewer</option></select></td>
      <td class="l sub">${x.last ? fmtWhen(x.last) : '—'}</td>
      <td><button class="btn sm" data-pw="${esc(x.name)}">Password</button>${x.name === u.me ? '' : ` <button class="btn sm danger" data-del="${esc(x.name)}">Delete</button>`}</td></tr>`).join(''));
  }
  async function users(body, okText) { const r = await act('/api/users', body, '#gp-umsg', okText); if (r && r.users) renderUsers(r); else loadUsers(); return !!r; }
  $('#gp-users').addEventListener('change', e => { const s = e.target.closest('[data-role]'); if (s) users({ action: 'role', name: s.dataset.role, role: s.value }, `${s.dataset.role} is now ${s.value === 'admin' ? 'an admin' : 'a viewer'}`); });
  $('#gp-users').addEventListener('click', e => {
    const p = e.target.closest('[data-pw]'), d = e.target.closest('[data-del]');
    if (p) { const pw = prompt(`New password for ${p.dataset.pw} (8 or more characters). They log in again with it.`); if (pw) users({ action: 'password', name: p.dataset.pw, password: pw }, 'Password set'); }
    if (d && confirm(`Delete ${d.dataset.del}?`)) users({ action: 'delete', name: d.dataset.del }, `${d.dataset.del} deleted`);
  });
  $('#gp-fuser').onsubmit = async e => {
    e.preventDefault();
    if (await users({ action: 'add', name: $('#gp-unew').value, password: $('#gp-upw').value, role: document.querySelector('input[name=gp-urole]:checked').value }, `${$('#gp-unew').value} added`)) $('#gp-unew').value = $('#gp-upw').value = '';
  };
  $('#gp-fmine').onsubmit = async e => {
    e.preventDefault();
    if (await act('/api/auth/password', { current: $('#gp-mycur').value, new: $('#gp-mynew').value }, '#gp-mymsg', 'Changed. Your other browsers are logged out.')) $('#gp-mycur').value = $('#gp-mynew').value = '';
  };

  // ---------- the page glue calls these ----------
  const TOOLS = ['ping', 'tick', 'lan', 'finder', 'log'];
  function show(v) {
    if (TOOLS.includes(v)) loadTools();
    if (v === 'log') loadGxl();
    if (v === 'wifi') loadWifi();
    if (v === 'screen') screenLoop();
    if (v === 'https') loadTls();
    if (v === 'fan') loadFan();
    if (v === 'users') loadUsers();
  }
  setInterval(() => { if (ME && TOOLS.includes(view) && !document.hidden) loadTools(); }, 2000);
  setInterval(() => { if (ME && view === 'wifi' && $('#gp-wcard').hidden && !document.hidden) loadWifi(); }, 10000);
  function render(s) {
    if (view === 'port') renderPort(s);
    if (view === 'mode') renderMode(s);
    if (view === 'screen') renderScreen(s);
  }
  return { render, show, short };
})();
