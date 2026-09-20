import { createNetwork, makeBNodeContainer, SPLIT_SCALE } from './createNetwork.js';
import { islandPartition } from './powerFlow.js';
import { authHeaders, setGuestProgress } from '../auth/auth.js';
import { starsForRedispatchCost, starsRowHTML, animateStarsRow } from '../ui/stars.js';
import { takePendingSwitches, restorePendingSwitches } from '../switchStats.js';
import { calcRedispatchCost, redispatchCharge, isFirstSolve, canAffordRedispatch, SOLVE_REWARD } from '../economy.js';

export const DIFFICULTY_COLORS = {
  'Easy': '#34d399',      // emerald-400
  'Medium': '#fbbf24',    // amber-400
  'Hard': '#fb923c',      // orange-400
  'Very Hard': '#f87171', // red-400
};

// ── Solved UI helpers ───────────────────────────────────────────────

function hideSolvedUI() {
  const overlay = document.getElementById('solvedOverlay');
  overlay.style.display = 'none';
  overlay.style.opacity = '';
  hideSolvedPill();
}

function hideSolvedPill() {
  const pill = document.getElementById('solvedPill');
  pill.classList.remove('entering');
  pill.style.display = 'none';
}

function renderStars(containerId, stars, rowClass) {
  const container = document.getElementById(containerId);
  container.innerHTML = stars != null ? starsRowHTML(stars, rowClass) : '';
  if (stars != null) animateStarsRow(container);
}

function triggerSolvedUI(rewardText, stars) {
  document.getElementById('rewardMessage').textContent = rewardText;

  if (window._solvedExploring) {
    const pill = document.getElementById('solvedPill');
    renderStars('solvedPillStars', stars, 'starsRowSmall');
    if (pill.style.display === 'none' || !pill.style.display) {
      pill.style.display = 'flex';
      pill.classList.remove('entering');
      void pill.offsetWidth;
      pill.classList.add('entering');
    }
    return;
  }

  renderStars('solvedStars', stars, 'starsRowLarge');
  const overlay = document.getElementById('solvedOverlay');
  overlay.style.opacity = '0';
  overlay.style.display = 'block';
  void overlay.offsetWidth; // force reflow so the transition sees the opacity change
  overlay.style.opacity = '1';
}

function triggerDailySolvedUI(rewardText, stars) {
  document.getElementById('dailyRewardMessage').textContent = rewardText;
  renderStars('dailySolvedStars', stars, 'starsRowLarge');
  const overlay = document.getElementById('dailySolvedOverlay');
  overlay.style.display = 'block';
  void overlay.offsetWidth;
  overlay.style.opacity = '1';
}

/**
 * While the real grid is split: the switches whose toggle would strictly
 * reduce the number of islands holding a real bus, i.e. the ones that heal
 * the cut. Ported from the iOS app's `reconnectingSwitchActions`, which
 * likewise brute-forces every switch through the real toggle logic so the
 * set can't drift from game behaviour. Empty unless the grid is split.
 */
function reconnectingSwitchIds(network) {
  const target = islandPartition(network).mainIslandCount;
  if (target <= 1) return new Set();

  const healing = new Set();
  for (const line of Object.values(network.lines)) {
    for (const end of ['from', 'to']) {
      const switchId = `${line.id}_${end}`;
      // toggleSwitch mutates, and only ever touches nodes and lines.
      const trial = toggleSwitch(
        { nodes: structuredClone(network.nodes), lines: structuredClone(network.lines) },
        switchId,
      );
      if (islandPartition(trial).mainIslandCount < target) healing.add(switchId);
    }
  }
  return healing;
}

/**
 * Rebuild the PixiJS scene from new network data.
 *
 * @param {object} ctx  { world, overviewWorld, state, settings, minimapSize, redispatchScale }
 * @param {object} network
 * @param {object} callbacks  { onToggle, onNodeClick, onRedispatchSelect }
 */
const ANIM_DURATION = 420; // ms

