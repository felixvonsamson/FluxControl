import { Container, Graphics, Text, Circle, ColorMatrixFilter } from 'pixi.js';
import { config } from '../config.js';
import { deadIslandNodeIds, faultSites } from './powerFlow.js';
import { createFaultField } from './faultField.js';

// Opacity of dead islands (lines, labels, bypass rings) so the live grid stands out.
const DEAD_ALPHA = 0.3;

// Colour saturation of the grid while it is split (1 = normal, 0 = grey). The
// fault line and the switches stay at full strength.
const BLACKOUT_SATURATION = 0.15;

// Scale applied to both the main node dot and the b-node ring while a bus-split is active.
export const SPLIT_SCALE = 0.8;

/**
 * Build PixiJS display objects for a network state.
 *
 * @param {'switches'|'redispatch'} mode
 * @param {object} network
 * @param {object} callbacks  { onToggle, onNodeClick, onRedispatchSelect }
 * @param {boolean} overview  simplified rendering for the minimap
 * @param {object} view  { reconnecting: Set<string> } switch ids that would heal a split,
 *   { pair: string[] } nodes currently selected on the redispatch scale
 * @returns {{ container, particles, uiElements, overloadedGfx, faultField }}
 *   - container:    add to world / overviewWorld
 *   - particles:    animate in ticker  { gfx, from, to, t, speed, color }
 *   - uiElements:   inverse-scale each tick so they stay pixel-constant at any zoom
 *   - overloadedGfx pulse alpha in ticker when there are overloaded lines
 */
