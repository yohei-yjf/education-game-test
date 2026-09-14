// Headless scenario checks: node test/run.js
const Sim = require('../sim.js');
const STAGES = require('../stages.js');
const assert = require('assert');

function run(stage, overrides, seconds, onStep) {
  const st = STAGES.find(s => s.id === stage);
  const opts = Object.assign({ mode: st.mode, warmup: st.warmup || 0 }, JSON.parse(JSON.stringify(st.init)), overrides || {});
  opts.spawns = st.spawns.map(s => Object.assign({}, s));
  if (opts.turnLane === false) opts.spawns = opts.spawns.map(s => s.lane === 'S1s' ? Object.assign({}, s, { lane: 'S0s' }) : s);
  if (opts.turnLane === true) opts.spawns = opts.spawns.map(s => s.lane === 'S0s' ? Object.assign({}, s, { lane: 'S1s' }) : s);
  const sim = Sim.create(opts);
  const dt = 1 / 60;
  const n = Math.round((seconds || st.roundLen) / dt);
  for (let i = 0; i < n; i++) { sim.step(dt); if (onStep) onStep(sim); if (sim.crashed) break; }
  return sim;
}
const fmt = s => `t=${s.t.toFixed(1)} crashed=${s.crashed} passed=${JSON.stringify(s.stats.passed)} sadTurn=${s.stats.sadTurn} angry=${s.stats.angry} maxTurnWait=${s.stats.maxTurnWait.toFixed(1)} stuck=${s.stats.stuck}`;

// Runs a manual-mode stage while applying a scripted sequence of light changes at given
// times, mimicking a child pressing the light buttons live - used for stage 2, where the
// player drives the signal directly instead of an auto-cycling phase.
function runScript(stage, overrides, steps, seconds) {
  const st = STAGES.find(s => s.id === stage);
  const opts = Object.assign({ mode: st.mode }, JSON.parse(JSON.stringify(st.init)), overrides || {});
  opts.spawns = st.spawns.map(s => Object.assign({}, s));
  const sim = Sim.create(opts);
  const dt = 1 / 60;
  const n = Math.round((seconds || st.roundLen) / dt);
  let si = 0;
  for (let i = 0; i < n; i++) {
    while (si < steps.length && sim.t >= steps[si].at) { Object.assign(sim.cfg.lights, steps[si].lights); si++; }
    sim.step(dt);
    if (sim.crashed) break;
  }
  return sim;
}

let s;
console.log('--- Stage 1');
s = run(1, { lights: { ns: 'G', ew: 'G' } }); console.log(' both G  ', fmt(s)); assert(s.crashed, 'both green must crash');
s = run(1, { lights: { ns: 'G', ew: 'R' } }); console.log(' ns G    ', fmt(s)); assert(!s.crashed && s.stats.passed.S > 0 && s.stats.passed.N > 0 && s.stats.passed.E === 0);
s = run(1, { lights: { ns: 'R', ew: 'G' } }); console.log(' ew G    ', fmt(s)); assert(!s.crashed && s.stats.passed.E > 0 && s.stats.passed.W > 0 && s.stats.passed.S === 0);
s = run(1, { lights: { ns: 'R', ew: 'R' } }); console.log(' both R  ', fmt(s)); assert(!s.crashed && s.stats.passed.S + s.stats.passed.E === 0);
assert(s.cars.some(c => c.mood === 'sleepy'), 'cars should be sleepy');

console.log('--- Stage 2');
s = runScript(2, {}, [], 10); console.log(' both red ', fmt(s)); assert(!s.crashed && s.stats.passed.S + s.stats.passed.E === 0, 'both red: nobody moves, nobody crashes');
s = runScript(2, {}, [{ at: 0, lights: { ns: 'G', ew: 'G' } }], 10); console.log(' both G   ', fmt(s)); assert(s.crashed, 'both green must crash');
s = runScript(2, {}, [{ at: 0, lights: { ns: 'G' } }, { at: 5.0, lights: { ns: 'R', ew: 'G' } }], 12);
console.log(' instant flip', fmt(s)); assert(s.crashed, 'switching ns straight to red + ew straight to green with no gap must crash');
s = runScript(2, {}, [{ at: 0, lights: { ns: 'G' } }, { at: 5.0, lights: { ns: 'Y' } }, { at: 6.0, lights: { ns: 'R' } }, { at: 6.5, lights: { ew: 'G' } }], 16);
console.log(' safe cycle', fmt(s)); assert(!s.crashed && s.stats.passed.S + s.stats.passed.N >= 2 && s.stats.passed.E + s.stats.passed.W >= 2, 'yellow then a pause before the cross street goes green must be safe and clear both goals');
s = runScript(2, {}, [{ at: 0, lights: { ns: 'G' } }, { at: 5.0, lights: { ns: 'Y' } }, { at: 6.0, lights: { ns: 'R' } }, { at: 6.5, lights: { ew: 'G' } }], 120);
console.log(' safe120  ', fmt(s)); assert(!s.crashed, 'stays safe over a long run once traffic is flowing');

console.log('--- Stage 3');
s = run(3, { arrow: false }); console.log(' no arrow ', fmt(s)); assert(!s.crashed); assert(s.stats.sadTurn >= 1, 'turners must be sad');
s = run(3, { arrow: true }); console.log(' arrow    ', fmt(s)); assert(!s.crashed && s.stats.sadTurn === 0 && s.stats.passed.turn >= 2, 'turners pass happily');
s = run(3, { arrow: true }, 120); console.log(' arrow120 ', fmt(s)); assert(!s.crashed && s.stats.sadTurn === 0);
s = run(3, { arrow: false }, 120); console.log(' noarr120 ', fmt(s)); assert(!s.crashed);

console.log('--- Stage 4');
s = run(4, { turnLane: false }); console.log(' no lane  ', fmt(s)); assert(!s.crashed); assert(s.stats.angry >= 1, 'straight cars must be angry'); const noLane = s.stats.passed.straightS;
s = run(4, { turnLane: true }); console.log(' lane     ', fmt(s)); assert(!s.crashed && s.stats.angry === 0 && s.stats.passed.straightS > noLane + 2);
s = run(4, { turnLane: true }, 120); console.log(' lane120  ', fmt(s)); assert(!s.crashed && s.stats.angry === 0);
s = run(4, { turnLane: false }, 120); console.log(' nolane120', fmt(s)); assert(!s.crashed);

console.log('--- Stage 5');
s = run(5, {}); console.log(' all off  ', fmt(s)); assert(s.crashed, 'all off should crash within the round');
s = run(5, { yellow: true }); console.log(' yellow   ', fmt(s)); assert(!s.crashed && (s.stats.sadTurn > 0 || s.stats.angry > 0));
s = run(5, { yellow: true, arrow: true }); console.log(' y+arrow  ', fmt(s)); assert(!s.crashed && s.stats.angry > 0);
s = run(5, { yellow: true, arrow: true, turnLane: true }); console.log(' all on   ', fmt(s)); assert(!s.crashed && s.stats.sadTurn === 0 && s.stats.angry === 0);
s = run(5, { yellow: true, arrow: true, turnLane: true }, 180); console.log(' all on180', fmt(s)); assert(!s.crashed && s.stats.sadTurn === 0 && s.stats.angry === 0);
s = run(5, { yellow: true, turnLane: true }, 60); console.log(' y+lane60 ', fmt(s)); assert(!s.crashed);
console.log('ALL OK');
