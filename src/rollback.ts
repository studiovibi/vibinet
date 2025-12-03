// Rollback: Logarithmic-space snapshot history using exponentially-spaced checkpoints.
//
// This data structure stores O(log n) snapshots for n pushes, allowing efficient
// rollback to any point in history. Each snapshot stores a tick number and state.
//
// The structure uses a "skew binary" approach where snapshots are kept at
// exponentially increasing intervals.
//
// Key insight from the original rollback.js:
// - When keep=0, the next push promotes it to keep=1 (and discards the new state!)
// - When keep=1 with life=0, we recursively push the old state and put new on top
// - When keep=1 with life>0, we demote old state (decrement life) and put new on top
//
// This means NOT every pushed state is stored - only states at specific positions
// in the push sequence are kept (forming exponential intervals).

export type Snapshot<S> = {
  tick:  number;      // the tick this state corresponds to
  keep:  0 | 1;       // 1 = kept (stable), 0 = temporary (may be merged)
  life:  number;      // controls merging depth
  state: S;           // the actual state
  older: Snapshot<S> | null;
};

// Push a new state for a given tick onto the snapshot stack.
// NOTE: Not every pushed state is retained! The algorithm selectively keeps
// states at exponentially increasing intervals. Some pushes just update
// the structure without storing the new state.
export function push<S>(tick: number, state: S, snapshots: Snapshot<S> | null): Snapshot<S> {
  if (snapshots === null) {
    return { tick, keep: 0, life: 0, state, older: null };
  }

  const { keep, life, state: old_state, older, tick: old_tick } = snapshots;

  if (keep === 0) {
    // Previous snapshot was temporary - promote it to kept
    // The NEW state is discarded; we keep the old state but mark it as "kept"
    return { tick: old_tick, keep: 1, life, state: old_state, older };
  }

  if (life > 0) {
    // Previous was kept with remaining life - demote it and place new on top
    return {
      tick,
      keep: 0,
      life: 0,
      state,
      older: { tick: old_tick, keep: 0, life: life - 1, state: old_state, older }
    };
  }

  // Previous was kept with life=0 - recursively push it down
  return { tick, keep: 0, life: 0, state, older: push(old_tick, old_state, older) };
}

// Find the most recent snapshot at or before the given tick.
// Returns [state, tick] or null if none found.
export function find_recent<S>(
  target_tick: number,
  snapshots: Snapshot<S> | null
): [S, number] | null {
  let current = snapshots;

  while (current !== null) {
    if (current.tick <= target_tick) {
      return [current.state, current.tick];
    }
    current = current.older;
  }

  return null;
}

// Invalidate (remove) all snapshots with tick >= target_tick.
// Returns the new snapshot stack with only earlier snapshots.
export function invalidate_from<S>(
  target_tick: number,
  snapshots: Snapshot<S> | null
): Snapshot<S> | null {
  if (snapshots === null) {
    return null;
  }

  // If this snapshot is at or after target, skip it and check older
  if (snapshots.tick >= target_tick) {
    return invalidate_from(target_tick, snapshots.older);
  }

  // This snapshot is before target_tick, keep it but check older ones
  // We need to rebuild the chain in case older snapshots need invalidation
  const new_older = invalidate_from(target_tick, snapshots.older);

  // If older didn't change, return as-is
  if (new_older === snapshots.older) {
    return snapshots;
  }

  // Rebuild with invalidated older chain
  // Reset keep/life since structure may have changed
  return {
    tick:  snapshots.tick,
    keep:  0,
    life:  0,
    state: snapshots.state,
    older: new_older
  };
}

// Get the tick of the most recent snapshot, or null if empty.
export function latest_tick<S>(snapshots: Snapshot<S> | null): number | null {
  if (snapshots === null) {
    return null;
  }
  return snapshots.tick;
}

// Count the number of snapshots (for debugging/testing).
export function count<S>(snapshots: Snapshot<S> | null): number {
  let n = 0;
  let current = snapshots;

  while (current !== null) {
    n++;
    current = current.older;
  }

  return n;
}

// Convert to array of [tick, state] pairs for debugging.
export function to_array<S>(snapshots: Snapshot<S> | null): Array<[number, S]> {
  const result: Array<[number, S]> = [];
  let current = snapshots;

  while (current !== null) {
    result.push([current.tick, current.state]);
    current = current.older;
  }

  return result;
}

// Get array of just ticks (for debugging).
export function ticks<S>(snapshots: Snapshot<S> | null): number[] {
  const result: number[] = [];
  let current = snapshots;

  while (current !== null) {
    result.push(current.tick);
    current = current.older;
  }

  return result;
}
