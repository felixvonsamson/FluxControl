import { Application, Container, Graphics } from 'pixi.js';
import { config, themes } from './config.js';
import { updateNetwork, toggleSwitch } from './network/updateNetwork.js';
import { calculatePowerFlow } from './network/powerFlow.js';
import { makeBNodeContainer, SPLIT_SCALE } from './network/createNetwork.js';
import { ensureLoggedIn, authHeaders, isGuest, setGuestProgress } from './auth/auth.js';
import { renderOverviewToImage } from './level_image_halper.js';

const MINIMAP_SIZE = 350;

// Apply saved theme before Pixi initializes so the background color is correct
{
  const t = document.documentElement.dataset.theme || 'dark';
  if (t !== 'dark') Object.assign(config.colors, themes[t]);
}

// Module-scope so load_level (exported below) can close over them
// after the async IIFE has finished setup.
let app, minimapApp, world, ctx, callbacks;

export function load_level(level) {
  window._dailyMode = false;
  window._solvedExploring = false;
  document.getElementById('solvedPill').style.display = 'none';

  const player = JSON.parse(sessionStorage.getItem('player'));

  if (player.is_guest) {
    loadGuestLevel(level).then(network => {
      player.current_level = level;
      sessionStorage.setItem('player', JSON.stringify(player));
      setGuestProgress({
        current_level: level,
        unlocked_levels: player.unlocked_levels,
        money: player.money,
        level_stars: player.level_stars ?? {},
        daily_solved_date: player.daily_solved_date ?? null,
        daily_stars: player.daily_stars ?? 0,
      });
      sessionStorage.setItem('network', JSON.stringify(network));
      updateNetwork(ctx, network, callbacks);
      fitCamera(network);
    });
    return;
  }

  fetch('/api/load_level', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ level_num: level }),
  })
    .then(r => r.json())
    .then(data => {
      player.current_level = level;
      sessionStorage.setItem('player', JSON.stringify(player));
      sessionStorage.setItem('network', JSON.stringify(data));
      updateNetwork(ctx, data, callbacks);
      fitCamera(data);
    });
}

async function loadGuestLevel(levelNum) {
  const res = await fetch(`/static/levels/Level${levelNum}.json`);
  const data = await res.json();
  const network = {
    nodes: data.nodes,
    lines: data.lines,
    cost: 1000000,
    redispatch: { cost: 0, unbalance: 0, adjustments: {} },
    level: levelNum,
    tutorial_info: data.tutorial_info ?? null,
  };
  return calculatePowerFlow(network);
}