export function updateNetwork(ctx, network, callbacks) {
  const { world, overviewWorld, state, settings, minimapSize } = ctx;

  // ── Detect b-node appearances / disappearances ─────────────────
  const prevBNodes = state.prevBNodes ?? {};
  const newBNodeIds = new Set(Object.keys(network.nodes).filter(id => id.includes('b')));
  const appearing = [...newBNodeIds].filter(id => !prevBNodes[id]);
  const disappearing = Object.keys(prevBNodes).filter(id => !newBNodeIds.has(id));

  // Remove phantoms from any previous animation cycle
  for (const ph of (state.phantoms ?? [])) {
    world.removeChild(ph);
    ph.destroy();
  }
  state.phantoms = [];
  state.animations = [];

  sessionStorage.setItem('network', JSON.stringify(network));

  // ── Tear down old scene objects ────────────────────────────────
  if (state.mainContainer) {
    world.removeChild(state.mainContainer);
    state.mainContainer.destroy({ children: true });
  }
  if (state.overviewContainer) {
    overviewWorld.removeChild(state.overviewContainer);
    state.overviewContainer.destroy({ children: true });
  }

  // ── Build new scene objects ────────────────────────────────────
  const main = createNetwork(settings.mode, network, callbacks, false, {
    reconnecting: reconnectingSwitchIds(network),
    pair: settings.pair,
  });
  const overview = createNetwork(settings.mode, network, {}, true);

  world.addChild(main.container);
  overviewWorld.addChild(overview.container);

  state.mainContainer = main.container;
  state.overviewContainer = overview.container;
  state.particles = main.particles;
  state.uiElements = main.uiElements;
  state.overloadedGfx = main.overloadedGfx;
  state.faultField = main.faultField;
  ctx.redispatchScale?.update(network, settings);

  // ── Schedule entrance / exit animations ───────────────────────
  const now = Date.now();

  for (const id of appearing) {
    const bCont = main.bNodeContainers[id];
    const mainGfx = main.mainNodeGraphics[id.slice(0, -1)];
    if (!bCont || !mainGfx) continue;
    bCont.scale.set(0);
    state.animations.push({
      startTime: now,
      duration: ANIM_DURATION,
      update(t) {
        const ease = 1 - Math.pow(1 - t, 3); // easeOut
        // b-node expands from 0 to its normal size
        bCont.scale.set(0.5 + 0.5 * ease);
        // main node shrinks from 1.0 down to SPLIT_SCALE
        mainGfx.scale.set(1 - (1 - SPLIT_SCALE) * ease);
      },
      onDone() { mainGfx.scale.set(SPLIT_SCALE); },
    });
  }

  for (const id of disappearing) {
    const mainGfx = main.mainNodeGraphics[id.slice(0, -1)];
    const pos = prevBNodes[id];
    if (!mainGfx || !pos) continue;
    // New scene's main node starts at SPLIT_SCALE; animate it back up to 1.0
    mainGfx.scale.set(SPLIT_SCALE);
    const phantom = makeBNodeContainer(pos.x, pos.y);
    world.addChild(phantom);
    state.phantoms.push(phantom);
    state.animations.push({
      startTime: now,
      duration: ANIM_DURATION,
      update(t) {
        const ease = 1 - Math.pow(1 - t, 3); // easeOut
        // phantom ring collapses from SPLIT_SCALE back to 0
        phantom.scale.set(1 - ease);
        // main node grows from SPLIT_SCALE back to 1.0
        mainGfx.scale.set(SPLIT_SCALE + (1 - SPLIT_SCALE) * ease);
      },
      onDone() { mainGfx.scale.set(1); },
    });
  }

  // Remember b-node positions for the next call's disappear detection
  state.prevBNodes = {};
  for (const [id, node] of Object.entries(network.nodes)) {
    if (id.includes('b')) state.prevBNodes[id] = { x: node.x, y: node.y };
  }

  // ── Fit minimap to network bounds ──────────────────────────────
  const allNodes = Object.values(network.nodes);
  const xs = allNodes.map(n => n.x);
  const ys = allNodes.map(n => n.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const netW = (maxX - minX) || 1;
  const netH = (maxY - minY) || 1;

  const padding = 20;
  const avail = minimapSize - padding * 2;
  const mmScale = Math.min(avail / netW, avail / netH);

  overviewWorld.scale.set(mmScale);
  overviewWorld.x = padding + (avail - netW * mmScale) / 2 - minX * mmScale;
  overviewWorld.y = padding + (avail - netH * mmScale) / 2 - minY * mmScale;

  // Expose for viewport-rect drawing in main.js ticker
  state.minimapTransform = {
    scale: mmScale,
    offsetX: overviewWorld.x,
    offsetY: overviewWorld.y,
  };

  // ── DOM updates ────────────────────────────────────────────────
  const levelEl = document.getElementById('LevelInfoPanel');
  if (network.level == null) {
    levelEl.textContent = 'Custom Network';
  } else {
    levelEl.textContent = network.tutorial
      ? `Tutorial ${network.level}`
      : `Level ${network.level}`;
  }

  const difficultyEl = document.getElementById('difficultyBadge');
  if (difficultyEl) {
    const color = DIFFICULTY_COLORS[network.difficulty];
    if (color) {
      difficultyEl.textContent = network.difficulty;
      difficultyEl.style.color = color;
      difficultyEl.style.display = 'block';
    } else {
      difficultyEl.style.display = 'none';
    }
  }

  const tutEl = document.getElementById('tutorialHelp');
  if (network.tutorial_info) {
    tutEl.style.display = 'block';
    tutEl.textContent = network.tutorial_info;
  } else {
    tutEl.style.display = 'none';
    tutEl.textContent = '';
  }

  const costEl = document.getElementById('redispatchCost');
  if (network.redispatch?.cost && network.redispatch.cost !== 0 && settings.mode !== 'redispatch') {
    const player = JSON.parse(sessionStorage.getItem('player'));
    costEl.style.display = 'block';
    costEl.textContent = `(${redispatchCharge(player, network.redispatch.cost, window._dailyMode)}€)`;
  } else {
    costEl.style.display = 'none';
  }

  // ── Solved check ───────────────────────────────────────────────
  if (network.cost !== 0 || settings.mode === 'redispatch') {
    hideSolvedUI();
    return;
  }
  if (window._tutorialMode) {
    hideSolvedUI();
    return;
  }
  const player = JSON.parse(sessionStorage.getItem('player'));
  if (player?.is_guest) {
    checkSolutionGuest(network, player);
  } else if (window._dailyMode) {
    checkDailySolution(network);
  } else {
    checkSolution(network);
  }
}


function checkDailySolution(network) {
  fetch('/api/check_daily_solution', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ network_data: network }),
  })
    .then(r => r.json())
    .then(data => {
      if (!data.solved) { hideSolvedUI(); return; }
      const player = data.player;
      document.getElementById('moneyAmount').textContent = player.money + '€';
      sessionStorage.setItem('player', JSON.stringify(player));
      if (window._updateDailyBadge) window._updateDailyBadge(true);
      if (window._refreshScoreboard) window._refreshScoreboard();
      triggerDailySolvedUI(data.reward > 0 ? `+${data.reward}€` : '', data.stars);
    });
}

