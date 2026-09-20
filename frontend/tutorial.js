import { Application, Container, Graphics } from 'pixi.js';
import { config, themes } from './config.js';
import { updateNetwork, toggleSwitch } from './network/updateNetwork.js';
import { calculatePowerFlow } from './network/powerFlow.js';
import { createNetwork } from './network/createNetwork.js';
import { applyTransfer, nextPair } from './network/redispatch.js';
import { initRedispatchScale } from './ui/redispatchScale.js';
import { stashGameState } from './tutorialSession.js';

// ── Tutorial network ──────────────────────────────────────────────────
// Line limits will be tuned later; for now all 50 (same as game default).
const TUTORIAL_NETWORK_BASE = {
  nodes: {
    '0': { id: '0', injection: 15, x: 200, y: 150 },
    '1': { id: '1', injection: 19, x: 400, y: 150 },
    '2': { id: '2', injection: -84, x: 100, y: 300 },
    '3': { id: '3', injection: -31, x: 300, y: 300 },
    '4': { id: '4', injection: 81, x: 500, y: 300 },
  },
  lines: {
    'L0-1': { id: 'L0-1', from_node: '0', to_node: '1', flow: 0, limit: 50 },
    'L0-2': { id: 'L0-2', from_node: '0', to_node: '2', flow: 0, limit: 50 },
    'L0-3': { id: 'L0-3', from_node: '0', to_node: '3', flow: 0, limit: 50 },
    'L1-3': { id: 'L1-3', from_node: '1', to_node: '3', flow: 0, limit: 50 },
    'L1-4': { id: 'L1-4', from_node: '1', to_node: '4', flow: 0, limit: 50 },
    'L2-3': { id: 'L2-3', from_node: '2', to_node: '3', flow: 0, limit: 50 },
    'L3-4': { id: 'L3-4', from_node: '3', to_node: '4', flow: 0, limit: 50 },
  },
  cost: 0,
  redispatch: { cost: 0, unbalance: 0, adjustments: {} },
};

// ── Tutorial steps ────────────────────────────────────────────────────
const STEPS = [
  { text: 'Welcome! This is a power network. <b class="tut-prod">blue nodes</b> produce electricity, <b class="tut-cons">orange nodes</b> consume it. Power flows through the lines.' },
  { text: 'The maximal capacity of all lines is 50. Some lines are <b class="tut-congested">congested</b> because they carry more power than their capacity allows. Your goal: redistribute the power so no line exceeds its capacity.' },
  { text: 'You can reroute power by toggling <b class="tut-switch">switches</b>: the small circles at each end of each line. Try switching this one.' },
  { text: 'Good! When you toggle a switch, that end of the line is moved from the <b>main node</b> to the <b>bypass node</b> (the ring around the main node). Note that electricity is always injected/drawn from the main node, not the bypass node.' },
  { text: 'The main and bypass nodes are <b>completely independent</b> of each other. Power flowing through one does not affect the other. The animation above illustrates this separation. In this case nothing else is connected to the bypass node so you basically disconnected this line.' },
  { text: 'Try switching another line on the bypass node.' },
  { text: 'Great! Now all lines are within their capacity. You just solved your first congestion problem!' },
  { text: 'Here is another animation. Both lines are now connected to the bypass node, which acts as a completely separate node. This is called a <b>topological measure</b>.' },
  { text: 'To reset all switches of a node back to the main bus, <b>click on the node itself</b>. Try it.' },
  { text: "There is always a solution using only topological measures. However, if you can't find it, use <b class=\"tut-redispatch\">redispatch</b>. Click the button on the bottom right to enter redispatch mode." },
  { text: '<b>Select two nodes</b>, then drag one up or down to shift power around. Redispatch conserves the net power on the grid and it costs money.' },
  { text: 'Perfect! Click the <b class="tut-validate">price tag button</b> to validate and pay for the redispatch.' },
  { text: "You're all set! Click <b>Start Playing</b> to tackle real levels.", final: true },
];

