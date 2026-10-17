'use strict';

/**
 * How many roles one person may hold from a role menu (#5800): an element,
 * a class, a team. The menu keeps the number as data.maxPicks next to its
 * roles; none, or 0, means any number, as before.
 *
 * Taking a role past the limit:
 *   - with a limit of one, the new role replaces the one held, the way a
 *     single-choice list works;
 *   - with a higher limit, it is refused until one is dropped.
 * Dropping a role is always allowed.
 */

const MAX = 20;

// The limit stored on a menu row, or 0 for any number.
function maxPicksOf(row) {
  try {
    const n = JSON.parse((row && row.data) || '{}').maxPicks;
    return Number.isInteger(n) && n >= 1 && n <= MAX ? n : 0;
  } catch { return 0; } // a malformed row has no limit, as before limits existed
}

// A limit sent by the menu's editor: a whole number from 0 (any) up to the
// number of roles on the menu; a limit as high as that is no limit at all.
function cleanMaxPicks(value, roleCount) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n >= roleCount) return 0;
  return Math.min(n, MAX);
}

// What taking roleId does, given the menu's roles the person holds now:
// { drop: [roleIds] } (possibly empty), or { error } when it is refused.
function planPick({ held, roleId, maxPicks }) {
  if (!maxPicks) return { drop: [] };
  const others = (held || []).filter(id => id !== roleId);
  if (others.length < maxPicks) return { drop: [] };
  if (maxPicks === 1) return { drop: others };
  return { error: `You can pick up to ${maxPicks} roles here. Drop one first.` };
}

module.exports = { maxPicksOf, cleanMaxPicks, planPick, MAX };