function checkSolution(network) {
  // Unreported switch flips ride along so the solving flip is counted too.
  const switchDelta = takePendingSwitches(network.level);
  fetch('/api/check_solution', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ network_data: network, switch_delta: switchDelta }),
  })
    .then(r => {
      if (!r.ok) restorePendingSwitches(network.level, switchDelta);
      return r.json();
    })
    .catch(err => {
      restorePendingSwitches(network.level, switchDelta);
      throw err;
    })
    .then(data => {
      if (!data.solved) {
        hideSolvedUI();
        return;
      }
      const player = data.player;
      document.getElementById('moneyAmount').textContent = player.money + '€';
      sessionStorage.setItem('player', JSON.stringify(player));
      if (window._refreshScoreboard) window._refreshScoreboard();
      triggerSolvedUI(`Reward: ${data.reward}€`, data.stars);
    });
}

function checkSolutionGuest(network, player) {
  const allLinesOk = Object.values(network.lines).every(
    line => Math.abs(line.flow) <= line.limit,
  );
  if (!allLinesOk) {
    hideSolvedUI();
    return;
  }

  const redispatchCost = calcRedispatchCost(network.redispatch?.adjustments);
  const dailyMode = !!window._dailyMode;
  // Same rule as the server's settle_coins: redispatch is paid from existing coins only.
  if (!canAffordRedispatch(player, redispatchCost, dailyMode)) {
    hideSolvedUI();
    return;
  }
  const stars = starsForRedispatchCost(redispatchCost);
  const firstSolve = isFirstSolve(player, dailyMode);
  const reward = firstSolve ? SOLVE_REWARD : 0;
  player.money = (player.money ?? 100) + reward - redispatchCharge(player, redispatchCost, dailyMode);

  if (dailyMode) {
    const today = new Date().toISOString().slice(0, 10);
    const prevStars = player.daily_solved_date === today ? (player.daily_stars || 0) : 0;
    const bestStars = Math.max(prevStars, stars);
    player.daily_solved_date = today;
    player.daily_stars = bestStars;

    sessionStorage.setItem('player', JSON.stringify(player));
    setGuestProgress({
      current_level: player.current_level,
      unlocked_levels: player.unlocked_levels,
      money: player.money,
      level_stars: player.level_stars ?? {},
      daily_solved_date: player.daily_solved_date,
      daily_stars: player.daily_stars,
    });

    document.getElementById('moneyAmount').textContent = player.money + '€';
    if (window._updateDailyBadge) window._updateDailyBadge(true);
    if (window._refreshScoreboard) window._refreshScoreboard();
    triggerDailySolvedUI(reward > 0 ? `+${reward}€` : '', bestStars);
    return;
  }

  if (firstSolve) player.unlocked_levels += 1;

  const levelStars = player.level_stars ?? {};
  const bestStars = Math.max(levelStars[network.level] || 0, stars);
  levelStars[network.level] = bestStars;
  player.level_stars = levelStars;

  sessionStorage.setItem('player', JSON.stringify(player));
  setGuestProgress({
    current_level: player.current_level,
    unlocked_levels: player.unlocked_levels,
    money: player.money,
    level_stars: levelStars,
    daily_solved_date: player.daily_solved_date,
    daily_stars: player.daily_stars,
  });

  document.getElementById('moneyAmount').textContent = player.money + '€';
  if (window._refreshScoreboard) window._refreshScoreboard();
  triggerSolvedUI(reward > 0 ? `Reward: ${reward}€` : '', bestStars);
}