// ── Per-step control rules ────────────────────────────────────────────
// switches: null=none, 'all'=all, [ids]=specific list
// nodeClick: null | nodeId
// redispatch: boolean — allow clicking the Redispatch button
// adjustments: boolean — allow injection up/down
// validate: boolean — allow clicking validate
// nextDisabled: boolean
// nextLabel: string
// highlightSwitches: [] — switch IDs to pulse green on canvas
// highlightNode: null | nodeId
// highlightRedispatch: boolean
// highlightValidate: boolean
// showMoney: boolean
// animation: null | 'bypass1' | 'bypass2'
const CTRL = [
  // 0 — Welcome
  {},
  // 1 — Line limits
  {},
  // 2 — Toggle L3-4_from (node 3 side of L3-4: from_node='3', to_node='4' → FROM switch)
  { switches: ['L3-4_from'], nextDisabled: true, nextLabel: 'toggle the switch', highlightSwitches: ['L3-4_from'] },
  // 3 — Bypass explanation
  {},
  // 4 — Animation: bypass ring + L3b-4 moving
  { animation: 'bypass1' },
  // 5 — Toggle L2-3_to (node 3 side of L2-3: from_node='2', to_node='3' → TO switch)
  { switches: ['L2-3_to'], nextDisabled: true, nextLabel: 'toggle second switch', highlightSwitches: ['L2-3_to'] },
  // 6 — Great!
  {},
  // 7 — Animation: bypass ring + both lines moving
  { animation: 'bypass2' },
  // 8 — Click node 3 to reset
  { nodeClick: '3', nextDisabled: true, nextLabel: 'reset switches', highlightNode: '3' },
  // 9 — Enter redispatch mode
  { redispatch: true, nextDisabled: true, nextLabel: 'toggle redispatch mode', highlightRedispatch: true },
  // 10 — Make adjustments until solved
  { adjustments: true, nextDisabled: true, nextLabel: 'solve the problem' },
  // 11 — Validate (only action)
  { validate: true, nextDisabled: true, nextLabel: 'validate redispatch', highlightValidate: true, showMoney: true },
  // 12 — Final
  { final: true },
];

// ── Module-scope state ────────────────────────────────────────────────
{
  const t = document.documentElement.dataset.theme || 'dark';
  if (t !== 'dark') Object.assign(config.colors, themes[t]);
}

let step = 0;
const stepSnapshots = {};  // network JSON snapshots indexed by step, for Back navigation
let app, world, ctx, callbacks;
const settings = { mode: 'switches', pair: [] };
let tutHighlightGfx = null;  // overlay for pulsing circles (on app.stage)
let tutAnimType = null;      // 'bypass1' | 'bypass2' | null
let tutAnimStartTime = 0;    // timestamp when current animation loop began

// The real game state is restored by main.js on arrival, so a late tutorial write
// before the page unloads can't clobber it.
function exitTutorial() {
  window.location.href = '/';
}

function getCtrl() { return CTRL[step] ?? {}; }
function getNetwork() { return JSON.parse(sessionStorage.getItem('network')); }

// Compute switch screen-space position in world coordinates.
// Matches createNetwork.js: offset 15 units from node center along line.
function getSwitchPos(network, switchId) {
  const [lineId, end] = switchId.split('_');
  const line = network?.lines[lineId];
  if (!line) return null;
  const from = network.nodes[line.from_node];
  const to = network.nodes[line.to_node];
  if (!from || !to) return null;
  const dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  if (end === 'from') return { x: from.x + (dx / len) * 15, y: from.y + (dy / len) * 15 };
  return { x: to.x - (dx / len) * 15, y: to.y - (dy / len) * 15 };
}

