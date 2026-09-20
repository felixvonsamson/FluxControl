import { config } from '../config.js';
import { transferPrice } from '../economy.js';

// Paired-redispatch "balance scale" card. The player picks two nodes on the
// board, then drags one pan up (or presses its ▲ button): that node produces
// more, the other one less by the same amount, so the grid stays balanced by
// construction. Ported from the iOS app's RedispatchScale.
//
// Cost is per node on its *net* offset from the original level, so undoing an
// earlier shift refunds it. The ▲ buttons show that exact price change (a
// refund when they walk a node back toward its zero); the running total lives
// on the Confirm button.

const PX_PER_MW = 6;      // drag distance per MW
const CLAMP_TRAVEL = 56;  // visual clamp of a pan around the resting line
const W = 320;            // card inner width
const PAN_W = 140;
const PAN_H = 80;
const H = 2 * (CLAMP_TRAVEL + PAN_H / 2); // scale area height
const CENTER_Y = H / 2;

const hex = (n) => '#' + n.toString(16).padStart(6, '0');

const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(n);

/**
 * @param {HTMLElement} root  container element (starts hidden)
 * @param {object} opts
 *   onTransfer(raisingId, loweringId, mw)  apply a transfer (mw may be negative)
 *   onClear()                              clear the selected pair
 *   isFree()                               redispatch costs nothing (level already solved)
 * @returns {{ update(network, view) }}  view = { mode, pair }
 */
