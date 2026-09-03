/* Stage definitions shared by the game and the headless tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.STAGES = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const flow = (lane, every, offset) => ({ lane, every, offset });

  return [
    {
      // 1. 前が青なら横は赤。両方青だとぶつかる
      id: 1, icon: '🚦', mode: 'manual', roundLen: 7,
      toggles: ['nsLight', 'ewLight'],
      init: { yellow: false, arrow: false, turnLane: false, lights: { ns: 'R', ew: 'R' } },
      spawns: [flow('S0s', 2.2, 0.53), flow('N', 2.2, 1.3), flow('E', 2.2, 0.2), flow('W', 2.2, 1.63)],
      goals: ['ns', 'ew'],
    },
    {
      // 2. 黄色があると、ぶつからない
      id: 2, icon: '🟡', mode: 'auto', roundLen: 15,
      toggles: ['yellow'],
      init: { yellow: false, arrow: false, turnLane: false, green: 5, greenEW: 5, yellowDur: 3, allRed: 0 },
      spawns: [flow('S0s', 2.4, 0.05), flow('N', 2.4, 1.25), flow('E', 3, 1.0), flow('W', 3, 2.5)],
      goals: ['safe'],
    },
    {
      // 3. 右折信号がないと、右折の車が曲がれなくて悲しい
      id: 3, icon: '↲', mode: 'auto', roundLen: 20, warmup: 17.5,
      toggles: ['arrow'],
      init: { yellow: true, arrow: false, turnLane: true, green: 5, greenEW: 3, yellowDur: 1.5, arrowDur: 3, allRed: 1 },
      spawns: [flow('N', 1.6, 0.3), flow('S0t', 4.5, 0.5), flow('S1s', 3, 1.0), flow('E', 4, 1.0), flow('W', 4, 3.0)],
      goals: ['turn'],
    },
    {
      // 4. 右折レーンがあると、直進がスムーズ
      id: 4, icon: '🛣️', mode: 'auto', roundLen: 20, warmup: 17.5,
      toggles: ['lane'],
      init: { yellow: true, arrow: true, turnLane: false, green: 5, greenEW: 3, yellowDur: 1.5, arrowDur: 3, allRed: 1 },
      spawns: [flow('N', 1.6, 0.3), flow('S0t', 4, 0.5), flow('S0s', 2.2, 1.2), flow('E', 4, 1.0), flow('W', 4, 3.0)],
      goals: ['flow'],
    },
    {
      // 5. ぜんぶ組み合わせて、ベストな信号をつくろう
      id: 5, icon: '🏆', mode: 'auto', roundLen: 30,
      toggles: ['yellow', 'arrow', 'lane'],
      init: { yellow: false, arrow: false, turnLane: false, green: 5, greenEW: 3, yellowDur: 1.5, arrowDur: 3, allRed: 1 },
      spawns: [flow('N', 1.8, 0.3), flow('S0t', 4, 0.5), flow('S0s', 2.4, 0.3), flow('E', 3, 1.0), flow('W', 3, 2.5)],
      goals: ['safe', 'turn', 'flow'],
    },
  ];
});