// ── Apply per-step UI rules ───────────────────────────────────────────
function applyStepRules() {
  const c = getCtrl();
  const useRd = document.getElementById('useRedispatch');
  const cancelRd = document.getElementById('cancelRedispatch');
  const validateRd = document.getElementById('validateRedispatch');
  const moneyEl = document.getElementById('moneyAmount');

  // Redispatch button visibility
  if (settings.mode === 'redispatch') {
    useRd.style.display = 'none';
    // Never show cancel in tutorial — player must complete the redispatch
    cancelRd.style.display = 'none';
    validateRd.style.display = 'block';
  } else {
    useRd.style.display = 'block';
    cancelRd.style.display = 'none';
    validateRd.style.display = 'none';
  }

  // DOM button highlights (CSS class)
  useRd.classList.toggle('tut-pulse', !!c.highlightRedispatch);
  validateRd.classList.toggle('tut-pulse', !!c.highlightValidate);

  // When entering step 11, the validate button must become enabled
  // (syncRedispatchUI last ran with step===10, leaving it disabled)
  if (step === 11 && settings.mode === 'redispatch') {
    validateRd.disabled = false;
  }

  // Redispatch button: disabled when not the intended action (grayed out)
  if (settings.mode === 'switches') {
    useRd.style.opacity = c.redispatch ? '1' : '0.4';
    useRd.style.cursor = c.redispatch ? '' : 'not-allowed';
  } else {
    useRd.style.opacity = '';
    useRd.style.cursor = '';
  }

  // Money display
  if (c.showMoney) {
    const net = getNetwork();
    if (net) {
      moneyEl.textContent = Math.round(net.redispatch.cost) + '€';
      moneyEl.style.display = '';
    }
  } else {
    moneyEl.style.display = 'none';
  }

  // Animation type — reset start time whenever a new animation activates
  const prevAnimType = tutAnimType;
  tutAnimType = c.animation ?? null;
  if (tutAnimType && tutAnimType !== prevAnimType) tutAnimStartTime = Date.now();

  // The highlight overlay is redrawn each ticker frame — no extra work here
}

// ── Render step hint panel ────────────────────────────────────────────
function renderStep() {
  const c = getCtrl();
  const s = STEPS[step];

  const helpEl = document.getElementById('tutorialHelp');
  helpEl.style.display = 'block';

  const nextBtn = c.nextDisabled
    ? `<button disabled
               class="px-5 py-2.5 rounded-xl text-base font-semibold
                      bg-gray-700 text-gray-500 cursor-not-allowed select-none">
         ${c.nextLabel ?? 'Next →'}
       </button>`
    : (!c.final
      ? `<button id="tutNext"
                   class="px-5 py-2.5 rounded-xl text-base font-semibold
                          bg-blue-600 hover:bg-blue-500 active:bg-blue-700
                          text-white transition-colors">Next →</button>`
      : `<button id="tutDone"
                   class="px-5 py-2.5 rounded-xl text-base font-semibold
                          bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700
                          text-white transition-colors">Start Playing →</button>`);

  const backBtn = step > 0
    ? `<button id="tutPrev"
               class="px-5 py-2.5 rounded-xl text-base font-semibold
                      bg-gray-700 hover:bg-gray-600 active:bg-gray-800
                      text-white transition-colors">← Back</button>`
    : '';

  const hex = (n) => '#' + n.toString(16).padStart(6, '0');
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty('--tut-prod', hex(config.colors.nodeProd));
  rootStyle.setProperty('--tut-cons', hex(config.colors.nodeCons));
  rootStyle.setProperty('--tut-switch', hex(config.colors.switchActive));
  rootStyle.setProperty('--tut-congested', hex(config.colors.lineOverload));

  helpEl.innerHTML =
    `<p class="mb-2 text-xs font-semibold tracking-wide text-gray-400 select-none">${step + 1}/${STEPS.length}</p>` +
    `<p class="mb-3 leading-relaxed">${s.text}</p>` +
    `<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">` +
    backBtn + nextBtn +
    `</div>`;


  document.getElementById('tutPrev')?.addEventListener('click', () => {
    const prev = step - 1;
    if (stepSnapshots[prev]) sessionStorage.setItem('network', stepSnapshots[prev]);
    if (settings.mode === 'redispatch' && prev < 10) { settings.mode = 'switches'; settings.pair = []; }
    step = prev;
    updateAndRender();
  });
  document.getElementById('tutNext')?.addEventListener('click', () => {
    stepSnapshots[step] = sessionStorage.getItem('network');
    step++;
    updateAndRender();
  });
  document.getElementById('tutDone')?.addEventListener('click', exitTutorial);

  document.getElementById('LevelInfoPanel').textContent = 'Tutorial';
  applyStepRules();
}

function updateAndRender() {
  const net = getNetwork();
  if (net) {
    updateNetwork(ctx, net, callbacks);
    renderStep();
  } else {
    renderStep();
  }
}