export function createNetwork(mode, network, callbacks = {}, overview = false, view = {}) {
  const container = new Container();
  const particles = [];
  const uiElements = [];
  const bNodeContainers = {};  // id → Container, needed for entrance animation
  const mainNodeGraphics = {};  // id → Graphics,   needed for exit/entrance pulse

  // ── Layer stack (order = z-order, first = bottom) ─────────────
  // b-node rings sit behind everything. Lines are drawn above them, but each
  // line is drawn twice: first a wider background-coloured shadow stroke, then
  // the actual coloured stroke. The dark border at ring-crossing points makes
  // it visually clear the line floats above the ring and is not connected to it.
  const bNodeLayer = new Container(); // individual b-node rings (animated)
  const ringParticleLayer = new Container(); // ring arc particles — below lines so shadows mask them
  const lineShadowGfx = new Graphics();  // bg-coloured outline under all lines
  const normalLinesGfx = new Graphics();
  const overloadedGfx = new Graphics();  // animated alpha when overloaded
  const deadLinesGfx = new Graphics();   // lines of dead islands, dimmed
  deadLinesGfx.alpha = DEAD_ALPHA;
  const particleLayer = new Container();
  const nodeLayer = new Container();
  const uiLayer = new Container(); // labels and flow badges
  const switchLayer = new Container(); // switches: above everything, never desaturated

  // The grid layers go in one group so a split can desaturate them together.
  const gridGroup = new Container();
  gridGroup.addChild(bNodeLayer);
  gridGroup.addChild(ringParticleLayer);
  gridGroup.addChild(lineShadowGfx);
  gridGroup.addChild(normalLinesGfx);
  gridGroup.addChild(overloadedGfx);
  gridGroup.addChild(deadLinesGfx);
  gridGroup.addChild(particleLayer);
  gridGroup.addChild(nodeLayer);
  gridGroup.addChild(uiLayer);

  // ── Split grid: fault line under the grid, blackout on the grid ──
  // A split (real buses on more than one island) has no defined flows. The
  // grid greys out, flows are hidden, and the boundary between the islands is
  // drawn as a pulsing red line. Ported from the iOS app.
  const sites = overview ? [] : faultSites(network);
  const blackout = sites.length > 0;
  let faultField = null;
  if (blackout) {
    faultField = createFaultField(sites, config.colors.lineOverload);
    container.addChild(faultField.mesh);

    const desaturate = new ColorMatrixFilter();
    const s = BLACKOUT_SATURATION;
    const [lr, lg, lb] = [0.299, 0.587, 0.114];
    // Rows are R, G, B, A of a 4x5 colour matrix (last column = offset).
    desaturate.matrix = [
      lr * (1 - s) + s, lg * (1 - s),     lb * (1 - s),     0, 0,
      lr * (1 - s),     lg * (1 - s) + s, lb * (1 - s),     0, 0,
      lr * (1 - s),     lg * (1 - s),     lb * (1 - s) + s, 0, 0,
      0,                0,                0,                1, 0,
    ];
    gridGroup.filters = [desaturate];
    particleLayer.visible = false;
  }
  container.addChild(gridGroup);
  container.addChild(switchLayer);

  const reconnecting = view.reconnecting ?? new Set();

  const deadNodes = deadIslandNodeIds(network);

  const lineWidth = overview ? config.sizes.lineWidth * 4 : config.sizes.lineWidth;

  // ── Lines, particles, switches ─────────────────────────────────
  for (const line of Object.values(network.lines)) {
    const from = network.nodes[line.from_node];
    const to = network.nodes[line.to_node];

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = dx / len;
    const ny = dy / len;

    // Endpoints: shorten to ring edge in main view; go to centre in overview (no ring shown)
    const bOffset = overview ? 0 : config.sizes.ringRadiusOuter * 0.99;
    const x1 = from.x + (from.id.includes('b') ? nx * bOffset : 0);
    const y1 = from.y + (from.id.includes('b') ? ny * bOffset : 0);
    const x2 = to.x - (to.id.includes('b') ? nx * bOffset : 0);
    const y2 = to.y - (to.id.includes('b') ? ny * bOffset : 0);

    const overloaded = Math.abs(line.flow) > line.limit;
    const dead = deadNodes.has(line.from_node);
    const target = dead ? deadLinesGfx : overloaded ? overloadedGfx : normalLinesGfx;
    const color = overloaded ? config.colors.lineOverload : config.colors.line;

    if (!overview) {
      lineShadowGfx.moveTo(x1, y1).lineTo(x2, y2).stroke({ width: lineWidth + 4, color: config.colors.background });
    }
    target.moveTo(x1, y1).lineTo(x2, y2).stroke({ width: lineWidth, color });

    if (overview) continue;

    // Flow label
    const flow = Math.abs(line.flow);
    const flowText = flow >= 49.5 && flow <= 50.5 ? flow.toFixed(1) : flow.toFixed(0);
    const flowTextColor = overloaded ? config.colors.chipTextOverload : config.colors.chipText;
    const flowLabel = makeBadge(flowText, flowTextColor, 16);
    flowLabel.x = (from.x + to.x) / 2;
    flowLabel.y = (from.y + to.y) / 2;
    if (dead) flowLabel.alpha = DEAD_ALPHA;
    flowLabel.visible = !blackout;  // stale flows would lie
    uiLayer.addChild(flowLabel);
    uiElements.push(flowLabel);

    // Particles
    const effectiveLen = Math.hypot(x2 - x1, y2 - y1) || 1;
    const nParticles = Math.max(1, Math.floor(effectiveLen / 10));
    const speed = line.flow / effectiveLen * 2;
    const dotColor = overloaded ? config.colors.overloadDot : config.colors.flowDot;

    for (let i = 0; i < nParticles; i++) {
      const gfx = makeParticleGfx(dotColor, flow);
      particleLayer.addChild(gfx);

      const t0 = i / nParticles;
      gfx.x = x1 + (x2 - x1) * t0;
      gfx.y = y1 + (y2 - y1) * t0;

      particles.push({
        gfx,
        from: { x: x1, y: y1 },
        to: { x: x2, y: y2 },
        t: t0,
        speed,
        color: dotColor,
      });
    }

    // Switches
    if (mode === 'switches') {
      for (const end of ['from', 'to']) {
        const isB = (end === 'from' ? from : to).id.includes('b');
        const sw = makeSwitch(isB, reconnecting.has(line.id + '_' + end));

        sw.x = end === 'from' ? from.x + nx * 15 : to.x - nx * 15;
        sw.y = end === 'from' ? from.y + ny * 15 : to.y - ny * 15;

        sw.eventMode = 'static';
        sw.cursor = 'pointer';
        sw.on('pointertap', () => callbacks.onToggle?.(line.id + '_' + end));
        sw.on('pointerover', () => { sw._hoverTarget = 1.3; });
        sw.on('pointerout', () => { sw._hoverTarget = 1; });

        switchLayer.addChild(sw);
        uiElements.push(sw);
      }
    }
  }

  // ── b-node rings (main view only) ─────────────────────────────
  for (const [id, node] of Object.entries(network.nodes)) {
    if (!id.includes('b') || overview) continue;
    const bCont = makeBNodeContainer(node.x, node.y);
    bNodeLayer.addChild(bCont);
    bNodeContainers[id] = bCont;
    if (deadNodes.has(id)) bCont.alpha = DEAD_ALPHA;

    // Particles that travel around the ring between connection points,
    // each arc at a speed matching the bus current flowing through it.
    addRingParticles(network, id, node.x, node.y, ringParticleLayer, particles);
  }

  // ── Regular nodes ──────────────────────────────────────────────
  for (const [id, node] of Object.entries(network.nodes)) {
    if (id.includes('b')) continue;

    const color = node.injection >= 0 ? config.colors.nodeProd : config.colors.nodeCons;
    const gfx = new Graphics();
    gfx.circle(0, 0, config.sizes.nodeRadius).fill(color);
    gfx.x = node.x;
    gfx.y = node.y;
    mainNodeGraphics[id] = gfx;
    if (!overview && network.nodes[id + 'b']) gfx.scale.set(SPLIT_SCALE);

    if (!overview) {
      gfx.eventMode = 'static';
      gfx.cursor = 'pointer';
      gfx.on('pointertap', () => {
        if (mode === 'switches') callbacks.onNodeClick?.(node.id);
        else if (mode === 'redispatch') callbacks.onRedispatchSelect?.(node.id);
      });
    }
    nodeLayer.addChild(gfx);

    if (overview) continue;

    // Injection label
    const injLabel = makeLabel(node.injection.toFixed(0), config.colors.labelText, 16);
    injLabel.x = node.x;
    injLabel.y = node.y;
    uiLayer.addChild(injLabel);
    uiElements.push(injLabel);

    // Redispatch mode: selection ring + net adjustment badge
    if (mode === 'redispatch') {
      if (view.pair?.includes(id)) {
        const ring = new Graphics();
        ring.circle(0, 0, config.sizes.nodeRadius + 5)
          .stroke({ width: 3, color: config.colors.redispatch });
        ring.x = node.x;
        ring.y = node.y;
        nodeLayer.addChild(ring);
      }

      const adj = network.redispatch?.adjustments?.[id];
      if (adj && adj !== 0) {
        const adjLabel = makeBadge((adj > 0 ? '+' : '') + adj.toFixed(0), config.colors.redispatch, 14);
        adjLabel.x = node.x + 12;
        adjLabel.y = node.y;
        uiLayer.addChild(adjLabel);
        uiElements.push(adjLabel);
      }
    }
  }

  return { container, particles, uiElements, overloadedGfx, bNodeContainers, mainNodeGraphics, faultField };
}


