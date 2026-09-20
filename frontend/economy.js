// Coin economy shared by the redispatch UI, the guest solve path and the
// tutorial. The server applies the same rules in backend/network.py and
// backend/main.py (settle_coins) — keep the constants in sync.

export const REDISPATCH_COST_INCREASE = 30; // €/MW to raise production
export const REDISPATCH_COST_DECREASE = 10; // €/MW to reduce production
export const SOLVE_REWARD = 50;

/** Total price of a redispatch, rounded once to whole coins. */
export function calcRedispatchCost(adjustments) {
  let total = 0;
  for (const adj of Object.values(adjustments ?? {})) {
    total += adj > 0 ? adj * REDISPATCH_COST_INCREASE : -adj * REDISPATCH_COST_DECREASE;
  }
  return Math.round(total);
}

/** True when solving the current puzzle would be the player's first solve of it. */
export function isFirstSolve(player, dailyMode) {
  if (dailyMode) {
    const today = new Date().toISOString().slice(0, 10);
    return player.daily_solved_date !== today;
  }
  return player.current_level >= player.unlocked_levels;
}

/** Coins actually charged: redispatch on an already solved puzzle is free. */
export function redispatchCharge(player, cost, dailyMode) {
  return isFirstSolve(player, dailyMode) ? cost : 0;
}

/** Redispatch must be paid from coins already owned, not from the solve reward. */
export function canAffordRedispatch(player, cost, dailyMode) {
  return redispatchCharge(player, cost, dailyMode) <= (player.money ?? 0);
}

/**
 * Coin change from moving one node by one MW, given its current net offset
 * from the original level. Cost is per node on its net offset (a V with its
 * kink at zero), so moving back toward zero refunds instead of costing extra.
 * Positive = coins spent, negative = refunded.
 */
export function marginalCost(offset, step) {
  if (step > 0) return offset >= 0 ? REDISPATCH_COST_INCREASE : -REDISPATCH_COST_DECREASE;
  return offset <= 0 ? REDISPATCH_COST_DECREASE : -REDISPATCH_COST_INCREASE;
}

/** Coin change of a 1 MW transfer: raise one node, lower the other. */
export function transferPrice(offsetRaised, offsetLowered) {
  return marginalCost(offsetRaised, 1) + marginalCost(offsetLowered, -1);
}