// ── Async setup ───────────────────────────────────────────────────────
(async () => {

  // ── Main PixiJS app ──────────────────────────────────────────
  app = new Application();
  await app.init({
    resizeTo: window,
    backgroundColor: config.colors.background,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });
  document.getElementById('app').appendChild(app.canvas);

  world = new Container();
  app.stage.addChild(world);

  // Tutorial highlight overlay — first child of world so it renders behind the network.
  tutHighlightGfx = new Graphics();
  world.addChild(tutHighlightGfx);

  // Dummy overview world — updateNetwork needs it but we don't render it
  const overviewWorld = new Container();

  // ── Shared state ─────────────────────────────────────────────
  const state = {
    mainContainer: null,
    overviewContainer: null,
    particles: [],
    uiElements: [],
    overloadedGfx: null,
    minimapTransform: null,
    animations: [],
    phantoms: [],
    prevBNodes: {},
  };

  ctx = { world, overviewWorld, state, settings, minimapSize: 350 };

  // ── Ticker ───────────────────────────────────────────────────
  app.ticker.add(() => {
    // ── Tutorial bypass animation (before particle advance for continuity) ──
    if (tutAnimType) {
      state.animations = [];
      const T = 5000;
      const tCycle = ((Date.now() - tutAnimStartTime) % T) / T;
      let phase;
      if (tCycle < 0.30) phase = tCycle / 0.30;
      else if (tCycle < 0.50) phase = 1;
      else if (tCycle < 0.80) phase = 1 - (tCycle - 0.50) / 0.30;
      else phase = 0;
      const eased = phase < 0.5 ? 2 * phase * phase : 1 - Math.pow(-2 * phase + 2, 2) / 2;

      const baseNet = getNetwork();
      if (baseNet?.nodes?.['3b']) {
        const animNet = JSON.parse(JSON.stringify(baseNet));
        animNet.nodes['3b'].y = 300 + eased * 60;

        const savedT = state.particles.map(p => p.t);

        if (state.mainContainer) {
          world.removeChild(state.mainContainer);
          state.mainContainer.destroy({ children: true });
        }
        const rebuilt = createNetwork(settings.mode, animNet, callbacks, false);
        world.addChild(rebuilt.container);
        state.mainContainer = rebuilt.container;
        state.particles = rebuilt.particles;
        state.uiElements = rebuilt.uiElements;
        state.overloadedGfx = rebuilt.overloadedGfx;

        for (let i = 0; i < state.particles.length; i++) {
          if (i < savedT.length) state.particles[i].t = savedT[i];
        }
      }
    }

    // Entrance/exit animations
    if (state.animations.length) {
      const now = Date.now();
      state.animations = state.animations.filter(anim => {
        const t = Math.min(1, (now - anim.startTime) / anim.duration);
        anim.update(t);
        if (t >= 1) { anim.onDone?.(); return false; }
        return true;
      });
    }

    // Particle motion
    for (const p of state.particles) {
      p.t += p.speed * 0.01;
      if (p.t > 1) p.t -= 1;
      if (p.t < 0) p.t += 1;
      if (p.arc) {
        const ang = p.a0 + p.span * p.t;
        p.gfx.x = p.cx + p.radius * Math.cos(ang);
        p.gfx.y = p.cy + p.radius * Math.sin(ang);
      } else {
        p.gfx.x = p.from.x + (p.to.x - p.from.x) * p.t;
        p.gfx.y = p.from.y + (p.to.y - p.from.y) * p.t;
      }
      p.gfx.tint = p.color;
    }

    // Overloaded pulse
    if (state.overloadedGfx) {
      state.overloadedGfx.alpha = 0.7 + 0.3 * Math.sin(Date.now() * 0.01);
    }

    // Constant-pixel UI elements
    const inv = 1 / world.scale.x;
    for (const el of state.uiElements) {
      if (el._hoverTarget !== undefined) {
        el._hoverScale += (el._hoverTarget - el._hoverScale) * 0.3;
        el.scale.set(inv * el._hoverScale);
      } else {
        el.scale.set(inv);
      }
    }

    // ── Tutorial highlight overlay ─────────────────────────────
    tutHighlightGfx.clear();
    const c = getCtrl();
    const pulse = 0.25 + 0.25 * Math.sin(Date.now() * 0.005);
    const net = getNetwork();

    // Highlight specific switches with pulsing green circles
    if (c.highlightSwitches?.length && net) {
      for (const swId of c.highlightSwitches) {
        const pos = getSwitchPos(net, swId);
        if (!pos) continue;
        tutHighlightGfx.circle(pos.x, pos.y, 12).fill({ color: 0x34d399, alpha: pulse });
        tutHighlightGfx.circle(pos.x, pos.y, 7).fill({ color: 0x34d399, alpha: pulse * 0.6 });
      }
    }

    // Highlight node with pulsing green ring
    if (c.highlightNode && net?.nodes[c.highlightNode]) {
      const node = net.nodes[c.highlightNode];
      tutHighlightGfx.circle(node.x, node.y, 18).fill({ color: 0x34d399, alpha: pulse });
      tutHighlightGfx.circle(node.x, node.y, 12).fill({ color: 0x34d399, alpha: pulse * 0.6 });
    }

  });

  // ── Zoom ─────────────────────────────────────────────────────
  app.canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = app.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const wx = (mouseX - world.x) / world.scale.x;
    const wy = (mouseY - world.y) / world.scale.y;
    const factor = Math.exp(-e.deltaY * 0.001);
    const zoom = Math.max(0.5, Math.min(10, world.scale.x * factor));
    world.scale.set(zoom);
    world.x = mouseX - wx * zoom;
    world.y = mouseY - wy * zoom;
  }, { passive: false });

  // ── Pan ──────────────────────────────────────────────────────
  let dragging = false;
  let dragMoved = false;
  let dragStart = { x: 0, y: 0 };

  app.canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    dragMoved = false;
    dragStart = { x: e.clientX - world.x, y: e.clientY - world.y };
  });
  app.canvas.addEventListener('pointermove', (e) => {
    if (dragging) {
      const nx = e.clientX - dragStart.x;
      const ny = e.clientY - dragStart.y;
      if (!dragMoved && Math.abs(nx - world.x) < 3 && Math.abs(ny - world.y) < 3) return;
      dragMoved = true;
      world.x = nx;
      world.y = ny;
    }
    // Hover detection for disabled-switch tooltip
    showSwitchTooltip(e);
  });
  app.canvas.addEventListener('pointerup', () => { dragging = false; });
  app.canvas.addEventListener('pointerleave', () => {
    dragging = false;
    document.getElementById('tutTooltip').style.display = 'none';
  });

  // ── Pinch zoom ───────────────────────────────────────────────
  let pinchDist0 = 0, pinchZoom0 = 1, pinchCenter = { x: 0, y: 0 };
  app.canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return;
    e.preventDefault();
    const [t0, t1] = e.touches;
    pinchDist0 = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
    pinchZoom0 = world.scale.x;
    const rect = app.canvas.getBoundingClientRect();
    const midX = (t0.clientX + t1.clientX) / 2 - rect.left;
    const midY = (t0.clientY + t1.clientY) / 2 - rect.top;
    pinchCenter = { x: (midX - world.x) / world.scale.x, y: (midY - world.y) / world.scale.y };
  }, { passive: false });
  app.canvas.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2) return;
    e.preventDefault();
    const [t0, t1] = e.touches;
    const dist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
    const zoom = Math.max(0.5, Math.min(10, pinchZoom0 * dist / pinchDist0));
    const rect = app.canvas.getBoundingClientRect();
    const midX = (t0.clientX + t1.clientX) / 2 - rect.left;
    const midY = (t0.clientY + t1.clientY) / 2 - rect.top;
    world.scale.set(zoom);
    world.x = midX - pinchCenter.x * zoom;
    world.y = midY - pinchCenter.y * zoom;
  }, { passive: false });
  app.canvas.addEventListener('touchend', () => { pinchDist0 = 0; });

  // ── Redispatch button hover tooltip ─────────────────────────
  const tooltip = document.getElementById('tutTooltip');
  const useRdBtn = document.getElementById('useRedispatch');
  useRdBtn.addEventListener('mouseover', () => {
    if (!getCtrl().redispatch && settings.mode === 'switches') {
      tooltip.style.display = 'block';
    }
  });
  useRdBtn.addEventListener('mousemove', (e) => {
    tooltip.style.left = (e.clientX + 14) + 'px';
    tooltip.style.top = (e.clientY - 28) + 'px';
  });
  useRdBtn.addEventListener('mouseout', () => { tooltip.style.display = 'none'; });

  // ── Game callbacks ───────────────────────────────────────────
  callbacks = {
    onToggle(switchId) {
      const c = getCtrl();
      const allowed = c.switches;
      if (!allowed || (Array.isArray(allowed) && !allowed.includes(switchId))) {
        // Silently ignore — tooltip is shown on hover via pointermove
        return;
      }
      let network = getNetwork();
      network = toggleSwitch(network, switchId);
      network = calculatePowerFlow(network);
      if (network.cost === Infinity) {
        showErrorToast(
          '<b>Action blocked:</b> This switch would cut off part of the grid.<br>' +
          'Every node must remain connected.',
        );
        network = toggleSwitch(network, switchId);
        network = calculatePowerFlow(network);
      }
      updateNetwork(ctx, network, callbacks);
      // Auto-advance on required toggle (snapshot the pre-advance state)
      if ((step === 2 && switchId === 'L3-4_from') || (step === 5 && switchId === 'L2-3_to')) {
        stepSnapshots[step] = sessionStorage.getItem('network');
        step++;
      }
      renderStep();
    },

    onNodeClick(nodeId) {
      const c = getCtrl();
      if (c.nodeClick !== nodeId) return;
      let network = getNetwork();
      for (const line of Object.values(network.lines)) {
        if (line.from_node === nodeId + 'b') network = toggleSwitch(network, line.id + '_from');
        if (line.to_node === nodeId + 'b') network = toggleSwitch(network, line.id + '_to');
      }
      network = calculatePowerFlow(network);
      updateNetwork(ctx, network, callbacks);
      // Auto-advance after reset
      if (step === 8) {
        stepSnapshots[step] = sessionStorage.getItem('network');
        step++;
      }
      renderStep();
    },

    onRedispatchSelect(nodeId) {
      if (!getCtrl().adjustments) return;
      settings.pair = nextPair(settings.pair, nodeId);
      updateNetwork(ctx, getNetwork(), callbacks);
      renderStep(); // updateNetwork hides the tutorial hint panel
    },
  };

  ctx.redispatchScale = initRedispatchScale(document.getElementById('redispatchScale'), {
    onTransfer(raisingId, loweringId, mw) {
      if (!getCtrl().adjustments) return;
      let network = getNetwork();
      applyTransfer(network, raisingId, loweringId, mw);
      syncRedispatchUI(network);
      network = calculatePowerFlow(network);
      updateNetwork(ctx, network, callbacks);
      renderStep();
      // Auto-advance when problem is solved and redispatch is balanced
      if (step === 10 && network.cost === 0 && network.redispatch.unbalance === 0) {
        stepSnapshots[step] = sessionStorage.getItem('network');
        step++;
        renderStep();
      }
    },
    onClear() {
      settings.pair = [];
      updateNetwork(ctx, getNetwork(), callbacks);
      renderStep();
    },
    isFree: () => false,
  });

  // ── Button wiring ────────────────────────────────────────────
  document.getElementById('useRedispatch').addEventListener('click', () => {
    if (!getCtrl().redispatch) return;
    sessionStorage.setItem('network_before_redispatch', sessionStorage.getItem('network'));
    settings.mode = 'redispatch';
    settings.pair = [];
    // Auto-advance step 9 → 10
    if (step === 9) {
      stepSnapshots[step] = sessionStorage.getItem('network');
      step++;
    }
    updateNetwork(ctx, getNetwork(), callbacks);
    renderStep();
    // Show redispatch UI (validate button is shown by applyStepRules via renderStep)
    document.getElementById('redispatchCost').style.display = 'none';
  });

  // Cancel is always hidden in tutorial, but keep the handler for safety
  document.getElementById('cancelRedispatch').addEventListener('click', () => { });

  document.getElementById('validateRedispatch').addEventListener('click', () => {
    if (!getCtrl().validate) return;
    settings.mode = 'switches';
    settings.pair = [];
    updateNetwork(ctx, getNetwork(), callbacks);
    // Auto-advance step 11 → 12
    if (step === 11) {
      stepSnapshots[step] = sessionStorage.getItem('network');
      step++;
    }
    renderStep();
  });

  // Stub for updateNetwork.js solved overlay
  document.getElementById('nextLevelBtn')?.addEventListener('click', exitTutorial);
  document.getElementById('viewSolutionBtn')?.addEventListener('click', () => { });
  document.getElementById('nextLevelBtnPill')?.addEventListener('click', exitTutorial);

  // ── Initial load ─────────────────────────────────────────────
  // Stash the real game state; main.js restores it however the tutorial is left.
  stashGameState();
  // Use a throw-away guest player for the duration; _tutorialMode blocks money logic.
  sessionStorage.setItem('player', JSON.stringify({
    is_guest: true, current_level: 0, unlocked_levels: 999, money: 0,
  }));
  window._tutorialMode = true;
  window._solvedExploring = true;

  document.getElementById('backToGameBtn').addEventListener('click', exitTutorial);

  let network = JSON.parse(JSON.stringify(TUTORIAL_NETWORK_BASE));
  network = calculatePowerFlow(network);
  updateNetwork(ctx, network, callbacks);
  fitCamera(network);
  renderStep();

})();


