/* Traffic-light game for small children: rendering, UI, sounds. No written text – icons only. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const view = $('view'), fx = $('fx'), wrap = $('stage-wrap');
  const ctx = view.getContext('2d'), fxc = fx.getContext('2d');
  const W = 600;
  const MOOD = { happy: '😊', sad: '😢', angry: '😠', hmm: '😕', sleepy: '😴', scared: '😨', crash: '😵' };
  const COLORS = ['#ff595e', '#1982c4', '#ffca3a', '#8ac926', '#6a4c93', '#ff924c'];

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
    const icons = { ns: '🚗⬍', ew: '🚗⬌', safe: '🚗🚗', turn: '🚗↲', flow: '🚗🚗🚗' };
    stage.goals.forEach(g => {
      const d = document.createElement('div');
      d.className = 'goal' + (goalsDone[g] ? ' done' : '');
      d.innerHTML = `<span>${icons[g]}</span><span class="chk">⭐</span>`;
      el.appendChild(d);
    });
  }

  // ---------- UI: toggles ----------
  const svgNS = 'http://www.w3.org/2000/svg';
  function lightSVG(bulbs, active, arrowOn, vertical) {
    // bulbs: array of 'R','Y','G','A'
    const n = bulbs.length, w = vertical ? 26 : 16 + n * 16, h = vertical ? 16 + n * 16 : 26;
    const col = { R: '#ff3b30', Y: '#ffcc00', G: '#34c759', A: '#34c759' };
    let s = `<svg viewBox="0 0 64 64"><rect x="${(64 - w) / 2}" y="${(64 - h) / 2}" width="${w}" height="${h}" rx="7" fill="#333"/>`;
    bulbs.forEach((b, i) => {
      const cx = vertical ? 32 : (64 - w) / 2 + 8 + 8 + i * 16, cy = vertical ? (64 - h) / 2 + 16 + i * 16 : 32;
      const on = b === 'A' ? arrowOn : active === b;
      if (b === 'A') {
        s += `<circle cx="${cx}" cy="${cy}" r="6" fill="#111"/>` +
             `<path d="M${cx + 4} ${cy} L${cx - 4} ${cy} M${cx - 1} ${cy - 3} L${cx - 4} ${cy} L${cx - 1} ${cy + 3}" stroke="${on ? col.A : '#2a4a2f'}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
      } else {
        s += `<circle cx="${cx}" cy="${cy}" r="6" fill="${on ? col[b] : '#222'}" stroke="${on ? '#fff' : 'none'}" stroke-width="1"/>`;
      }
    });
    return s + '</svg>';
  }
  function laneSVG(on) {
    let s = `<svg viewBox="0 0 64 64"><rect x="${on ? 12 : 20}" y="4" width="${on ? 40 : 24}" height="56" fill="#555" rx="3"/>`;
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
      case 'nsLight': return lightSVG(['R', 'G'], cfg.lights.ns, false, true);
      case 'ewLight': return lightSVG(['R', 'G'], cfg.lights.ew, false, false);
      case 'yellow': return cfg.yellow ? lightSVG(['G', 'Y', 'R'], 'Y', false, false) : lightSVG(['G', 'R'], '', false, false);
      case 'arrow': return cfg.arrow ? lightSVG(['G', 'Y', 'R', 'A'], '', true, false) : lightSVG(['G', 'Y', 'R'], '', false, false);
      case 'lane': return laneSVG(cfg.turnLane);
    }
    return '';
  }
  const LBL = { nsLight: '⬍', ewLight: '⬌', yellow: '🟡', arrow: '↲', lane: '🛣️' };
  function renderToggles() {
    const el = $('toggles'); el.innerHTML = '';
    stage.toggles.forEach(kind => {
      const b = document.createElement('button');
      b.className = 'toggle'; b.dataset.kind = kind;
      b.innerHTML = toggleIcon(kind) + `<span class="lbl">${LBL[kind]}</span><span class="hand">👆</span>`;
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
    [[60, 80, '🌳'], [520, 120, '🌳'], [80, 520, '🌲'], [540, 500, '🏠'], [140, 540, '🌼'], [560, 60, '🌸']].forEach(t => c.fillText(t[2], t[0], t[1]));
    // roads
    c.fillStyle = '#5c5f63';
    c.fillRect(260, 0, 80, W);                 // N-S
    c.fillRect(0, 260, W, 80);                 // E-W
    if (lane) { c.beginPath(); c.moveTo(340, 0); c.lineTo(380, 0); c.lineTo(380, 372); c.lineTo(340, 452); c.closePath(); c.fill(); }
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
  function arrowStraight(c, x, y1, y2) {
    c.beginPath(); c.moveTo(x, y1); c.lineTo(x, y2); c.moveTo(x - 7, y2 - 9); c.lineTo(x, y2); c.lineTo(x + 7, y2 - 9); c.stroke();
  }
  function arrowTurn(c, x, y) {
    c.beginPath(); c.moveTo(x, y); c.lineTo(x, y + 26); c.quadraticCurveTo(x, y + 40, x - 14, y + 40); c.lineTo(x - 22, y + 40);
    c.moveTo(x - 14, y + 32); c.lineTo(x - 22, y + 40); c.lineTo(x - 14, y + 48); c.stroke();
  }

  function drawLightHead(c, x, y, bulbs, active, arrowOn, arrowYellow, axis) {
    const w = 16 + bulbs.length * 26, h = 34;
    c.fillStyle = '#2b2b2b'; roundRect(c, x, y, w, h, 8); c.fill();
    c.strokeStyle = '#111'; c.lineWidth = 2; c.stroke();
    const col = { R: '#ff3b30', Y: '#ffcc00', G: '#34c759' };
    bulbs.forEach((b, i) => {
      const cx = x + 8 + 13 + i * 26, cy = y + h / 2;
      if (b === 'A') {
        c.fillStyle = '#111'; c.beginPath(); c.arc(cx, cy, 10, 0, Math.PI * 2); c.fill();
        c.strokeStyle = arrowOn ? '#34c759' : arrowYellow ? '#ffcc00' : '#28402c'; c.lineWidth = 3; c.lineCap = 'round';
        c.beginPath(); c.moveTo(cx + 6, cy); c.lineTo(cx - 6, cy); c.moveTo(cx - 2, cy - 4); c.lineTo(cx - 6, cy); c.lineTo(cx - 2, cy + 4); c.stroke();
        if (arrowOn) glow(c, cx, cy, '#34c759');
      } else {
        const on = active === b;
        c.fillStyle = on ? col[b] : '#1a1a1a'; c.beginPath(); c.arc(cx, cy, 10, 0, Math.PI * 2); c.fill();
        if (on) glow(c, cx, cy, col[b]);
      }
    });
    // axis marker
    c.font = 'bold 22px sans-serif'; c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.strokeStyle = '#333'; c.lineWidth = 4; c.lineJoin = 'round';
    c.strokeText(axis, x - 16, y + h / 2); c.fillText(axis, x - 16, y + h / 2);
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

  function drawLights(c, s) {
    const L = s.lights, cfgS = s.cfg;
    const bulbs = cfgS.yellow ? ['G', 'Y', 'R'] : ['G', 'R'];
    const nsBulbs = cfgS.arrow ? bulbs.concat(['A']) : bulbs;
    const wNS = 16 + nsBulbs.length * 26;
    drawLightHead(c, 248 - wNS, 96, nsBulbs, L.ns, L.arrow, L.arrowYellow, '⬍');
    const wEW = 16 + bulbs.length * 26;
    drawLightHead(c, 248 - wEW, 470, bulbs, L.ew, false, false, '⬌');
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
    drawLights(ctx, s);
    const cars = s.cars.slice().sort((a, b) => a.cy - b.cy);
    for (const car of cars) drawCar(ctx, car, t);
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