// ── B-node ring flow ──────────────────────────────────────────────
//
// A b-node (bus-split) is a single electrical node, but it is drawn as a ring
// so the player can see the "bus bar" that bypassing lines tap into. The lines
// connect at points around the ring; the current each line carries must travel
// around the ring to reach the others. Different ring arcs therefore carry
// different currents, and we animate particles on each arc at the matching speed.
//
// We treat the ring as an ideal bus bar (a zero-impedance conductor with
// resistance proportional to arc length). Let the connection points, sorted by
// angle, inject currents c_0…c_{k-1} into the ring (Σ c_i = 0 since the b-node
// has zero injection). The current on arc i (point i → point i+1) is
//   f_i = f_0 + S_i,   S_i = c_1 + … + c_i   (KCL around the ring),
// where f_0 is the free circulating current. We fix it by minimising the bus-bar
// dissipation Σ L_i f_i²  ⇒  f_0 = −Σ L_i S_i / Σ L_i  (L_i = arc length).
//
// For the common two-line bypass this splits the current evenly both ways round
// the ring — exactly the intuitive behaviour the tutorial asks the player to see.
function addRingParticles(network, nodeId, cx, cy, particleLayer, particles) {
  const radius = (config.sizes.ringRadiusOuter + config.sizes.ringRadiusInner) / 2;

  // Connection points: angle on the ring + current injected INTO the ring.
  const conns = [];
  for (const line of Object.values(network.lines)) {
    let other, current;
    if (line.to_node === nodeId) {
      other = network.nodes[line.from_node];
      current = line.flow;        // positive flow enters the b-node
    } else if (line.from_node === nodeId) {
      other = network.nodes[line.to_node];
      current = -line.flow;       // positive flow leaves the b-node
    } else {
      continue;
    }
    if (!other) continue;
    conns.push({ angle: Math.atan2(other.y - cy, other.x - cx), current });
  }
  if (conns.length < 2) return;

  conns.sort((a, b) => a.angle - b.angle);
  const k = conns.length;

  // Angular span of each arc (point i → point i+1, wrapping).
  const span = [];
  for (let i = 0; i < k; i++) {
    let d = conns[(i + 1) % k].angle - conns[i].angle;
    if (d <= 0) d += Math.PI * 2;
    span.push(d);
  }

  // Partial sums S_i and the dissipation-minimising circulating current f_0.
  const S = [0];
  for (let i = 1; i < k; i++) S.push(S[i - 1] + conns[i].current);
  let num = 0, den = 0;
  for (let i = 0; i < k; i++) { num += span[i] * S[i]; den += span[i]; }
  const f0 = den > 0 ? -num / den : 0;

  // Emit particles per arc, signed flow → direction & speed.
  for (let i = 0; i < k; i++) {
    const flow = f0 + S[i];
    const arcLen = radius * span[i];
    if (Math.abs(flow) < 0.05 || arcLen < 0.5) continue;  // no visible current

    const a0 = conns[i].angle;
    const arcSpan = span[i];
    const nParticles = Math.max(1, Math.floor(arcLen / 8));
    // Same flow→speed mapping as line particles: linear speed = flow * 0.02 px/frame.
    const speed = flow / arcLen * 2;
    const dotColor = config.colors.flowDot;

    for (let j = 0; j < nParticles; j++) {
      const gfx = makeParticleGfx(dotColor, flow);
      particleLayer.addChild(gfx);

      const t0 = j / nParticles;
      const ang = a0 + arcSpan * t0;
      gfx.x = cx + radius * Math.cos(ang);
      gfx.y = cy + radius * Math.sin(ang);

      particles.push({
        gfx, arc: true,
        cx, cy, radius, a0, span: arcSpan,
        t: t0, speed, color: dotColor,
      });
    }
  }
}


