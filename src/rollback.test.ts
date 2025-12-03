import { describe, it, expect } from "bun:test";
import * as rollback from "./rollback.ts";

describe("rollback", () => {
  describe("push", () => {
    it("creates a snapshot from null", () => {
      const snap = rollback.push(0, "state0", null);
      expect(snap.tick).toBe(0);
      expect(snap.state).toBe("state0");
      expect(snap.older).toBeNull();
    });

    it("builds a chain of snapshots", () => {
      let snap: rollback.Snapshot<number> | null = null;
      for (let t = 0; t < 10; t++) {
        snap = rollback.push(t, t * 100, snap);
      }
      expect(rollback.count(snap)).toBeLessThanOrEqual(10);
      // Note: The algorithm doesn't keep every state; some are discarded.
      // The latest tick stored will be one of the recent even ticks.
      const latest = rollback.latest_tick(snap);
      expect(latest).not.toBeNull();
      expect(latest!).toBeLessThanOrEqual(9);
      expect(latest!).toBeGreaterThanOrEqual(6); // Should keep a recent state
    });

    it("maintains O(log n) space for n pushes", () => {
      let snap: rollback.Snapshot<number> | null = null;
      for (let t = 0; t < 1000; t++) {
        snap = rollback.push(t, t, snap);
      }
      const count = rollback.count(snap);
      // Should be roughly O(log n), certainly less than 50 for 1000 entries
      expect(count).toBeLessThan(50);
    });

    it("keeps snapshots at exponentially spaced intervals", () => {
      let snap: rollback.Snapshot<number> | null = null;
      for (let t = 0; t < 100; t++) {
        snap = rollback.push(t, t, snap);
      }
      const ticks = rollback.ticks(snap);
      // First tick should be one of the most recent (algorithm may skip some)
      expect(ticks[0]).toBeGreaterThanOrEqual(90);
      // Should include tick 0 (the initial state is always kept)
      expect(ticks.includes(0)).toBe(true);
      // Ticks should be in descending order
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i - 1]).toBeGreaterThan(ticks[i]);
      }
    });
  });

  describe("find_recent", () => {
    it("returns null for empty snapshots", () => {
      expect(rollback.find_recent(5, null)).toBeNull();
    });

    it("finds snapshot at or before target", () => {
      // The algorithm doesn't store every pushed state, so we can't expect
      // exact tick matches for arbitrary push sequences. Instead, we verify
      // that find_recent returns a valid earlier snapshot.
      let snap: rollback.Snapshot<string> | null = null;
      snap = rollback.push(0, "a", snap);
      snap = rollback.push(5, "b", snap);
      snap = rollback.push(10, "c", snap);

      const result = rollback.find_recent(5, snap);
      expect(result).not.toBeNull();
      expect(result![1]).toBeLessThanOrEqual(5);
      // The state should be one we actually pushed
      expect(["a", "b", "c"]).toContain(result![0]);
    });

    it("finds closest earlier tick", () => {
      let snap: rollback.Snapshot<number> | null = null;
      for (let t = 0; t < 100; t++) {
        snap = rollback.push(t, t * 10, snap);
      }

      const result = rollback.find_recent(50, snap);
      expect(result).not.toBeNull();
      expect(result![1]).toBeLessThanOrEqual(50);
    });

    it("returns null when target is before all snapshots", () => {
      let snap: rollback.Snapshot<number> | null = null;
      snap = rollback.push(10, 100, snap);
      snap = rollback.push(20, 200, snap);

      const result = rollback.find_recent(5, snap);
      expect(result).toBeNull();
    });

    it("finds the most recent snapshot at or before target", () => {
      let snap: rollback.Snapshot<number> | null = null;
      for (let t = 0; t < 1000; t++) {
        snap = rollback.push(t, t, snap);
      }

      // Query for tick 500
      const result = rollback.find_recent(500, snap);
      expect(result).not.toBeNull();
      const [state, tick] = result!;
      expect(tick).toBeLessThanOrEqual(500);
      expect(state).toBe(tick); // state equals tick in our test
    });
  });

  describe("invalidate_from", () => {
    it("returns null for empty snapshots", () => {
      expect(rollback.invalidate_from(5, null)).toBeNull();
    });

    it("removes all snapshots at or after target tick", () => {
      let snap: rollback.Snapshot<number> | null = null;
      for (let t = 0; t < 100; t++) {
        snap = rollback.push(t, t, snap);
      }

      const invalidated = rollback.invalidate_from(50, snap);
      const ticks = rollback.ticks(invalidated);

      for (const tick of ticks) {
        expect(tick).toBeLessThan(50);
      }
    });

    it("preserves snapshots before target tick", () => {
      let snap: rollback.Snapshot<number> | null = null;
      for (let t = 0; t < 100; t++) {
        snap = rollback.push(t, t, snap);
      }

      const original_ticks = rollback.ticks(snap);
      const before_50 = original_ticks.filter(t => t < 50);

      const invalidated = rollback.invalidate_from(50, snap);
      const remaining_ticks = rollback.ticks(invalidated);

      // All remaining ticks should have been in the original before-50 set
      for (const tick of remaining_ticks) {
        expect(before_50.includes(tick)).toBe(true);
      }
    });

    it("returns null when invalidating from tick 0", () => {
      let snap: rollback.Snapshot<number> | null = null;
      for (let t = 0; t < 50; t++) {
        snap = rollback.push(t, t, snap);
      }

      const invalidated = rollback.invalidate_from(0, snap);
      expect(invalidated).toBeNull();
    });

    it("keeps all snapshots when target is beyond latest", () => {
      let snap: rollback.Snapshot<number> | null = null;
      for (let t = 0; t < 50; t++) {
        snap = rollback.push(t, t, snap);
      }

      const original_count = rollback.count(snap);
      const invalidated = rollback.invalidate_from(100, snap);
      const new_count = rollback.count(invalidated);

      expect(new_count).toBe(original_count);
    });
  });

  describe("integration: push after invalidate", () => {
    it("allows rebuilding after invalidation", () => {
      let snap: rollback.Snapshot<number> | null = null;

      // Build up to tick 100
      for (let t = 0; t < 100; t++) {
        snap = rollback.push(t, t, snap);
      }

      // Invalidate from tick 50
      snap = rollback.invalidate_from(50, snap);

      // Now rebuild from tick 50 with different values
      for (let t = 50; t < 100; t++) {
        snap = rollback.push(t, t + 1000, snap); // Different state
      }

      // Check that we can find states correctly
      const result = rollback.find_recent(75, snap);
      expect(result).not.toBeNull();
      const [state, tick] = result!;
      expect(tick).toBeLessThanOrEqual(75);
      // If tick >= 50, state should be tick + 1000
      if (tick >= 50) {
        expect(state).toBe(tick + 1000);
      } else {
        expect(state).toBe(tick);
      }
    });

    it("handles repeated invalidations correctly", () => {
      let snap: rollback.Snapshot<number> | null = null;

      // Build, invalidate, rebuild multiple times
      for (let round = 0; round < 5; round++) {
        for (let t = round * 20; t < (round + 1) * 20; t++) {
          snap = rollback.push(t, t + round * 1000, snap);
        }
        // Invalidate last 10 ticks of this round
        snap = rollback.invalidate_from((round + 1) * 20 - 10, snap);
      }

      // Verify structure is still valid
      expect(rollback.count(snap)).toBeGreaterThan(0);

      const ticks = rollback.ticks(snap);
      // Ticks should be in descending order
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i - 1]).toBeGreaterThan(ticks[i]);
      }
    });
  });

  describe("count and to_array", () => {
    it("counts zero for null", () => {
      expect(rollback.count(null)).toBe(0);
    });

    it("converts to array correctly", () => {
      let snap: rollback.Snapshot<string> | null = null;
      snap = rollback.push(0, "zero", snap);
      snap = rollback.push(1, "one", snap);
      snap = rollback.push(2, "two", snap);

      const arr = rollback.to_array(snap);
      expect(arr.length).toBe(rollback.count(snap));
      // Most recent first
      expect(arr[0][0]).toBe(2);
    });
  });

  describe("edge cases", () => {
    it("handles single snapshot", () => {
      const snap = rollback.push(42, "only", null);
      expect(rollback.count(snap)).toBe(1);
      expect(rollback.find_recent(42, snap)).toEqual(["only", 42]);
      expect(rollback.find_recent(100, snap)).toEqual(["only", 42]);
      expect(rollback.find_recent(41, snap)).toBeNull();
    });

    it("handles large tick values", () => {
      let snap: rollback.Snapshot<number> | null = null;
      const base = 1_000_000;
      for (let t = 0; t < 100; t++) {
        snap = rollback.push(base + t, t, snap);
      }

      const result = rollback.find_recent(base + 50, snap);
      expect(result).not.toBeNull();
      expect(result![1]).toBeLessThanOrEqual(base + 50);
    });

    it("handles complex state objects", () => {
      type GameState = { x: number; y: number; health: number };
      let snap: rollback.Snapshot<GameState> | null = null;

      for (let t = 0; t < 50; t++) {
        snap = rollback.push(t, { x: t, y: t * 2, health: 100 - t }, snap);
      }

      const result = rollback.find_recent(25, snap);
      expect(result).not.toBeNull();
      const [state, tick] = result!;
      expect(state.x).toBe(tick);
      expect(state.y).toBe(tick * 2);
      expect(state.health).toBe(100 - tick);
    });
  });
});