// ── Async setup ───────────────────────────────────────────────────
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

  // ── Minimap PixiJS app ───────────────────────────────────────
  minimapApp = new Application();
  await minimapApp.init({
    width: MINIMAP_SIZE,
    height: MINIMAP_SIZE,
    backgroundColor: config.colors.background,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });
  // Let CSS scale the canvas to fill the minimap div
  minimapApp.canvas.style.width = '100%';
  minimapApp.canvas.style.height = '100%';
  document.getElementById('minimap').appendChild(minimapApp.canvas);

  const overviewWorld = new Container();
  const viewportRect = new Graphics();
  minimapApp.stage.addChild(overviewWorld);
  minimapApp.stage.addChild(viewportRect);   // drawn on top of overview network

  // ── Shared state ─────────────────────────────────────────────
  const state = {
    mainContainer: null,
    overviewContainer: null,
    particles: [],
    uiElements: [],   // labels/switches/arrows — inverse-scaled each tick
    overloadedGfx: null, // pulsing alpha when lines are congested
    faultField: null, // fault-line shader mesh while the grid is split
    minimapTransform: null, // { scale, offsetX, offsetY } set by updateNetwork
    animations: [],   // active entrance/exit animations { startTime, duration, update, onDone }
    phantoms: [],   // phantom b-node rings currently animating out
    prevBNodes: {},   // { id: { x, y } } — b-nodes from last updateNetwork call
  };
  const settings = { mode: 'switches' };

  ctx = { world, overviewWorld, state, settings, minimapSize: MINIMAP_SIZE };

  // ── Ticker ───────────────────────────────────────────────────
  let targetCam = null; // smooth camera destination from minimap click

  app.ticker.add(() => {

    // Smooth camera pan (minimap click)
    if (targetCam) {
      world.x += (targetCam.x - world.x) * 0.15;
      world.y += (targetCam.y - world.y) * 0.15;
      if (Math.abs(world.x - targetCam.x) < 0.5 && Math.abs(world.y - targetCam.y) < 0.5) {
        world.x = targetCam.x;
        world.y = targetCam.y;
        targetCam = null;
      }
    }

    // Bus-split entrance / exit animations
    if (state.animations.length) {
      const now = Date.now();
      state.animations = state.animations.filter(anim => {
        const t = Math.min(1, (now - anim.startTime) / anim.duration);
        anim.update(t);
        if (t >= 1) { anim.onDone?.(); return false; }
        return true;
      });
    }

    // Particle animation
    for (const p of state.particles) {
      p.t += p.speed * 0.01;
      if (p.t > 1) p.t -= 1;
      if (p.t < 0) p.t += 1;
      if (p.arc) {
        // Around a b-node ring: position is an angle along the arc.
        const ang = p.a0 + p.span * p.t;
        p.gfx.x = p.cx + p.radius * Math.cos(ang);
        p.gfx.y = p.cy + p.radius * Math.sin(ang);
      } else {
        p.gfx.x = p.from.x + (p.to.x - p.from.x) * p.t;
        p.gfx.y = p.from.y + (p.to.y - p.from.y) * p.t;
      }
      p.gfx.tint = p.color;
    }

    // Overloaded lines pulse
    if (state.overloadedGfx) {
      state.overloadedGfx.alpha = 0.7 + 0.3 * Math.sin(Date.now() * 0.01);
    }

    // Fault line (only present while the grid is split)
    state.faultField?.update(Date.now() / 1000 % 3600, world.scale.x);

    // Keep labels / switches / arrows at constant pixel size
    const inv = 1 / world.scale.x;
    for (const el of state.uiElements) {
      if (el._hoverTarget !== undefined) {
        el._hoverScale += (el._hoverTarget - el._hoverScale) * 0.3;
        el.scale.set(inv * el._hoverScale);
      } else {
        el.scale.set(inv);
      }
    }

    // Minimap viewport rectangle
    if (state.minimapTransform) {
      const { scale, offsetX, offsetY } = state.minimapTransform;
      const left = -world.x / world.scale.x;
      const top = -world.y / world.scale.y;
      const right = (app.screen.width - world.x) / world.scale.x;
      const bottom = (app.screen.height - world.y) / world.scale.y;
      viewportRect.clear();
      viewportRect
        .rect(
          left * scale + offsetX,
          top * scale + offsetY,
          (right - left) * scale,
          (bottom - top) * scale,
        )
        .stroke({ width: 1.5, color: config.colors.viewportRect });
    }
  });

  // ── Zoom (mouse wheel) ───────────────────────────────────────
  app.canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = app.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    // World point under cursor before zoom
    const wx = (mouseX - world.x) / world.scale.x;
    const wy = (mouseY - world.y) / world.scale.y;
    const factor = Math.exp(-e.deltaY * 0.001);
    const zoom = Math.max(0.5, Math.min(10, world.scale.x * factor));
    world.scale.set(zoom);
    // Shift so the same world point stays under the cursor
    world.x = mouseX - wx * zoom;
    world.y = mouseY - wy * zoom;
  }, { passive: false });

  // ── Pan (pointer drag) ───────────────────────────────────────
  let dragging = false;
  let dragMoved = false;
  let dragStart = { x: 0, y: 0 };

  app.canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    dragMoved = false;
    dragStart = { x: e.clientX - world.x, y: e.clientY - world.y };
  });
  app.canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const nx = e.clientX - dragStart.x;
    const ny = e.clientY - dragStart.y;
    // Small threshold so a plain tap doesn't micro-jitter the world
    if (!dragMoved && Math.abs(nx - world.x) < 3 && Math.abs(ny - world.y) < 3) return;
    dragMoved = true;
    world.x = nx;
    world.y = ny;
  });
  app.canvas.addEventListener('pointerup', () => { dragging = false; });
  app.canvas.addEventListener('pointerleave', () => { dragging = false; });

  // ── Pinch zoom (touch) ───────────────────────────────────────
  let pinchDist0 = 0;
  let pinchZoom0 = 1;
  let pinchCenter = { x: 0, y: 0 };

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

  // ── Minimap click → smooth camera navigate ───────────────────
  minimapApp.canvas.addEventListener('pointerdown', (e) => {
    if (!state.minimapTransform) return;
    const { scale, offsetX, offsetY } = state.minimapTransform;
    const rect = minimapApp.canvas.getBoundingClientRect();
    // Normalize click to internal canvas resolution (CSS may have scaled it)
    const localX = (e.clientX - rect.left) * (MINIMAP_SIZE / rect.width);
    const localY = (e.clientY - rect.top) * (MINIMAP_SIZE / rect.height);
    const worldX = (localX - offsetX) / scale;
    const worldY = (localY - offsetY) / scale;
    targetCam = {
      x: app.screen.width / 2 - worldX * world.scale.x,
      y: app.screen.height / 2 - worldY * world.scale.y,
    };
  });

  // ── Daily problem ─────────────────────────────────────────────

  function updateDailyBadge(solved) {
    document.getElementById('dailyNewPill').style.display = solved ? 'none' : '';
    document.getElementById('menuDailyNewPill').style.display = solved ? 'none' : '';
    document.getElementById('dailySolvedCheck').style.display = solved ? '' : 'none';
  }
  window._updateDailyBadge = updateDailyBadge;

  // Set initial badge state from cached player data
  const _cachedPlayer = JSON.parse(sessionStorage.getItem('player'));
  if (_cachedPlayer) {
    const todayIso = new Date().toISOString().slice(0, 10);
    updateDailyBadge(_cachedPlayer.daily_solved_date === todayIso);
  }

  async function loadDailyProblem() {
    document.getElementById('menuButtons').style.display = 'none';
    document.getElementById('levelSelectionPanel').style.display = 'none';
    const r = await fetch('/api/daily_problem', { headers: authHeaders() });
    const { network, already_solved } = await r.json();

    window._dailyMode = !already_solved;
    window._solvedExploring = false;
    document.getElementById('solvedPill').style.display = 'none';

    sessionStorage.setItem('network', JSON.stringify(network));
    updateNetwork(ctx, network, callbacks);
    fitCamera(network);
    const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    document.getElementById('LevelInfoPanel').textContent = `Daily Problem — ${date}`;
    updateDailyBadge(already_solved);

  }

  document.getElementById('dailyProblemBtn').addEventListener('click', loadDailyProblem);
  document.getElementById('dailyProblemCard').addEventListener('click', loadDailyProblem);

  // Daily solved overlay buttons
  document.getElementById('dailySolvedGotItBtn').addEventListener('click', () => {
    const overlay = document.getElementById('dailySolvedOverlay');
    overlay.style.opacity = '0';
    overlay.addEventListener('transitionend', () => {
      overlay.style.display = 'none';
      overlay.style.opacity = '';
    }, { once: true });
    window._dailyMode = false;
    window._solvedExploring = true;
    document.getElementById('nextLevelBtnPill').style.display = 'none';
    document.getElementById('levelSelectBtnPill').style.display = '';
    const pill = document.getElementById('solvedPill');
    pill.style.display = 'flex';
    pill.classList.remove('entering');
    requestAnimationFrame(() => requestAnimationFrame(() => pill.classList.add('entering')));
  });

  document.getElementById('dailySolvedCareerBtn').addEventListener('click', () => {
    const overlay = document.getElementById('dailySolvedOverlay');
    overlay.style.display = 'none';
    overlay.style.opacity = '';
    window._dailyMode = false;
    document.getElementById('levelSelectionPanel').style.display = 'block';
  });

  // ── Keyboard shortcuts ───────────────────────────────────────
  window.addEventListener('keydown', (e) => {
    // S — auto-solve
    if (e.key === 's' || e.key === 'S') {
      const network = JSON.parse(sessionStorage.getItem('network'));
      fetch('/api/solve', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ network_data: network }),
      })
        .then(r => r.json())
        .then(data => updateNetwork(ctx, data, callbacks))
        .catch(err => console.error('solve failed', err));
    }

    // C — clear session and reload
    if (e.key === 'c' || e.key === 'C') {
      sessionStorage.clear();
      location.reload();
    }

    // P — screenshot the minimap
    if (e.key === 'p' || e.key === 'P') {
      renderOverviewToImage(minimapApp, MINIMAP_SIZE);
    }
  });

  // ── Game callbacks ───────────────────────────────────────────
  callbacks = {

    onToggle(switchID) {
      let network = JSON.parse(sessionStorage.getItem('network'));
      network = toggleSwitch(network, switchID);
      // A move that splits the grid is allowed: the board shows the fault line
      // and the switches that would reconnect it instead of refusing the move.
      network = calculatePowerFlow(network);
      updateNetwork(ctx, network, callbacks);
    },

    onNodeClick(nodeId) {
      // Reset all bus-split switches on this node back to the main bus
      let network = JSON.parse(sessionStorage.getItem('network'));
      for (const line of Object.values(network.lines)) {
        if (line.from_node === nodeId + 'b') network = toggleSwitch(network, line.id + '_from');
        if (line.to_node === nodeId + 'b') network = toggleSwitch(network, line.id + '_to');
      }
      network = calculatePowerFlow(network);
      updateNetwork(ctx, network, callbacks);
    },

    onResetRedispatch(nodeId) {
      let network = JSON.parse(sessionStorage.getItem('network'));
      const node = network.nodes[nodeId];
      const adj = network.redispatch.adjustments[nodeId] || 0;
      node.injection -= adj;
      network.redispatch.cost -= adj * (adj > 0 ? node.cost_increase : -node.cost_decrease);
      network.redispatch.unbalance -= adj;
      delete network.redispatch.adjustments[nodeId];
      syncRedispatchUI(network);
      network = calculatePowerFlow(network);
      updateNetwork(ctx, network, callbacks);
    },

    changeInjection(nodeId, direction) {
      let network = JSON.parse(sessionStorage.getItem('network'));
      const delta = direction === 'up' ? 1 : -1;
      const node = network.nodes[nodeId];
      node.injection += delta;
      network.redispatch.adjustments[nodeId] =
        (network.redispatch.adjustments[nodeId] || 0) + delta;
      network.redispatch.cost = calcRedispatchCost(network);
      network.redispatch.unbalance += delta;
      syncRedispatchUI(network);
      network = calculatePowerFlow(network);
      updateNetwork(ctx, network, callbacks);
    },
  };

  // ── Button wiring ────────────────────────────────────────────
  document.getElementById('nextLevelBtn').addEventListener('click', () => {
    const btn = document.getElementById('nextLevelBtn');
    btn.disabled = true;
    btn.textContent = 'Loading…';
    next_level();
  });

  document.getElementById('viewSolutionBtn').addEventListener('click', () => {
    const overlay = document.getElementById('solvedOverlay');
    overlay.style.opacity = '0';
    overlay.addEventListener('transitionend', () => {
      overlay.style.display = 'none';
      overlay.style.opacity = '';
    }, { once: true });

    window._solvedExploring = true;

    const pill = document.getElementById('solvedPill');
    pill.classList.remove('entering');
    pill.style.display = 'flex';
    requestAnimationFrame(() => requestAnimationFrame(() => pill.classList.add('entering')));
  });

  document.getElementById('nextLevelBtnPill').addEventListener('click', () => {
    const pill = document.getElementById('nextLevelBtnPill');
    pill.disabled = true;
    pill.textContent = 'Loading…';
    next_level();
  });

  document.getElementById('levelSelectBtnPill').addEventListener('click', () => {
    document.getElementById('solvedPill').style.display = 'none';
    document.getElementById('levelSelectionPanel').style.display = 'block';
  });

  document.getElementById('useRedispatch').addEventListener('click', () => {
    sessionStorage.setItem('network_before_redispatch', sessionStorage.getItem('network'));
    settings.mode = 'redispatch';
    document.getElementById('useRedispatch').style.display = 'none';
    document.getElementById('redispatchCost').style.display = 'none';
    document.getElementById('validateRedispatch').style.display = 'block';
    document.getElementById('cancelRedispatch').style.display = 'block';
    updateNetwork(ctx, JSON.parse(sessionStorage.getItem('network')), callbacks);
  });

  document.getElementById('cancelRedispatch').addEventListener('click', () => {
    settings.mode = 'switches';
    sessionStorage.setItem('network', sessionStorage.getItem('network_before_redispatch'));
    document.getElementById('useRedispatch').style.display = 'block';
    document.getElementById('validateRedispatch').style.display = 'none';
    document.getElementById('cancelRedispatch').style.display = 'none';
    document.getElementById('redispatchUnbalance').style.display = 'none';
    document.getElementById('redispatchUnbalance').textContent = '';
    document.getElementById('validateRedispatch').textContent = '0€';
    document.getElementById('validateRedispatch').disabled = false;
    updateNetwork(ctx, JSON.parse(sessionStorage.getItem('network')), callbacks);
  });

  document.getElementById('validateRedispatch').addEventListener('click', () => {
    settings.mode = 'switches';
    document.getElementById('useRedispatch').style.display = 'block';
    document.getElementById('validateRedispatch').style.display = 'none';
    document.getElementById('cancelRedispatch').style.display = 'none';
    document.getElementById('validateRedispatch').textContent = '0€';
    updateNetwork(ctx, JSON.parse(sessionStorage.getItem('network')), callbacks);
  });

  // ── Initial level load ───────────────────────────────────────
  const loggedIn = await ensureLoggedIn();
  if (!loggedIn) return;

  const player = JSON.parse(sessionStorage.getItem('player'));
  let network = JSON.parse(sessionStorage.getItem('network'));

  if (!network) {
    if (player.is_guest) {
      network = await loadGuestLevel(player.current_level);
    } else {
      const response = await fetch('/api/load_level', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ level_num: player.current_level }),
      });
      network = await response.json();
    }
    sessionStorage.setItem('network', JSON.stringify(network));
  }

  network = calculatePowerFlow(network);
  updateNetwork(ctx, network, callbacks);
  fitCamera(network);

})(); // end async IIFE