// ── Helpers ───────────────────────────────────────────────────────────

function showSwitchTooltip(e) {
  const tooltip = document.getElementById('tutTooltip');
  const c = getCtrl();
  const net = getNetwork();
  if (!net || settings.mode !== 'switches') {
    tooltip.style.display = 'none';
    return;
  }
  const allowed = c.switches;

  const rect = app.canvas.getBoundingClientRect();
  const wx = (e.clientX - rect.left - world.x) / world.scale.x;
  const wy = (e.clientY - rect.top - world.y) / world.scale.y;
  const hitR = (config.sizes.switchRadius * 2.5) / world.scale.x; // matches switch hitArea radius

  let nearDisabled = false;
  outer:
  for (const line of Object.values(net.lines)) {
    for (const end of ['from', 'to']) {
      const swId = line.id + '_' + end;
      const pos = getSwitchPos(net, swId);
      if (!pos) continue;
      if (Math.hypot(wx - pos.x, wy - pos.y) < hitR) {
        if (!allowed || (Array.isArray(allowed) && !allowed.includes(swId))) {
          nearDisabled = true;
          break outer;
        }
      }
    }
  }

  if (nearDisabled) {
    tooltip.style.display = 'block';
    tooltip.style.left = (e.clientX + 14) + 'px';
    tooltip.style.top = (e.clientY - 28) + 'px';
  } else {
    tooltip.style.display = 'none';
  }
}

