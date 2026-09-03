/* Traffic-light game for small children: rendering, UI, sounds. No written text – icons only. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const view = $('view'), fx = $('fx'), wrap = $('stage-wrap');
  const ctx = view.getContext('2d'), fxc = fx.getContext('2d');
  const W = 600;
  const MOOD = { happy: '😊', sad: '😢', angry: '😠', hmm: '😕', sleepy: '😴', scared: '😨', crash: '😵' };
  const COLORS = ['#ff595e', '#1982c4', '#ffca3a', '#8ac926', '#6a4c93', '#ff924c'];
  // each road axis has its own colour so a child can match button <-> signal <-> road
  const AXIS = { ns: { color: '#2f80ed', rgb: '47,128,237', glyph: '⬍' }, ew: { color: '#e84393', rgb: '232,67,147', glyph: '⬌' } };
  const TOGGLE_AXIS = { nsLight: 'ns', ewLight: 'ew', yellow: null, arrow: 'ns', lane: 'ns' };
  let pulse = { axis: null, t: 0 };   // road highlight after a button press

  // ---------- persistent progress ----------
  let unlocked = 1;
  try { unlocked = Math.max(1, parseInt(localStorage.getItem('tl-unlocked') || '1', 10)); } catch (e) { /* ignore */ }
  function saveUnlocked() { try { localStorage.setItem('tl-unlocked', String(unlocked)); } catch (e) { /* ignore */ } }

  // ---------- sound ----------
  let audio = null, muted = false;
  function ac() {
    if (!audio) { try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audio = null; } }
    if (audio && audio.state === 'suspended') audio.resume();
    return audio;
  }
  function tone(freq, t0, dur, type, vol) {
    const a = ac(); if (!a || muted) return;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type || 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, a.currentTime + t0);
    g.gain.exponentialRampToValueAtTime(vol || 0.2, a.currentTime + t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + t0 + dur);
    o.connect(g).connect(a.destination);
    o.start(a.currentTime + t0); o.stop(a.currentTime + t0 + dur + 0.05);
  }
  const SFX = {
    click() { tone(880, 0, 0.08, 'square', 0.08); },
    crash() {
      const a = ac(); if (!a || muted) return;
      const buf = a.createBuffer(1, a.sampleRate * 0.5, a.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
      const src = a.createBufferSource(); src.buffer = buf;
      const g = a.createGain(); g.gain.value = 0.5;
      src.connect(g).connect(a.destination); src.start();
      tone(80, 0, 0.5, 'sawtooth', 0.3);
    },
    sad() { tone(392, 0, 0.3, 'triangle', 0.2); tone(311, 0.3, 0.5, 'triangle', 0.2); },
    star() { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.1, 0.25, 'triangle', 0.2)); },
    clear() { [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => tone(f, i * 0.12, 0.3, 'triangle', 0.22)); },
    sleepy() { tone(330, 0, 0.4, 'sine', 0.15); tone(262, 0.45, 0.6, 'sine', 0.15); },
  };

  // ---------- state ----------
  let stageIdx = 0, stage = STAGES[0];
  let cfg = null;          // current toggle state for the stage
  let sim = null;
  let running = false, roundT = 0;
  let goalsDone = {};
  let fxList = [];         // particles / bursts
  let shakeT = 0;
  let lastTime = 0, acc = 0;
  let idleSim = null;      // decorative sim shown while idle

  function makeCfg() {
    const c = JSON.parse(JSON.stringify(stage.init));
    c.mode = stage.mode;
    return c;
  }
  function spawnsFor(c) {
    return stage.spawns.map(s => {
      const o = Object.assign({}, s);
      if (!c.turnLane && o.lane === 'S1s') o.lane = 'S0s';
      if (c.turnLane && o.lane === 'S0s') o.lane = 'S1s';
      return o;
    });
  }
  function buildSim(withTraffic) {
    const c = JSON.parse(JSON.stringify(cfg));
    c.spawns = withTraffic ? spawnsFor(c) : [];
    c.warmup = withTraffic ? (stage.warmup || 0) : 0;
    return Sim.create(c);
  }

  // ---------- UI: stage buttons ----------
  function renderStages() {
    const el = $('stages'); el.innerHTML = '';
    STAGES.forEach((st, i) => {
      const b = document.createElement('button');
      b.className = 'stage-btn' + (i === stageIdx ? ' current' : '') + (i + 1 < unlocked ? ' done' : '') + (i + 1 > unlocked ? ' locked' : '');
      b.textContent = i + 1 > unlocked ? '🔒' : st.icon;
      b.addEventListener('click', () => { if (i + 1 <= unlocked && !running) { SFX.click(); loadStage(i); } });
      el.appendChild(b);
    });
  }

  // ---------- UI: goals ----------
  function renderGoals() {
    const el = $('goals'); el.innerHTML = '';
    const chip = axis => `<svg class="chip" viewBox="0 0 64 64">${miniMap(axis)}</svg>`;
    const icons = { ns: chip('ns') + '🚗', ew: chip('ew') + '🚗', safe: '🚗🚗', turn: '🚗↲', flow: '🚗🚗🚗' };
    stage.goals.forEach(g => {
      const d = document.createElement('div');
      d.className = 'goal' + (goalsDone[g] ? ' done' : '');
      if (g === 'ns' || g === 'ew') d.style.borderColor = AXIS[g].color;
      d.innerHTML = `<span>${icons[g]}</span><span class="chk">⭐</span>`;
      el.appendChild(d);
    });
  }

  // ---------- UI: toggles ----------
  const svgNS = 'http://www.w3.org/2000/svg';
  function miniMap(axis) {
    // small crossroads; the road this control belongs to is painted in the axis colour
    if (!axis) return '';
    const a = AXIS[axis];
    return `<rect x="24" y="0" width="16" height="64" fill="${axis === 'ns' ? a.color : '#cfc9bb'}" opacity="${axis === 'ns' ? .55 : .5}"/>` +
           `<rect x="0" y="24" width="64" height="16" fill="${axis === 'ew' ? a.color : '#cfc9bb'}" opacity="${axis === 'ew' ? .55 : .5}"/>`;
  }
  function lightSVG(bulbs, active, arrowOn, vertical, axis) {
    // bulbs: array of 'G','Y','R','A' in driver order (green .. red, arrow). Drawn like the canvas heads:
    // the vertical (E-W) head is read top-to-bottom, the horizontal (N-S) head right-to-left.
    const hasArrow = bulbs.includes('A');
    bulbs = bulbs.filter(b => b !== 'A');
    const n = bulbs.length, w = vertical ? 26 : 16 + n * 16, h = (vertical ? 16 + n * 16 : 26) + (hasArrow ? 20 : 0);
    const col = { R: '#ff3b30', Y: '#ffcc00', G: '#34c759', A: '#34c759' };
    const top = (64 - h) / 2;
    let s = `<svg viewBox="0 0 64 64">${miniMap(axis)}<rect x="${(64 - w) / 2}" y="${top}" width="${w}" height="${h}" rx="7" fill="#333"/>`;
    let lastX = 32, lastY = top + 13;
    bulbs.forEach((b, i) => {
      const cx = vertical ? 32 : (64 + w) / 2 - 8 - 8 - i * 16, cy = vertical ? top + 16 + i * 16 : top + 13;
      const on = active === b;
      s += `<circle cx="${cx}" cy="${cy}" r="6" fill="${on ? col[b] : '#222'}" stroke="${on ? '#fff' : 'none'}" stroke-width="1"/>`;
      lastX = cx; lastY = cy;
    });
    if (hasArrow) {
      // arrow lamp in its own row below the red lamp (Japanese layout)
      const cx = vertical ? 32 : (64 + w) / 2 - 8 - 8, cy = lastY + 18;
      s += `<circle cx="${cx}" cy="${cy}" r="6" fill="#111"/>` +
           `<path d="M${cx - 4} ${cy} L${cx + 4} ${cy} M${cx + 1} ${cy - 3} L${cx + 4} ${cy} L${cx + 1} ${cy + 3}" stroke="${arrowOn ? col.A : '#2a4a2f'}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
    }
    return s + '</svg>';
  }
  function laneSVG(on) {
    let s = `<svg viewBox="0 0 64 64"><rect x="${on ? 12 : 20}" y="4" width="${on ? 40 : 24}" height="56" fill="#555" rx="3"/>` +
            `<rect x="${on ? 12 : 20}" y="4" width="${on ? 40 : 24}" height="56" fill="${AXIS.ns.color}" opacity=".3" rx="3"/>`;
    if (on) {
      s += `<line x1="32" y1="6" x2="32" y2="58" stroke="#fff" stroke-width="2" stroke-dasharray="6 5"/>`;
      s += `<path d="M42 20 V40 M42 40 l-4 -5 M42 40 l4 -5" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round"/>`;
      s += `<path d="M22 20 V34 q0 6 -6 6 M19 36 l-5 4 5 4" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round"/>`;
    } else {
      s += `<path d="M32 18 V42 M32 42 l-5 -6 M32 42 l5 -6" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round"/>`;
    }
    return s + '</svg>';
  }
  function toggleIcon(kind) {
    switch (kind) {
      case 'nsLight': return lightSVG(['G', 'R'], cfg.lights.ns, false, false, 'ns');
      case 'ewLight': return lightSVG(['G', 'R'], cfg.lights.ew, false, true, 'ew');
      case 'yellow': return cfg.yellow ? lightSVG(['G', 'Y', 'R'], 'Y', false, false) : lightSVG(['G', 'R'], '', false, false);
      case 'arrow': return cfg.arrow ? lightSVG(['G', 'Y', 'R', 'A'], '', true, false, 'ns') : lightSVG(['G', 'Y', 'R'], '', false, false, 'ns');
      case 'lane': return laneSVG(cfg.turnLane);
    }
    return '';
  }
  const LBL = { nsLight: '', ewLight: '', yellow: '🟡', arrow: '↲', lane: '🛣️' };
  function renderToggles() {
    const el = $('toggles'); el.innerHTML = '';
    stage.toggles.forEach(kind => {
      const b = document.createElement('button');
      b.className = 'toggle'; b.dataset.kind = kind;
      const axis = TOGGLE_AXIS[kind];
      if (axis) { b.dataset.axis = axis; b.style.borderColor = AXIS[axis].color; }
      const lbl = LBL[kind] ? `<span class="lbl">${LBL[kind]}</span>` : '';
      b.innerHTML = toggleIcon(kind) + lbl + `<span class="hand">👆</span>`;
      b.addEventListener('click', () => onToggle(kind, b));
      el.appendChild(b);
    });
    refreshToggles();
  }
  function refreshToggles() {
    document.querySelectorAll('.toggle').forEach(b => {
      const k = b.dataset.kind;
      b.querySelector('svg').outerHTML = toggleIcon(k);
      const on = k === 'nsLight' ? cfg.lights.ns === 'G' : k === 'ewLight' ? cfg.lights.ew === 'G'
               : k === 'yellow' ? cfg.yellow : k === 'arrow' ? cfg.arrow : cfg.turnLane;
      b.classList.toggle('on', !!on);
      b.disabled = running && stage.mode !== 'manual';
    });
  }
  function onToggle(kind, btn) {
    if (btn.disabled) return;
    SFX.click();
    btn.classList.remove('hint');
    switch (kind) {
      case 'nsLight': cfg.lights.ns = cfg.lights.ns === 'G' ? 'R' : 'G'; break;
      case 'ewLight': cfg.lights.ew = cfg.lights.ew === 'G' ? 'R' : 'G'; break;
      case 'yellow': cfg.yellow = !cfg.yellow; break;
      case 'arrow': cfg.arrow = !cfg.arrow; break;
      case 'lane': cfg.turnLane = !cfg.turnLane; break;
    }
    if (sim) { sim.cfg.yellow = cfg.yellow; sim.cfg.arrow = cfg.arrow; sim.cfg.lights = cfg.lights; }
    if (TOGGLE_AXIS[kind]) pulse = { axis: TOGGLE_AXIS[kind], t: 1 };
    if (!running) idleSim = buildSim(false);
    refreshToggles();
  }
  function hint(kind) {
    const b = document.querySelector(`.toggle[data-kind="${kind}"]`);
    if (b) b.classList.add('hint');
  }
  function clearHints() { document.querySelectorAll('.toggle.hint').forEach(b => b.classList.remove('hint')); }

  // ---------- stage flow ----------
  function loadStage(i) {
    stageIdx = i; stage = STAGES[i];
    cfg = makeCfg(); goalsDone = {}; sim = null; running = false;
    idleSim = buildSim(false);
    fxList = [];
    renderStages(); renderGoals(); renderToggles();
    $('overlay').classList.add('hidden');
    $('play').classList.remove('hidden');
    wrap.classList.remove('running');
  }

  function startRound() {
    if (running) return;
    ac();
    SFX.click(); clearHints();
    sim = buildSim(true);
    running = true; roundT = 0; fxList = [];
    wrap.classList.add('running');
    $('play').classList.add('hidden');
    $('overlay').classList.add('hidden');
    refreshToggles();
  }

  function endRound(crashed) {
    running = false;
    wrap.classList.remove('running');
    refreshToggles();
    const st = sim.stats, p = st.passed;
    let emoji = '⭐', sub = '', ok = false, cleared = false, hintKind = null, sound = 'star';
    if (crashed) {
      emoji = '💥'; sub = '😵😵'; sound = null;
      hintKind = stage.mode === 'manual' ? null : 'yellow';
    } else if (stage.id === 1) {
      const ns = p.S + p.N > 0, ew = p.E + p.W > 0;
      if (!ns && !ew) { emoji = '😴'; sub = '💤'; sound = 'sleepy'; }
      else {
        ok = true;
        if (ns) goalsDone.ns = true;
        if (ew) goalsDone.ew = true;
        renderGoals();
        cleared = goalsDone.ns && goalsDone.ew;
        if (!cleared) { sub = goalsDone.ns ? '🚗⬌❓' : '🚗⬍❓'; hintKind = goalsDone.ns ? 'ewLight' : 'nsLight'; }
      }
    } else if (stage.id === 2) {
      ok = cleared = true; goalsDone.safe = true;
    } else if (stage.id === 3) {
      if (st.sadTurn > 0 || p.turn === 0) { emoji = '😢'; sub = '🚗↲💧'; hintKind = 'arrow'; sound = 'sad'; }
      else { ok = cleared = true; goalsDone.turn = true; }
    } else if (stage.id === 4) {
      if (st.angry > 0) { emoji = '😠'; sub = '🚗🚗🚗💢'; hintKind = 'lane'; sound = 'sad'; }
      else if (p.straightS < 4) { emoji = '😕'; sub = '🚗…'; sound = 'sad'; }
      else { ok = cleared = true; goalsDone.flow = true; }
    } else {
      // free play: count stars
      goalsDone = { safe: true };
      const turnOK = st.sadTurn === 0 && p.turn > 0, flowOK = st.angry === 0 && p.straightS >= 4;
      if (turnOK) goalsDone.turn = true;
      if (flowOK) goalsDone.flow = true;
      const stars = 1 + (turnOK ? 1 : 0) + (flowOK ? 1 : 0);
      emoji = stars === 3 ? '🏆' : '⭐'.repeat(stars);
      sub = stars === 3 ? '⭐⭐⭐' : (!turnOK ? '😢↲ ' : '') + (!flowOK ? '😠🚗🚗' : '');
      hintKind = !turnOK ? 'arrow' : !flowOK ? 'lane' : null;
      ok = true; cleared = stars === 3;
      if (!cleared) sound = 'sad';
    }
    if (cleared) { emoji = stage.id === 5 ? '🏆' : '🎉'; sub = '⭐⭐⭐'; sound = 'clear'; }
    if (sound === 'star') SFX.star(); else if (sound === 'sad') SFX.sad(); else if (sound === 'clear') SFX.clear(); else if (sound === 'sleepy') SFX.sleepy();
    if (cleared) {
      if (unlocked < stage.id + 1 && stage.id < STAGES.length) { unlocked = stage.id + 1; saveUnlocked(); }
      else if (stage.id === STAGES.length && unlocked < STAGES.length + 1) { unlocked = STAGES.length + 1; saveUnlocked(); }
      renderStages(); renderGoals();
      confetti();
    }
    if (hintKind) hint(hintKind);
    showResult(emoji, sub, cleared && stage.id < STAGES.length ? '▶' : '🔁', () => {
      if (cleared && stage.id < STAGES.length) loadStage(stageIdx + 1);
      else { $('overlay').classList.add('hidden'); $('play').classList.remove('hidden'); sim = null; idleSim = buildSim(false); }
    });
  }

  let nextAction = null;
  function showResult(emoji, sub, btn, action) {
    $('result-emoji').textContent = emoji;
    $('result-sub').textContent = sub;
    $('next').textContent = btn;
    nextAction = action;
    setTimeout(() => $('overlay').classList.remove('hidden'), crashed_delay(emoji));
  }
  function crashed_delay(e) { return e === '💥' ? 900 : 400; }
  $('next').addEventListener('click', () => { SFX.click(); if (nextAction) nextAction(); });
  $('play').addEventListener('click', startRound);
  $('sound').addEventListener('click', () => { muted = !muted; $('sound').textContent = muted ? '🔇' : '🔊'; if (!muted) SFX.click(); });

  // ---------- effects ----------
  function confetti() {
    for (let i = 0; i < 90; i++) {
      fxList.push({ kind: 'confetti', x: Math.random() * W, y: -20 - Math.random() * 200, vx: (Math.random() - 0.5) * 60, vy: 80 + Math.random() * 120,
        c: COLORS[i % COLORS.length], r: Math.random() * Math.PI, life: 4 });
    }
  }
  function burst(x, y, emoji) { fxList.push({ kind: 'burst', x, y, emoji, life: 1.2, t: 0 }); }
  function sparkle(x, y) {
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2;
      fxList.push({ kind: 'spark', x, y, vx: Math.cos(a) * 60, vy: Math.sin(a) * 60, life: 0.6 });
    }
  }
  function stepFx(dt) {
    for (const f of fxList) {
      f.life -= dt;
      if (f.kind === 'confetti') { f.x += f.vx * dt; f.y += f.vy * dt; f.r += dt * 3; }
      else if (f.kind === 'spark') { f.x += f.vx * dt; f.y += f.vy * dt; }
      else if (f.kind === 'burst') f.t += dt;
    }
    fxList = fxList.filter(f => f.life > 0);
  }
  function drawFx(c) {
    for (const f of fxList) {
      if (f.kind === 'confetti') {
        c.save(); c.translate(f.x, f.y); c.rotate(f.r); c.fillStyle = f.c; c.globalAlpha = Math.min(1, f.life); c.fillRect(-6, -4, 12, 8); c.restore();
      } else if (f.kind === 'spark') {
        c.fillStyle = '#fff'; c.globalAlpha = Math.max(0, f.life / 0.6);
        c.beginPath(); c.arc(f.x, f.y, 3, 0, Math.PI * 2); c.fill(); c.globalAlpha = 1;
      } else if (f.kind === 'burst') {
        const s = 1 + Math.min(1, f.t * 3) * 1.2;
        c.save(); c.translate(f.x, f.y); c.scale(s, s); c.font = '48px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(f.emoji, 0, 0); c.restore();
      }
    }
  }

  // ---------- drawing ----------
  function drawRoad(c, s) {
    const g = s.geo, box = g.box, lane = s.cfg.turnLane;
    // grass + a few trees
    c.fillStyle = '#7ccf6b'; c.fillRect(0, 0, W, W);
    c.font = '30px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    [[60, 60, '🌳'], [520, 120, '🌳'], [80, 540, '🌲'], [540, 500, '🏠'], [180, 470, '🌼'], [560, 60, '🌸']].forEach(t => c.fillText(t[2], t[0], t[1]));
    // roads
    c.fillStyle = '#5c5f63';
    c.fillRect(260, 0, 80, W);                 // N-S
    c.fillRect(0, 260, W, 80);                 // E-W
    if (lane) { c.beginPath(); c.moveTo(340, 0); c.lineTo(380, 0); c.lineTo(380, 372); c.lineTo(340, 452); c.closePath(); c.fill(); }
    // tint each road in its axis colour (the crossing itself stays grey)
    tintRoads(c, s, 'ns', 0.2); tintRoads(c, s, 'ew', 0.2);
    if (pulse.t > 0) tintRoads(c, s, pulse.axis, 0.45 * pulse.t);
    // edge lines
    c.strokeStyle = '#eee'; c.lineWidth = 2;
    c.beginPath();
    c.moveTo(260, 0); c.lineTo(260, 258); c.moveTo(260, 342); c.lineTo(260, W);
    c.moveTo(340, 452); c.lineTo(340, W);
    if (lane) { c.moveTo(380, 0); c.lineTo(380, 258); c.moveTo(380, 342); c.lineTo(380, 372); c.lineTo(340, 452); }
    else { c.moveTo(340, 0); c.lineTo(340, 258); c.moveTo(340, 342); c.lineTo(340, W); }
    c.moveTo(0, 260); c.lineTo(258, 260); c.moveTo(box.x2 + 2, 260); c.lineTo(W, 260);
    c.moveTo(0, 340); c.lineTo(258, 340); c.moveTo(box.x2 + 2, 340); c.lineTo(W, 340);
    c.stroke();
    // centre lines (dashed)
    c.setLineDash([14, 12]); c.strokeStyle = '#ffd166'; c.lineWidth = 3;
    c.beginPath();
    c.moveTo(300, 0); c.lineTo(300, 240); c.moveTo(300, 360); c.lineTo(300, W);
    c.moveTo(0, 300); c.lineTo(240, 300); c.moveTo(box.x2 + 20, 300); c.lineTo(W, 300);
    c.stroke();
    if (lane) { c.strokeStyle = '#fff'; c.lineWidth = 2; c.beginPath(); c.moveTo(340, 0); c.lineTo(340, 240); c.stroke(); }
    c.setLineDash([]);
    // stop lines
    c.strokeStyle = '#fff'; c.lineWidth = 5;
    c.beginPath();
    c.moveTo(302, g.stop.S); c.lineTo(lane ? 378 : 338, g.stop.S);
    c.moveTo(262, g.stop.N); c.lineTo(298, g.stop.N);
    c.moveTo(g.stop.E, 262); c.lineTo(g.stop.E, 298);
    c.moveTo(g.stop.W, 302); c.lineTo(g.stop.W, 338);
    c.stroke();
    // road arrows on the southbound approach
    c.strokeStyle = '#fff'; c.lineWidth = 4; c.lineCap = 'round'; c.lineJoin = 'round';
    if (lane) {
      arrowStraight(c, 360, 150, 190);
      arrowTurn(c, 320, 150);
    } else {
      arrowStraight(c, 320, 150, 190);
    }
    // crosswalk stripes
    c.fillStyle = 'rgba(255,255,255,.8)';
    for (let i = 0; i < 4; i++) {
      c.fillRect(264 + i * 20, 232, 12, 16); c.fillRect(264 + i * 20, 352, 12, 16);
      c.fillRect(232, 264 + i * 20, 16, 12); c.fillRect(box.x2 + 12, 264 + i * 20, 16, 12);
    }
    if (lane) for (let i = 4; i < 6; i++) c.fillRect(264 + i * 20, 232, 12, 16);
  }
  function tintRoads(c, s, axis, alpha) {
    const box = s.geo.box, lane = s.cfg.turnLane;
    c.fillStyle = `rgba(${AXIS[axis].rgb},${alpha})`;
    if (axis === 'ns') {
      c.fillRect(260, 0, 80, 260); c.fillRect(260, 340, 80, W - 340);
      if (lane) { c.beginPath(); c.moveTo(340, 0); c.lineTo(380, 0); c.lineTo(380, 260); c.lineTo(340, 260); c.closePath(); c.fill();
                  c.beginPath(); c.moveTo(340, 340); c.lineTo(380, 340); c.lineTo(380, 372); c.lineTo(340, 452); c.closePath(); c.fill(); }
    } else {
      c.fillRect(0, 260, 260, 80); c.fillRect(box.x2, 260, W - box.x2, 80);
    }
  }
  function arrowStraight(c, x, y1, y2) {
    c.beginPath(); c.moveTo(x, y1); c.lineTo(x, y2); c.moveTo(x - 7, y2 - 9); c.lineTo(x, y2); c.lineTo(x + 7, y2 - 9); c.stroke();
  }
  function arrowTurn(c, x, y) {
    c.beginPath(); c.moveTo(x, y); c.lineTo(x, y + 26); c.quadraticCurveTo(x, y + 40, x - 14, y + 40); c.lineTo(x - 22, y + 40);
    c.moveTo(x - 14, y + 32); c.lineTo(x - 22, y + 40); c.lineTo(x - 14, y + 48); c.stroke();
  }

  // One signal head, drawn as the approaching driver would see it: bulbs run left-to-right
  // (green .. red) in the driver's own left/right, the right-turn arrow sits below the red
  // lamp (as on Japanese signals), and the head stands on a pole at the far corner of the
  // crossing, facing the oncoming traffic. The face is drawn as a trapezoid that is wider
  // on the side facing the traffic, so the head looks tilted towards the cars it controls.
  // heading: 0 = east, PI/2 = south, PI = west, -PI/2 = north
  const TILT = 0.78;   // width of the far edge relative to the near (traffic-facing) edge
  function trapezoid(c, x, y, w, h, k, r) {
    // near edge (towards the traffic) at y, far edge at y+h, narrower by k; slightly rounded
    const dx = w * (1 - k) / 2;
    c.beginPath();
    c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w - r * 0.3, y + r);
    c.lineTo(x + w - dx + r * 0.3, y + h - r); c.quadraticCurveTo(x + w - dx, y + h, x + w - dx - r, y + h);
    c.lineTo(x + dx + r, y + h); c.quadraticCurveTo(x + dx, y + h, x + dx + r * 0.3, y + h - r);
    c.lineTo(x + r * 0.3, y + r); c.quadraticCurveTo(x, y, x + r, y); c.closePath();
  }
  function drawLightHead(c, cx, cy, heading, poleX, poleY, bulbs, active, hasArrow, arrowOn, arrowYellow, axis) {
    const n = bulbs.length, w = 16 + n * 26, h = hasArrow ? 34 + 30 : 34, A = AXIS[axis];
    const hot = pulse.t > 0 && pulse.axis === axis;
    // arm from the pole to the head
    c.strokeStyle = '#444'; c.lineWidth = 5; c.lineCap = 'round';
    c.beginPath(); c.moveTo(poleX, poleY); c.lineTo(cx, cy); c.stroke();
    c.fillStyle = '#333'; c.beginPath(); c.arc(poleX, poleY, 6, 0, Math.PI * 2); c.fill();
    c.save();
    c.translate(cx, cy);
    c.rotate(heading + Math.PI / 2);      // local +x = the driver's right-hand side
    c.scale(1, -1);                       // local -y = towards the oncoming traffic (the face the driver sees)
    const x = -w / 2, y = -h / 2;
    // back/underside: gives the slab some thickness on the far side
    c.fillStyle = '#1c1c1c'; trapezoid(c, x - 5 + 3, y - 5 + 8, w + 10 - 6, h + 10, TILT, 10); c.fill();
    // coloured frame matching the button and the road
    c.fillStyle = A.color; trapezoid(c, x - 5, y - 5, w + 10, h + 10, TILT, 10); c.fill();
    if (hot) { c.strokeStyle = `rgba(${A.rgb},${pulse.t})`; c.lineWidth = 6 + 10 * pulse.t; trapezoid(c, x - 5, y - 5, w + 10, h + 10, TILT, 10); c.stroke(); }
    c.fillStyle = '#2b2b2b'; trapezoid(c, x, y, w, h, TILT, 7); c.fill();
    c.strokeStyle = '#111'; c.lineWidth = 2; c.stroke();
    // lamps: positions shrink towards the far edge to follow the perspective
    const col = { R: '#ff3b30', Y: '#ffcc00', G: '#34c759' };
    const scaleAt = ly => 1 - (1 - TILT) * ((ly - y) / h);
    const mainY = y + 17, k1 = scaleAt(mainY);
    bulbs.forEach((b, i) => {
      const bx = (x + 8 + 13 + i * 26) * k1, by = mainY, r = 10 * k1;
      const on = active === b;
      c.fillStyle = on ? col[b] : '#1a1a1a'; c.beginPath(); c.ellipse(bx, by, r, r * 0.92, 0, 0, Math.PI * 2); c.fill();
      if (on) glow(c, bx, by, col[b]);
    });
    if (hasArrow) {
      // right-turn arrow lamp below the red lamp, pointing to the driver's right (+x)
      const ay = y + 34 + 15, k2 = scaleAt(ay), ax = (x + 8 + 13 + (n - 1) * 26) * k2, r = 10 * k2;
      c.fillStyle = '#111'; c.beginPath(); c.ellipse(ax, ay, r, r * 0.92, 0, 0, Math.PI * 2); c.fill();
      c.strokeStyle = arrowOn ? '#34c759' : arrowYellow ? '#ffcc00' : '#28402c'; c.lineWidth = 3; c.lineCap = 'round';
      c.beginPath(); c.moveTo(ax - 6 * k2, ay); c.lineTo(ax + 6 * k2, ay); c.moveTo(ax + 2 * k2, ay - 4); c.lineTo(ax + 6 * k2, ay); c.lineTo(ax + 2 * k2, ay + 4); c.stroke();
      if (arrowOn) glow(c, ax, ay, '#34c759');
    }
    // visor on the side facing the traffic (local -y)
    c.fillStyle = '#111'; c.fillRect(x, y - 4, w, 4);
    c.restore();
  }

  function drawLights(c, s) {
    const L = s.lights, cfgS = s.cfg, box = s.geo.box;
    const bulbs = cfgS.yellow ? ['G', 'Y', 'R'] : ['G', 'R'];
    const w = 16 + bulbs.length * 26, hS = cfgS.arrow ? 64 : 34;
    // southbound traffic (from the top): far corner is bottom-right -> head below the crossing, facing up
    drawLightHead(c, box.x2 + 12 + w / 2, box.y2 + 14 + hS / 2, Math.PI / 2, box.x2 + 4, box.y2 + 4, bulbs, L.ns, cfgS.arrow, L.arrow, L.arrowYellow, 'ns');
    // northbound traffic (from the bottom): far corner is top-left -> head above the crossing, facing down
    drawLightHead(c, box.x1 - 12 - w / 2, box.y1 - 30, -Math.PI / 2, box.x1 - 4, box.y1 - 4, bulbs, L.ns, false, false, false, 'ns');
    // eastbound traffic (from the left): far corner is top-right -> head right of the crossing, facing left
    drawLightHead(c, box.x2 + 30, box.y1 - 12 - w / 2, 0, box.x2 + 4, box.y1 - 4, bulbs, L.ew, false, false, false, 'ew');
    // westbound traffic (from the right): far corner is bottom-left -> head left of the crossing, facing right
    drawLightHead(c, box.x1 - 30, box.y2 + 12 + w / 2, Math.PI, box.x1 - 4, box.y2 + 4, bulbs, L.ew, false, false, false, 'ew');
  }

  function glow(c, x, y, color) {
    const g = c.createRadialGradient(x, y, 8, x, y, 22);
    g.addColorStop(0, color + 'aa'); g.addColorStop(1, color + '00');
    c.fillStyle = g; c.beginPath(); c.arc(x, y, 22, 0, Math.PI * 2); c.fill();
  }
  function roundRect(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h); c.lineTo(x + r, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - r); c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y); c.closePath();
  }

  function drawCar(c, car, t) {
    const L = Sim.CAR_LEN, Wd = Sim.CAR_WID;
    c.save();
    c.translate(car.cx, car.cy); c.rotate(car.angle);
    // shadow
    c.fillStyle = 'rgba(0,0,0,.18)'; roundRect(c, -L / 2 + 2, -Wd / 2 + 3, L, Wd, 5); c.fill();
    // body
    c.fillStyle = car.kind === 'turn' ? '#ff924c' : COLORS[car.color];
    roundRect(c, -L / 2, -Wd / 2, L, Wd, 5); c.fill();
    c.strokeStyle = 'rgba(0,0,0,.25)'; c.lineWidth = 1.5; c.stroke();
    // windows
    c.fillStyle = '#cfe8ff';
    roundRect(c, 2, -Wd / 2 + 3, 7, Wd - 6, 2); c.fill();
    roundRect(c, -9, -Wd / 2 + 3, 6, Wd - 6, 2); c.fill();
    // headlights
    c.fillStyle = '#fff8c4'; c.fillRect(L / 2 - 3, -Wd / 2 + 2, 2.5, 4); c.fillRect(L / 2 - 3, Wd / 2 - 6, 2.5, 4);
    if (car.kind === 'turn') {
      // roof arrow (turn right = towards the car's right side, which is -y in car space... right of forward on screen)
      c.strokeStyle = '#fff'; c.lineWidth = 2.2; c.lineCap = 'round';
      c.beginPath(); c.moveTo(-4, 0); c.lineTo(2, 0); c.quadraticCurveTo(5, 0, 5, 3); c.lineTo(5, 5);
      c.moveTo(2.5, 3); c.lineTo(5, 6); c.lineTo(7.5, 3); c.stroke();
      // blinking indicator on the car's right side (+y in car space)
      if (Math.floor(t * 3) % 2 === 0) { c.fillStyle = '#ffb300'; c.fillRect(L / 2 - 4, Wd / 2 - 4, 4, 5); }
    }
    c.restore();
    // mood bubble
    const m = MOOD[car.mood];
    if (m) {
      c.save();
      c.translate(car.cx, car.cy - 24);
      c.fillStyle = 'rgba(255,255,255,.9)'; c.beginPath(); c.arc(0, 0, 13, 0, Math.PI * 2); c.fill();
      c.font = '20px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(m, 0, 1);
      c.restore();
    }
  }

  function drawScene(s, t) {
    ctx.save();
    if (shakeT > 0) ctx.translate((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10);
    drawRoad(ctx, s);
    const cars = s.cars.slice().sort((a, b) => a.cy - b.cy);
    for (const car of cars) drawCar(ctx, car, t);
    drawLights(ctx, s);
    ctx.restore();
  }

  // ---------- main loop ----------
  function resize() {
    const top = $('top').offsetHeight + $('goals').offsetHeight + $('controls').offsetHeight + 24;
    const side = Math.max(240, Math.min(window.innerWidth - 8, window.innerHeight - top, 600));
    wrap.style.width = side + 'px'; wrap.style.height = side + 'px';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    [view, fx].forEach(cv => { cv.width = Math.round(side * dpr); cv.height = Math.round(side * dpr); });
    const k = side * dpr / W;
    ctx.setTransform(k, 0, 0, k, 0, 0); fxc.setTransform(k, 0, 0, k, 0, 0);
  }
  window.addEventListener('resize', resize);

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - lastTime) / 1000 || 0); lastTime = now;
    const t = now / 1000;
    if (running && sim) {
      acc += dt;
      const step = 1 / 60;
      while (acc >= step) {
        acc -= step;
        const events = sim.step(step);
        roundT += step;
        for (const e of events) {
          if (e.type === 'crash') { burst(e.x, e.y, '💥'); shakeT = 0.5; wrap.classList.add('shake'); SFX.crash(); setTimeout(() => wrap.classList.remove('shake'), 600); }
          if (e.type === 'passed' && e.car.mood === 'happy') sparkle(e.car.cx, e.car.cy);
        }
        if (sim.crashed) { running = false; setTimeout(() => endRound(true), 700); break; }
        if (roundT >= stage.roundLen) { endRound(false); break; }
      }
      $('timer-fill').style.width = Math.max(0, 100 - roundT / stage.roundLen * 100) + '%';
    }
    if (shakeT > 0) shakeT -= dt;
    if (pulse.t > 0) pulse.t = Math.max(0, pulse.t - dt * 1.2);
    stepFx(dt);
    const s = sim || idleSim;
    if (s) drawScene(s, t);
    fxc.clearRect(0, 0, W, W);
    drawFx(fxc);
  }

  // ---------- boot ----------
  loadStage(Math.min(unlocked, STAGES.length) - 1);
  resize();
  requestAnimationFrame(frame);
})();
