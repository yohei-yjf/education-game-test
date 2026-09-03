/*
 * Intersection simulation (pure logic, no rendering).
 * Left-hand traffic (Japan). World is 600x600, intersection centre at (300,300).
 *
 * Approaches:  S = southbound (comes from the top),  N = northbound (from the bottom)
 *              E = eastbound  (from the left),       W = westbound  (from the right)
 * Lanes:       S0 = inner southbound lane (x=320)  – straight cars, or right-turn cars
 *              S1 = outer southbound lane (x=360)  – straight cars when the turn lane exists
 *              N (x=280), E (y=280), W (y=320)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VMAX = 120, ACC = 150, DEC = 150, CAR_LEN = 30, CAR_WID = 20, GAP = 10;
  const PHASES = ['nsG', 'nsY', 'nsA', 'nsAY', 'all1', 'ewG', 'ewY', 'all2'];

  function geometry(turnLane) {
    const x1 = 260, x2 = turnLane ? 380 : 340, y1 = 260, y2 = 340;
    return { box: { x1, x2, y1, y2 }, stop: { S: y1 - 8, N: y2 + 8, E: x1 - 8, W: x2 + 8 } };
  }

  function bezier(p0, p1, p2, n) {
    const out = [];
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      out.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
                u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
    }
    return out;
  }

  function buildPath(pts) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
      cum.push(cum[i - 1] + Math.hypot(dx, dy));
    }
    return { pts, cum, total: cum[cum.length - 1] };
  }

  function pointAt(path, s) {
    const { pts, cum } = path;
    if (s <= 0) return seg(pts[0], pts[1], 0);
    for (let i = 1; i < pts.length; i++) {
      if (s <= cum[i]) return seg(pts[i - 1], pts[i], (s - cum[i - 1]) / (cum[i] - cum[i - 1]));
    }
    return seg(pts[pts.length - 2], pts[pts.length - 1], 1);
  }
  function seg(a, b, t) {
    return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, angle: Math.atan2(b[1] - a[1], b[0] - a[0]) };
  }

  function laneDefs(turnLane) {
    const g = geometry(turnLane);
    const defs = {};
    defs.S0s = { key: 'S0', approach: 'S', kind: 'straight',
      path: buildPath([[320, -60], [320, 660]]), stopS: g.stop.S + 60 };
    defs.S1s = { key: 'S1', approach: 'S', kind: 'straight',
      path: buildPath([[360, -60], [360, 370], [320, 450], [320, 660]]), stopS: g.stop.S + 60 };
    const turnPts = [[320, -60], [320, g.stop.S]].concat(bezier([320, g.stop.S], [322, 326], [246, 320], 10), [[-60, 320]]);
    defs.S0t = { key: 'S0', approach: 'S', kind: 'turn',
      path: buildPath(turnPts), stopS: g.stop.S + 60, waitS: g.stop.S + 60 + 30 };
    defs.N = { key: 'N', approach: 'N', kind: 'straight',
      path: buildPath([[280, 660], [280, -60]]), stopS: 660 - g.stop.N };
    defs.E = { key: 'E', approach: 'E', kind: 'straight',
      path: buildPath([[-60, 280], [660, 280]]), stopS: g.stop.E + 60 };
    defs.W = { key: 'W', approach: 'W', kind: 'straight',
      path: buildPath([[660, 320], [-60, 320]]), stopS: 660 - g.stop.W };
    return defs;
  }

  function create(opts) {
    const cfg = Object.assign({
      mode: 'auto',            // 'auto' | 'manual'
      yellow: true, arrow: false, turnLane: false,
      lights: { ns: 'R', ew: 'R' },   // manual mode
      green: 5, greenEW: 5, yellowDur: 2.5, arrowDur: 3, allRed: 1,
      spawns: [],              // {lane, every, offset, until}
      decel: DEC,
    }, opts || {});

    const sim = {
      cfg, t: 0, cars: [], nextId: 1, crashed: false, crashAt: null,
      phase: 'nsG', phaseT: 0,
      lights: { ns: 'R', ew: 'R', arrow: false, arrowYellow: false },
      stats: { passed: { S: 0, N: 0, E: 0, W: 0, turn: 0, straightS: 0 }, crashes: 0, sadTurn: 0, angry: 0, maxTurnWait: 0, stuck: 0 },
      geo: geometry(cfg.turnLane), lanes: laneDefs(cfg.turnLane),
    };
    cfg.spawns.forEach(sp => { sp._next = sp.offset || 0; sp._count = 0; });

    function enabled(name) {
      switch (name) {
        case 'nsY': case 'ewY': return !!cfg.yellow;
        case 'nsA': return !!cfg.arrow;
        case 'nsAY': return !!cfg.arrow && !!cfg.yellow;
        case 'all1': case 'all2': return !!cfg.yellow;
        default: return true;
      }
    }
    function phaseDur(name) {
      switch (name) {
        case 'nsG': return cfg.green;
        case 'ewG': return cfg.greenEW;
        case 'nsY': case 'ewY': case 'nsAY': return cfg.yellowDur;
        case 'nsA': return cfg.arrowDur;
        default: return cfg.allRed;
      }
    }
    function applyPhase() {
      const p = sim.phase;
      sim.lights.arrow = p === 'nsA';
      sim.lights.arrowYellow = p === 'nsAY';
      sim.lights.ns = p === 'nsG' ? 'G' : p === 'nsY' ? 'Y' : 'R';
      sim.lights.ew = p === 'ewG' ? 'G' : p === 'ewY' ? 'Y' : 'R';
    }
    function updateLights(dt) {
      if (cfg.mode === 'manual') {
        sim.lights.ns = cfg.lights.ns; sim.lights.ew = cfg.lights.ew; sim.lights.arrow = false; sim.lights.arrowYellow = false;
        return;
      }
      sim.phaseT += dt;
      let guard = 0;
      while (sim.phaseT >= phaseDur(sim.phase) && guard++ < 20) {
        sim.phaseT -= phaseDur(sim.phase);
        let i = PHASES.indexOf(sim.phase);
        do { i = (i + 1) % PHASES.length; } while (!enabled(PHASES[i]));
        sim.phase = PHASES[i];
      }
      applyPhase();
    }
    applyPhase();
    if (cfg.mode === 'manual') updateLights(0);

    function spawn(laneName) {
      const def = sim.lanes[laneName];
      const blocked = sim.cars.some(c => c.lane.key === def.key && c.s < CAR_LEN + GAP + 20);
      if (blocked) return null;
      const car = {
        id: sim.nextId++, lane: def, laneName, approach: def.approach, kind: def.kind,
        s: 0, v: VMAX * 0.7, committed: false, turnGo: false, stuck: false, passed: false,
        wait: 0, waitRed: 0, waitBlocked: 0, happy: 0, mood: null, color: sim.nextId % 6,
        x: 0, y: 0, angle: 0, cx: 0, cy: 0,
      };
      sim.cars.push(car);
      return car;
    }
    sim.spawn = spawn;

    function lightFor(car) {
      if (car.kind === 'turn' && sim.lights.arrow) return 'G';
      if (car.kind === 'turn' && sim.lights.arrowYellow) return 'Y';
      return car.approach === 'S' || car.approach === 'N' ? sim.lights.ns : sim.lights.ew;
    }

    function oncomingForTurn() {
      return sim.cars.some(c => c.lane.key === 'N' && !c.passed && (() => {
        const y = 660 - c.s;               // front y of a northbound car
        return y > 240 && y < 480;
      })());
    }

    function inBox(x, y, m) {
      const b = sim.geo.box;
      return x > b.x1 - m && x < b.x2 + m && y > b.y1 - m && y < b.y2 + m;
    }

    function stepCar(car, dt) {
      const def = car.lane;
      let obstacle = Infinity;             // distance (from front) to the nearest thing we must stop for

      // follow the leader in the same lane
      let leader = null, best = Infinity;
      for (const o of sim.cars) {
        if (o === car || o.passed || o.lane.key !== def.key) continue;
        if (o.laneName !== car.laneName && car.s > def.stopS) continue; // diverged after the line
        const d = o.s - car.s;
        if (d > 0 && d < best) { best = d; leader = o; }
      }
      if (leader && best < 260) obstacle = Math.min(obstacle, best - CAR_LEN - GAP);

      // traffic light
      const dLine = def.stopS - car.s;
      const light = lightFor(car);
      if (!car.committed) {
        if (light === 'G') {
          if (car.kind === 'turn' && !sim.lights.arrow && oncomingForTurn()) obstacle = Math.min(obstacle, dLine); // wait for a gap
          else if (dLine <= 0) car.committed = true;
        } else {
          const canStop = car.v * car.v / (2 * cfg.decel) <= dLine + 2;
          if (light === 'Y' && !canStop) car.committed = true;   // too close: go through on yellow
          else obstacle = Math.min(obstacle, dLine);             // brake (even past the line: stuck!)
        }
      }

      // speed control
      const target = obstacle === Infinity ? VMAX : Math.min(VMAX, Math.sqrt(2 * cfg.decel * Math.max(0, obstacle)));
      if (target > car.v) car.v = Math.min(target, car.v + ACC * dt);
      else car.v = Math.max(target, car.v - cfg.decel * dt);
      car.s += car.v * dt;
      if (car.s >= def.path.total) car.passed = true;

      const p = pointAt(def.path, car.s);
      car.x = p.x; car.y = p.y; car.angle = p.angle;
      car.cx = p.x - Math.cos(p.angle) * CAR_LEN / 2;
      car.cy = p.y - Math.sin(p.angle) * CAR_LEN / 2;

      // moods
      const stopped = car.v < 3;
      if (stopped) {
        car.wait += dt;
        if (light === 'G') car.waitBlocked += dt; else car.waitRed += dt;
      } else if (car.v > 40) {
        if (car.wait > 1.5 && car.committed && !car.happy) car.happy = 1.5;
        car.wait = 0; car.waitRed = 0;
      }
      if (car.happy > 0) car.happy -= dt;
      car.stuck = stopped && !car.committed && inBox(car.cx, car.cy, -4);
      if (car.kind === 'turn') sim.stats.maxTurnWait = Math.max(sim.stats.maxTurnWait, car.waitBlocked);
      const sadAt = car.kind === 'turn' && cfg.arrow ? 12 : 3;
      if (car.waitBlocked > sadAt && !car.flaggedSad) {
        car.flaggedSad = true;
        if (car.kind === 'turn') sim.stats.sadTurn++; else sim.stats.angry++;
      }
      if (car.stuck && !car.flaggedStuck) { car.flaggedStuck = true; sim.stats.stuck++; }

      if (car.stuck) car.mood = 'scared';
      else if (car.happy > 0) car.mood = 'happy';
      else if (car.waitBlocked > sadAt) car.mood = car.kind === 'turn' ? 'sad' : 'angry';
      else if (car.waitBlocked > sadAt - 1.2) car.mood = 'hmm';
      else if (cfg.mode === 'manual' && car.waitRed > 3.5) car.mood = 'sleepy';
      else car.mood = null;
    }

    function extents(c) {
      const co = Math.abs(Math.cos(c.angle)), si = Math.abs(Math.sin(c.angle));
      return { hx: co * CAR_LEN / 2 + si * CAR_WID / 2 - 2, hy: si * CAR_LEN / 2 + co * CAR_WID / 2 - 2 };
    }
    function overlap(a, b) {
      const ea = extents(a), eb = extents(b);
      return Math.abs(a.cx - b.cx) < ea.hx + eb.hx && Math.abs(a.cy - b.cy) < ea.hy + eb.hy;
    }

    function checkCrash(events) {
      const cars = sim.cars;
      for (let i = 0; i < cars.length; i++) {
        const a = cars[i];
        if (!inBox(a.cx, a.cy, 12)) continue;
        for (let j = i + 1; j < cars.length; j++) {
          const b = cars[j];
          if (b.approach === a.approach && b.kind === a.kind) continue;
          if (b.approach === a.approach && b.lane.key !== a.lane.key) continue;
          if (!inBox(b.cx, b.cy, 12)) continue;
          if (overlap(a, b)) {
            sim.crashed = true; sim.stats.crashes++;
            sim.crashAt = { x: (a.cx + b.cx) / 2, y: (a.cy + b.cy) / 2 };
            a.mood = b.mood = 'crash';
            events.push({ type: 'crash', x: sim.crashAt.x, y: sim.crashAt.y });
            return;
          }
        }
      }
    }

    sim.step = function (dt) {
      const events = [];
      if (sim.crashed) return events;
      sim.t += dt;
      updateLights(dt);
      for (const sp of cfg.spawns) {
        if (sp.until != null && sim.t > sp.until) continue;
        if (sp.count != null && sp._count >= sp.count) continue;
        if (sim.t >= sp._next) {
          if (spawn(sp.lane)) { sp._next += sp.every; sp._count++; }
        }
      }
      for (const car of sim.cars) stepCar(car, dt);
      for (const car of sim.cars) {
        if (!car.counted && car.s > car.lane.stopS + 110) {
          car.counted = true;
          sim.stats.passed[car.approach]++;
          if (car.kind === 'turn') sim.stats.passed.turn++;
          else if (car.approach === 'S') sim.stats.passed.straightS++;
          events.push({ type: 'passed', car });
        }
      }
      sim.cars = sim.cars.filter(c => !c.passed);
      checkCrash(events);
      return events;
    };

    // optional warm-up so a round starts with traffic already built up
    if (cfg.warmup > 0) {
      const n = Math.round(cfg.warmup * 60);
      for (let i = 0; i < n && !sim.crashed; i++) sim.step(1 / 60);
      sim.stats.passed = { S: 0, N: 0, E: 0, W: 0, turn: 0, straightS: 0 };
      sim.t = 0;
      cfg.spawns.forEach(sp => { sp._next -= cfg.warmup; });
    }

    return sim;
  }

  return { create, geometry, pointAt, CAR_LEN, CAR_WID, VMAX };
});