function fitCamera(network) {
  const nodes = Object.values(network.nodes);
  const xs = nodes.map(n => n.x);
  const ys = nodes.map(n => n.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const netW = (maxX - minX) || 1;
  // Extend bottom bound by the 80-unit animation drop so it stays on screen
  const effectiveMaxY = maxY + 80;
  const netH = (effectiveMaxY - minY) || 1;
  const pad = 120;
  const zoom = Math.min(
    (app.screen.width - pad * 2) / netW,
    (app.screen.height - pad * 2) / netH,
    4,
  );
  world.scale.set(zoom);
  world.x = app.screen.width / 2 - ((minX + maxX) / 2) * zoom;
  world.y = app.screen.height / 2 - ((minY + effectiveMaxY) / 2) * zoom;
}

function syncRedispatchUI(network) {
  const unbalance = network.redispatch.unbalance;
  const cost = network.redispatch.cost;
  const balEl = document.getElementById('redispatchUnbalance');
  const valBtn = document.getElementById('validateRedispatch');
  balEl.style.display = unbalance !== 0 ? 'block' : 'none';
  balEl.textContent = unbalance !== 0 ? `Power unbalance: ${unbalance}` : '';
  // In step 11 only validate is allowed; in step 10 keep disabled until balanced
  valBtn.disabled = unbalance !== 0 || step === 10;
  valBtn.textContent = `${cost.toFixed(0)}€`;
}

function showErrorToast(html) {
  const toast = document.createElement('div');
  toast.className = 'error-toast';
  toast.innerHTML = html;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

window._applyTheme = function (theme) {
  Object.assign(config.colors, themes[theme]);
  if (app) app.renderer.background.color = config.colors.background;
  const net = getNetwork();
  if (net && ctx && callbacks) {
    updateNetwork(ctx, net, callbacks);
    renderStep();
  }
};
