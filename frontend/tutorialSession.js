// The tutorial borrows sessionStorage ('player' and 'network'). These helpers stash
// the real values while it runs and put them back afterwards, however the tutorial
// page was left (Done button, browser back, reload, closing the tab).

const ACTIVE = 'tutorial_active';
const SAVED_PLAYER = 'tutorial_saved_player';
const SAVED_NETWORK = 'tutorial_saved_network';

// Only the first call per tutorial session stashes: on a reload the storage already
// holds tutorial data, which must not overwrite the real state.
export function stashGameState() {
  if (sessionStorage.getItem(ACTIVE)) return;
  for (const [key, saved] of [['player', SAVED_PLAYER], ['network', SAVED_NETWORK]]) {
    const value = sessionStorage.getItem(key);
    if (value !== null) sessionStorage.setItem(saved, value);
    else sessionStorage.removeItem(saved);
  }
  sessionStorage.setItem(ACTIVE, '1');
}

// No-op unless a tutorial session is pending.
export function restoreGameState() {
  if (!sessionStorage.getItem(ACTIVE)) return;
  for (const [key, saved] of [['player', SAVED_PLAYER], ['network', SAVED_NETWORK]]) {
    const value = sessionStorage.getItem(saved);
    if (value !== null) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
    sessionStorage.removeItem(saved);
  }
  sessionStorage.removeItem('network_before_redispatch');
  sessionStorage.removeItem(ACTIVE);
}