// ── Drawing helpers ───────────────────────────────────────────────

function makeParticleGfx(color, flow) {
  const r = config.sizes.particleRadius;
  const g = new Graphics();
  g.circle(0, 0, r * 2).fill({ color: 0xffffff, alpha: 0.35 }); // glow halo
  g.circle(0, 0, r).fill(0xffffff); // solid core
  g.tint = color;
  g.alpha = Math.min(1, Math.abs(flow)); // fade out as flow → 0
  return g;
}

function makeLabel(text, fill, fontSize) {
  const t = new Text({
    text,
    style: { fill, fontSize, fontWeight: 'bold', fontFamily: 'sans-serif' },
  });
  t.anchor.set(0.5);
  return t;
}

function makeBadge(text, textColor, fontSize) {
  const t = new Text({ text, style: { fill: textColor, fontSize, fontWeight: 'bold', fontFamily: 'sans-serif' } });
  t.anchor.set(0.5);
  const tw = t.width > 0 ? t.width : text.length * fontSize * 0.65;
  const th = t.height > 0 ? t.height : fontSize * 1.4;
  const px = 8, py = 4;
  const bg = new Graphics();
  bg.roundRect(-tw / 2 - px, -th / 2 - py, tw + px * 2, th + py * 2, 4)
    .fill({ color: config.colors.chipBg, alpha: 1 })
    .stroke({ width: 1.5, color: config.colors.chipBorder });
  const c = new Container();
  c.addChild(bg, t);
  return c;
}

function makeSwitch(isB, reconnecting = false) {
  const g = new Graphics();
  const r = config.sizes.switchRadius;
  if (reconnecting) {
    // Toggling this switch would heal the split: solid red, static (a pulse
    // would inject energy into a grid meant to read as dead).
    g.circle(0, 0, r).fill({ color: config.colors.lineOverload });
    g.circle(0, 0, r + 3).stroke({ width: 3, color: 0xffffff, alpha: 0.9 });
  } else if (isB) {
    // Connected to the bypass node — highlight with the b-node accent color.
    g.circle(0, 0, r).fill({ color: config.colors.switch });
    g.circle(0, 0, r + 3).stroke({ width: 3, color: config.colors.bNode });
  } else {
    g.circle(0, 0, r).fill({ color: config.colors.switchActive });
    g.circle(0, 0, r + 3).stroke({ width: 3, color: config.colors.switch });
  }
  g.hitArea = new Circle(0, 0, r * 2.5);
  g._hoverScale = 1;
  g._hoverTarget = 1;
  return g;
}

// ── B-node ring factory (used by createNetwork + phantom animations) ─
export function makeBNodeContainer(x, y) {
  const ringW = config.sizes.ringRadiusOuter - config.sizes.ringRadiusInner;
  const ringMid = (config.sizes.ringRadiusOuter + config.sizes.ringRadiusInner) / 2;
  const g = new Graphics();
  g.circle(0, 0, ringMid).stroke({ width: ringW, color: config.colors.line });
  const c = new Container();
  c.x = x;
  c.y = y;
  c.addChild(g);
  return c;
}