// ── Helpers (module-scope, close over app/world set in IIFE) ─────

function fitCamera(network) {
  const nodes = Object.values(network.nodes);
  const xs = nodes.map(n => n.x);
  const ys = nodes.map(n => n.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const netW = (maxX - minX) || 1;
  const netH = (maxY - minY) || 1;
  const pad = 120;
  const zoom = Math.min(
    (app.screen.width - pad * 2) / netW,
    (app.screen.height - pad * 2) / netH,
    4,
  );
  world.scale.set(zoom);
  world.x = app.screen.width / 2 - ((minX + maxX) / 2) * zoom;
  world.y = app.screen.height / 2 - ((minY + maxY) / 2) * zoom;
}

function next_level() {
  window._solvedExploring = false;
  document.getElementById('solvedPill').style.display = 'none';
  document.getElementById('nextLevelBtnPill').style.display = '';
  document.getElementById('levelSelectBtnPill').style.display = 'none';

  const player = JSON.parse(sessionStorage.getItem('player'));
  const btn = document.getElementById('nextLevelBtn');
  const pillBtn = document.getElementById('nextLevelBtnPill');

  const resetButtons = () => {
    btn.disabled = false;
    btn.textContent = 'Next Level →';
    pillBtn.disabled = false;
    pillBtn.textContent = 'Next Level →';
  };

  if (player.is_guest) {
    loadGuestLevel(player.current_level + 1).then(network => {
      player.current_level += 1;
      sessionStorage.setItem('player', JSON.stringify(player));
      sessionStorage.setItem('network', JSON.stringify(network));
      updateNetwork(ctx, network, callbacks);
      fitCamera(network);
      resetButtons();
    });
    return;
  }

  fetch('/api/load_level', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ level_num: player.current_level + 1 }),
  })
    .then(r => r.json())
    .then(data => {
      player.current_level += 1;
      sessionStorage.setItem('player', JSON.stringify(player));
      updateNetwork(ctx, data, callbacks);
      fitCamera(data);
      resetButtons();
    });
}

function calcRedispatchCost(network) {
  let total = 0;
  for (const [id, adj] of Object.entries(network.redispatch.adjustments)) {
    const node = network.nodes[id];
    total += adj > 0 ? adj * node.cost_increase : -adj * node.cost_decrease;
  }
  return total;
}

function syncRedispatchUI(network) {
  const unbalance = network.redispatch.unbalance;
  const cost = network.redispatch.cost;
  const balEl = document.getElementById('redispatchUnbalance');
  const valBtn = document.getElementById('validateRedispatch');
  balEl.style.display = unbalance !== 0 ? 'block' : 'none';
  balEl.textContent = unbalance !== 0 ? `Power unbalance: ${unbalance}` : '';
  valBtn.disabled = unbalance !== 0;
  valBtn.textContent = `${cost.toFixed(0)}€`;
}

window._applyTheme = function (theme) {
  Object.assign(config.colors, themes[theme]);
  if (app) app.renderer.background.color = config.colors.background;
  if (minimapApp) minimapApp.renderer.background.color = config.colors.background;
  const network = JSON.parse(sessionStorage.getItem('network'));
  if (network && ctx && callbacks) updateNetwork(ctx, network, callbacks);
};
