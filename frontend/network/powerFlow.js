import { Matrix, solve } from "ml-matrix";

export function calculatePowerFlow(network) {
    /*
    DC power flow with the game's island rules (ported from the iOS app's
    FluxEngine `resolvingDeadIslands`, mirrored by the backend's
    `resolve_dead_islands`):

    - grid fully connected: solve it.
    - only dead bypass islands detached (a line opened at both ends, floating
      on phantom "b" buses): solve the live island, pin dead lines at zero
      flow. This is a legal state.
    - the base buses themselves split: no flows are defined, cost = Infinity.
      The caller treats that as a blocked move.
    */
    const { islandOfNode, islandCount, mainIslandCount } = islandPartition(network);

    if (mainIslandCount > 1) {
        network.cost = Infinity;
        for (const line of Object.values(network.lines)) line.flow = 0;
        return network;
    }
    if (islandCount === 1) return solveDcFlow(network);

    // Dead bypass islands: solve only the island holding the base buses.
    const mainNode = Object.keys(network.nodes).find(id => !id.endsWith('b'));
    const mainIsland = islandOfNode[mainNode];
    const live = { nodes: {}, lines: {}, cost: 0 };
    for (const [id, node] of Object.entries(network.nodes)) {
        if (islandOfNode[id] === mainIsland) live.nodes[id] = node;
    }
    // A line's endpoints always share an island, so from_node is enough.
    for (const [id, line] of Object.entries(network.lines)) {
        if (islandOfNode[line.from_node] === mainIsland) live.lines[id] = { ...line };
    }
    solveDcFlow(live);

    if (live.cost === Infinity) {
        network.cost = Infinity;
        for (const line of Object.values(network.lines)) line.flow = 0;
        return network;
    }
    for (const [id, line] of Object.entries(network.lines)) {
        network.lines[id] = { ...line, flow: live.lines[id]?.flow ?? 0 };
    }
    network.cost = live.cost;
    return network;
}

// Connected components. Base buses are classified apart from bypass ("b")
// buses so a detached bypass-only island can be told from a real split.
export function islandPartition(network) {
    const adjacency = {};
    for (const id of Object.keys(network.nodes)) adjacency[id] = [];
    for (const line of Object.values(network.lines)) {
        adjacency[line.from_node].push(line.to_node);
        adjacency[line.to_node].push(line.from_node);
    }

    const islandOfNode = {};
    const mainIslands = new Set();
    let islandCount = 0;
    for (const seed of Object.keys(network.nodes).sort()) {
        if (seed in islandOfNode) continue;
        const island = islandCount++;
        islandOfNode[seed] = island;
        const queue = [seed];
        for (let head = 0; head < queue.length; head++) {
            const id = queue[head];
            if (!id.endsWith('b')) mainIslands.add(island);
            for (const neighbor of adjacency[id]) {
                if (!(neighbor in islandOfNode)) {
                    islandOfNode[neighbor] = island;
                    queue.push(neighbor);
                }
            }
        }
    }
    return { islandOfNode, islandCount, mainIslandCount: mainIslands.size, mainIslands };
}

// Voronoi sites for the fault line: every base bus with the island it sits in.
// Empty unless the base buses span more than one island (a real split).
// Bypass "b" buses are excluded on purpose: they share coordinates with their
// base bus but can sit across the cut, and a bypass-only island is a dead
// line, not a cut.
export function faultSites(network) {
    const { islandOfNode, mainIslandCount } = islandPartition(network);
    if (mainIslandCount <= 1) return [];
    return Object.values(network.nodes)
        .filter(node => !node.id.endsWith('b'))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map(node => ({ x: node.x, y: node.y, island: islandOfNode[node.id] }));
}

// Ids of every bus in a dead island: a detached island holding no base bus,
// i.e. a line opened at both ends floating on its phantom "b" buses.
export function deadIslandNodeIds(network) {
    const { islandOfNode, mainIslands } = islandPartition(network);
    const dead = new Set();
    for (const [id, island] of Object.entries(islandOfNode)) {
        if (!mainIslands.has(island)) dead.add(id);
    }
    return dead;
}

function solveDcFlow(network) {
    /*
    Efficient DC power flow using Kirchhoff laws on a connected network.
    Uses ml-matrix for fast linear algebra.
    */

    const nodes = network.nodes;
    const lines = network.lines;

    const nodeIds = Object.keys(nodes);
    const lineIds = Object.keys(lines);

    const n = nodeIds.length;
    const m = lineIds.length;

    // --- Map node IDs to indices ---
    const idToIdx = {};
    nodeIds.forEach((id, i) => {
        idToIdx[id] = i;
    });

    // --- Build injection vector p ---
    const p = Matrix.columnVector(
        nodeIds.map(id => nodes[id].injection)
    );

    // --- Build incidence matrix A ---
    const A = Matrix.zeros(n, m);

    lineIds.forEach((lineId, ell) => {
        const line = lines[lineId];
        const i = idToIdx[line.from_node];
        const j = idToIdx[line.to_node];
        A.set(i, ell, 1);
        A.set(j, ell, -1);
    });

    // --- Build susceptance Laplacian B = A * A^T ---
    const B = A.mmul(A.transpose());

    // --- Slack bus: remove row/column 0 ---
    const Bred = B.subMatrix(1, n - 1, 1, n - 1);
    const pred = p.subMatrix(1, n - 1, 0, 0);

    // --- Solve B * theta = p ---
    let thetaRed;
    try {
        thetaRed = solve(Bred, pred);
    } catch {
        network.cost = Infinity;
        for (const lineId of lineIds) {
            lines[lineId].flow = 0;
        }
        return network;
    }

    const theta = Matrix.zeros(n, 1);
    thetaRed.to1DArray().forEach((val, i) => {
        theta.set(i + 1, 0, val);
    });

    // --- Line flows: f = A^T * theta ---
    const flows = A.transpose().mmul(theta).to1DArray();

    // --- Attach flows back to lines ---
    const updatedLines = {};
    lineIds.forEach((lineId, ell) => {
        const line = lines[lineId];
        updatedLines[lineId] = {
            id: line.id,
            from_node: line.from_node,
            to_node: line.to_node,
            flow: flows[ell],
            limit: line.limit
        };
    });

    // --- Cost = sum of overloads ---
    let cost = 0;
    lineIds.forEach(lineId => {
        const flow = updatedLines[lineId].flow;
        const limit = lines[lineId].limit;
        cost += Math.max(0, Math.abs(flow) - limit);
    });

    network.lines = updatedLines;
    network.cost = cost;

    return network;
}