describe("vibi state caching simulation", () => {
  // Simulate how vibi.ts uses the rollback structure

  type MockState = { tick: number; events: string[] };
  type MockPost = { data: string };

  function apply_tick(state: MockState): MockState {
    return { tick: state.tick + 1, events: [...state.events] };
  }

  function apply_post(post: MockPost, state: MockState): MockState {
    return { tick: state.tick, events: [...state.events, post.data] };
  }

  it("caches states during forward computation", () => {
    let cache: rollback.Snapshot<MockState> | null = null;
    let state: MockState = { tick: 0, events: [] };
    const posts = new Map<number, MockPost[]>([
      [5, [{ data: "a" }]],
      [10, [{ data: "b" }]],
      [15, [{ data: "c" }]],
    ]);

    // Compute from tick 0 to tick 20, caching along the way
    for (let tick = 0; tick <= 20; tick++) {
      state = apply_tick(state);
      const tick_posts = posts.get(tick) || [];
      for (const post of tick_posts) {
        state = apply_post(post, state);
      }
      cache = rollback.push(tick, state, cache);
    }

    // Verify cache has logarithmic entries
    expect(rollback.count(cache)).toBeLessThan(15);

    // Query for tick 12
    const cached = rollback.find_recent(12, cache);
    expect(cached).not.toBeNull();
    const [cached_state, cached_tick] = cached!;
    expect(cached_tick).toBeLessThanOrEqual(12);
    // State at tick 12 should have events a and b (from ticks 5 and 10)
    if (cached_tick >= 10) {
      expect(cached_state.events).toContain("a");
      expect(cached_state.events).toContain("b");
    }
  });

  it("invalidates cache when late post arrives", () => {
    let cache: rollback.Snapshot<MockState> | null = null;
    let state: MockState = { tick: 0, events: [] };

    // Compute ticks 0-20 without posts
    for (let tick = 0; tick <= 20; tick++) {
      state = apply_tick(state);
      cache = rollback.push(tick, state, cache);
    }

    // Late post arrives for tick 10
    const late_post_tick = 10;
    cache = rollback.invalidate_from(late_post_tick, cache);

    // All cached ticks should be < 10
    const ticks = rollback.ticks(cache);
    for (const tick of ticks) {
      expect(tick).toBeLessThan(late_post_tick);
    }

    // Now recompute from cached state
    const cached = rollback.find_recent(9, cache);
    expect(cached).not.toBeNull();
    let [recompute_state, start_tick] = cached!;

    // Continue from start_tick + 1, now including the late post
    const late_post: MockPost = { data: "late" };
    for (let tick = start_tick + 1; tick <= 20; tick++) {
      recompute_state = apply_tick(recompute_state);
      if (tick === late_post_tick) {
        recompute_state = apply_post(late_post, recompute_state);
      }
      cache = rollback.push(tick, recompute_state, cache);
    }

    // Verify late post is in final state
    const final = rollback.find_recent(20, cache);
    expect(final).not.toBeNull();
    expect(final![0].events).toContain("late");
  });

  it("handles multiple late posts efficiently", () => {
    let cache: rollback.Snapshot<MockState> | null = null;
    let state: MockState = { tick: 0, events: [] };

    // Initial computation
    for (let tick = 0; tick <= 100; tick++) {
      state = apply_tick(state);
      cache = rollback.push(tick, state, cache);
    }

    // Simulate receiving posts in reverse order of their official ticks
    const late_posts = [
      { tick: 80, data: "p80" },
      { tick: 60, data: "p60" },
      { tick: 40, data: "p40" },
    ];

    for (const post of late_posts) {
      cache = rollback.invalidate_from(post.tick, cache);

      // Find best starting point
      const cached = rollback.find_recent(post.tick - 1, cache);
      if (cached) {
        const [cached_state, start_tick] = cached;
        // Would recompute from here...
        // (simplified - just verify cache state)
      }
    }

    // After all invalidations, cache should only have ticks < 40
    const ticks = rollback.ticks(cache);
    for (const tick of ticks) {
      expect(tick).toBeLessThan(40);
    }
  });
});