export function initRedispatchScale(root, { onTransfer, onClear, isFree }) {
  root.innerHTML = `
    <div data-header class="flex items-center justify-between gap-2" style="width:${W}px">
      <span data-hint class="text-sm font-semibold text-gray-100"></span>
      <button data-clear aria-label="Clear pair" title="Clear pair"
              class="ml-auto text-gray-400 hover:text-white text-lg leading-none px-1">✕</button>
    </div>
    <div data-scale style="width:${W}px">
      <div class="relative" style="height:${H}px">
        <svg data-beam class="absolute inset-0 pointer-events-none" width="${W}" height="${H}"
             viewBox="0 0 ${W} ${H}"></svg>
        ${[0, 1].map(i => `
          <div data-pan="${i}" class="absolute top-0 rounded-2xl py-2 text-center select-none touch-none
                                     cursor-grab active:cursor-grabbing bg-gray-800/95 border border-white/10
                                     shadow-md shadow-black/40"
               style="width:${PAN_W}px; left:${i === 0 ? 0 : W - PAN_W}px; height:${PAN_H}px">
            <div data-inj class="text-2xl font-bold leading-8"></div>
            <div data-off class="text-sm font-semibold text-gray-200"></div>
          </div>`).join('')}
      </div>
      <div class="flex justify-between mt-1.5">
        ${[0, 1].map(i => `
          <button data-up="${i}" style="width:${PAN_W}px"
                  class="py-2 rounded-xl bg-gray-800/95 hover:bg-gray-700 active:bg-gray-900
                         border border-white/10 text-sm font-semibold text-white">
            ▲ <span data-price></span>
          </button>`).join('')}
      </div>
    </div>`;

  const q = (sel) => root.querySelector(sel);
  const header = q('[data-header]');
  const hint = q('[data-hint]');
  const scaleEl = q('[data-scale]');
  const beam = q('[data-beam]');
  const pans = [0, 1].map(i => q(`[data-pan="${i}"]`));
  const ups = [0, 1].map(i => q(`[data-up="${i}"]`));

  let pair = [];
  const transfer = (i, mw) => onTransfer(pair[i], pair[1 - i], mw);

  q('[data-clear]').addEventListener('click', () => onClear());
  ups.forEach((btn, i) => btn.addEventListener('click', () => transfer(i, 1)));

  // Vertical drag on a pan: up raises that node. Whole-MW steps only, so the
  // cost stays integral and the partner pan tracks in lockstep.
  pans.forEach((pan, i) => {
    let startY = null, emitted = 0;
    pan.addEventListener('pointerdown', (e) => {
      if (pair.length < 2) return;
      startY = e.clientY;
      emitted = 0;
      pan.setPointerCapture(e.pointerId);
    });
    pan.addEventListener('pointermove', (e) => {
      if (startY === null) return;
      const steps = Math.round((startY - e.clientY) / PX_PER_MW);
      if (steps !== emitted) {
        const delta = steps - emitted;
        emitted = steps;
        transfer(i, delta);
      }
    });
    const end = () => { startY = null; };
    pan.addEventListener('pointerup', end);
    pan.addEventListener('pointercancel', end);
  });

  const travel = (offset) => Math.max(-CLAMP_TRAVEL, Math.min(CLAMP_TRAVEL, offset * PX_PER_MW));

  function drawBeam(yA, yB) {
    const xA = PAN_W / 2, xB = W - PAN_W / 2;
    const tick = (x) => `
      <line x1="${x}" y1="${CENTER_Y - CLAMP_TRAVEL}" x2="${x}" y2="${CENTER_Y + CLAMP_TRAVEL}"
            stroke="currentColor" stroke-opacity="0.15" stroke-width="2"/>
      <line x1="${x - 14}" y1="${CENTER_Y}" x2="${x + 14}" y2="${CENTER_Y}"
            stroke="currentColor" stroke-opacity="0.5" stroke-width="2"/>`;
    const mx = (xA + xB) / 2, my = (yA + yB) / 2;
    beam.setAttribute('class', 'absolute inset-0 pointer-events-none text-gray-300');
    beam.innerHTML = `
      ${tick(xA)}${tick(xB)}
      <line x1="${xA}" y1="${yA}" x2="${xB}" y2="${yB}" stroke="${hex(config.colors.redispatch)}"
            stroke-width="7" stroke-linecap="round"/>
      <circle cx="${xA}" cy="${yA}" r="5" fill="#fff"/><circle cx="${xB}" cy="${yB}" r="5" fill="#fff"/>
      <polygon points="${mx},${my + 2} ${mx - 17},${my + 34} ${mx + 17},${my + 34}"
               fill="currentColor" fill-opacity="0.45"/>`;
  }

  const fmtMoney = (n, free) => {
    if (free) return '<span class="text-gray-300">free</span>';
    if (n < 0) return `<span class="text-emerald-400">refund ${-n}€</span>`;
    return `<span class="text-amber-300">${n}€</span>`;
  };

  function update(network, view) {
    pair = view.pair ?? [];
    if (view.mode !== 'redispatch') { root.style.display = 'none'; return; }
    root.style.display = 'block';

    const complete = pair.length === 2;
    scaleEl.style.display = complete ? 'block' : 'none';
    // The header only exists while picking the pair; tapping a selected node
    // on the board drops it, so a finished card needs no chrome.
    header.style.display = complete ? 'none' : 'flex';
    q('[data-clear]').style.visibility = pair.length ? 'visible' : 'hidden';
    hint.textContent = pair.length === 1 ? 'Select one more node' : 'Select two nodes';

    const adjustments = network.redispatch.adjustments;
    const free = isFree();

    if (complete) {
      const offsets = pair.map(id => adjustments[id] || 0);
      const ys = offsets.map(o => CENTER_Y - travel(o));
      pans.forEach((pan, i) => {
        const node = network.nodes[pair[i]];
        pan.style.transform = `translateY(${ys[i] - PAN_H / 2}px)`;
        const inj = q(`[data-pan="${i}"] [data-inj]`);
        inj.textContent = Math.round(node.injection);
        inj.style.color = node.injection >= 0 ? hex(config.colors.nodeProd) : hex(config.colors.nodeCons);
        pan.querySelector('[data-off]').textContent = `${signed(offsets[i])} MW`;
        ups[i].querySelector('[data-price]').innerHTML =
          fmtMoney(transferPrice(offsets[i], offsets[1 - i]), free);
      });
      drawBeam(ys[0], ys[1]);
    }
  }

  return { update };
}
