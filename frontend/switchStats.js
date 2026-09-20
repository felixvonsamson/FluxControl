// Difficulty telemetry: how many switches the player flips on a career level.
// Flips are tallied locally and reported as deltas; the server accumulates them
// per (player, level) until the level is solved without redispatch.
// Not tracked for guests, the daily problem or custom networks.

import { authHeaders } from './auth/auth.js';

const KEY = 'switch_pending'; // { level, count }
const FLUSH_DELAY = 2000; // ms after the last flip

let timer = null;

function readPending() {
  try {
    return JSON.parse(sessionStorage.getItem(KEY)) ?? { level: null, count: 0 };
  } catch {
    return { level: null, count: 0 };
  }
}

function writePending(level, count) {
  sessionStorage.setItem(KEY, JSON.stringify({ level, count }));
}

function isTracked(network) {
  const player = JSON.parse(sessionStorage.getItem('player'));
  return network.level != null && !window._dailyMode && !player?.is_guest;
}

/** Record `n` switch flips on the current level of `network`. */
export function countSwitches(network, n) {
  if (n <= 0 || !isTracked(network)) return;
  const pending = readPending();
  if (pending.level !== null && pending.level !== network.level) flushSwitchStats();
  const current = readPending();
  writePending(network.level, (current.level === network.level ? current.count : 0) + n);
  clearTimeout(timer);
  timer = setTimeout(() => flushSwitchStats(), FLUSH_DELAY);
}

/** Take the unreported flips for `level` (to send with a solution check). */
export function takePendingSwitches(level) {
  const pending = readPending();
  if (pending.level !== level || pending.count === 0) return 0;
  writePending(level, 0);
  return pending.count;
}

/** Put flips back after a failed request so they are reported next time. */
export function restorePendingSwitches(level, count) {
  if (count === 0) return;
  const pending = readPending();
  writePending(level, (pending.level === level ? pending.count : 0) + count);
}

/** Report unreported flips. Safe to call at any time, including page hide. */
export function flushSwitchStats() {
  clearTimeout(timer);
  const { level } = readPending();
  if (level === null) return;
  const count = takePendingSwitches(level);
  if (count === 0) return;
  fetch('/api/record_switches', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ level, count }),
    keepalive: true,
  })
    .then(r => { if (!r.ok) restorePendingSwitches(level, count); })
    .catch(() => restorePendingSwitches(level, count));
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSwitchStats();
});
