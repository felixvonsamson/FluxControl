import { calcRedispatchCost } from '../economy.js';

/**
 * Move `mw` of power from `loweringId` to `raisingId` (negative `mw` reverses
 * it). Every redispatch is a zero-sum pair, so the grid stays balanced by
 * construction. Only the per-node net offsets are stored — a chain A→B, B→C
 * ends up as A→C, and is priced as such.
 */
export function applyTransfer(network, raisingId, loweringId, mw) {
  const adjustments = network.redispatch.adjustments;
  for (const [id, delta] of [[raisingId, mw], [loweringId, -mw]]) {
    network.nodes[id].injection += delta;
    const total = (adjustments[id] || 0) + delta;
    if (total === 0) delete adjustments[id];
    else adjustments[id] = total;
  }
  network.redispatch.cost = calcRedispatchCost(adjustments);
  network.redispatch.unbalance = Object.values(adjustments).reduce((a, b) => a + b, 0);
}

/**
 * Pair selection for the scale: a tap fills a free slot, tapping a selected
 * node drops it, and a third node replaces the oldest so selection never
 * dead-ends.
 */
export function nextPair(pair, nodeId) {
  if (pair.includes(nodeId)) return pair.filter(id => id !== nodeId);
  if (pair.length < 2) return [...pair, nodeId];
  return [pair[1], nodeId];
}