/**
 * Toggle a bus-split switch on the client-side network object.
 * Pure logic — no rendering concerns.
 */
export function toggleSwitch(network, switchID) {
  const direction = switchID.split('_')[1];
  const lineID = switchID.split('_')[0];
  const [from_id, to_id] = lineID.slice(1).split('-');
  const isToDirection = direction === 'to';

  const targetNodeId = isToDirection ? to_id : from_id;
  const otherNodeId = isToDirection ? from_id : to_id;
  let newNode;

  if (targetNodeId.includes('b')) {
    const originalId = targetNodeId.slice(0, -1);
    newNode = network.nodes[originalId];

    let connectionCount = 0;
    for (const line of Object.values(network.lines)) {
      if (line.from_node === targetNodeId || line.to_node === targetNodeId) {
        connectionCount++;
        if (connectionCount > 1) break;
      }
    }
    if (connectionCount === 1) delete network.nodes[targetNodeId];
  } else {
    const bNodeId = targetNodeId + 'b';
    if (!network.nodes[bNodeId]) {
      const base = network.nodes[targetNodeId];
      newNode = { id: bNodeId, injection: 0.0, x: base.x, y: base.y };
      network.nodes[bNodeId] = newNode;
    } else {
      newNode = network.nodes[bNodeId];
    }
  }

  const newLineId = isToDirection
    ? `L${from_id}-${newNode.id}`
    : `L${newNode.id}-${to_id}`;

  const oldLine = network.lines[lineID];
  network.lines[newLineId] = {
    id: newLineId,
    from_node: isToDirection ? otherNodeId : newNode.id,
    to_node: isToDirection ? newNode.id : otherNodeId,
    flow: 0.0,
    limit: oldLine.limit,
  };

  delete network.lines[lineID];
  return network;
}