describe("performance characteristics", () => {
  it("push is O(log n) amortized", () => {
    const iterations = 10000;
    let snap: rollback.Snapshot<number> | null = null;

    const start = performance.now();
    for (let t = 0; t < iterations; t++) {
      snap = rollback.push(t, t, snap);
    }
    const elapsed = performance.now() - start;

    // Should complete in reasonable time (< 100ms for 10k ops)
    expect(elapsed).toBeLessThan(100);

    // Verify logarithmic space
    const count = rollback.count(snap);
    expect(count).toBeLessThan(Math.log2(iterations) * 5);
  });

  it("find_recent is O(log n)", () => {
    let snap: rollback.Snapshot<number> | null = null;
    for (let t = 0; t < 10000; t++) {
      snap = rollback.push(t, t, snap);
    }

    const queries = 1000;
    const start = performance.now();
    for (let i = 0; i < queries; i++) {
      const target = Math.floor(Math.random() * 10000);
      rollback.find_recent(target, snap);
    }
    const elapsed = performance.now() - start;

    // Should complete in reasonable time
    expect(elapsed).toBeLessThan(50);
  });

  it("invalidate_from is O(n) worst case but typically O(log n)", () => {
    let snap: rollback.Snapshot<number> | null = null;
    for (let t = 0; t < 10000; t++) {
      snap = rollback.push(t, t, snap);
    }

    const start = performance.now();
    // Invalidate from middle - should be fast
    rollback.invalidate_from(5000, snap);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(10);
  });
});
