import * as client from "./client.ts";

type Post<P> = {
  room: string;
  index: number;
  server_time: number;
  client_time: number;
  name?: string; // unique id for dedup/reindex (optional for legacy)
  data: P;
};

type TimelineBucket<P> = {
  room: Post<P>[];
  local: Post<P>[];
};

type RoomPostInfo<P> = {
  post: Post<P>;
  tick: number;
};

type LocalPostInfo<P> = {
  post: Post<P>;
  tick: number;
};

export class Vibi<S, P> {
  room:              string;
  init:              S;
  on_tick:           (state: S) => S;
  on_post:           (post: P, state: S) => S;
  smooth:            (past: S, curr: S) => S;
  tick_rate:         number;
  tolerance:         number;
  room_posts:        Map<number, RoomPostInfo<P>>;
  local_posts:       Map<string, LocalPostInfo<P>>; // predicted local posts keyed by name
  timeline:          Map<number, TimelineBucket<P>>;
  cache_enabled:     boolean;
  snapshot_stride:   number;
  snapshot_count:    number;
  snapshots:         S[];
  snapshot_start_tick: number | null;
  dirty_from_tick:   number | null;
  initial_time_value: number | null;
  initial_tick_value: number | null;

  // Compute the authoritative time a post takes effect.
  private official_time(post: Post<P>): number {
    if (post.client_time <= post.server_time - this.tolerance) {
      return post.server_time - this.tolerance;
    } else {
      return post.client_time;
    }
  }

  // Convert a post into its authoritative tick.
  private official_tick(post: Post<P>): number {
    return this.time_to_tick(this.official_time(post));
  }

  private get_bucket(tick: number): TimelineBucket<P> {
    let bucket = this.timeline.get(tick);
    if (!bucket) {
      bucket = { room: [], local: [] };
      this.timeline.set(tick, bucket);
    }
    return bucket;
  }

  private insert_room_post(post: Post<P>, tick: number): void {
    const bucket = this.get_bucket(tick);
    const room   = bucket.room;

    if (room.length === 0 || room[room.length - 1].index <= post.index) {
      room.push(post);
    } else {
      const insert_at = room.findIndex((p) => p.index > post.index);
      if (insert_at === -1) {
        room.push(post);
      } else {
        room.splice(insert_at, 0, post);
      }
    }
  }

  private remove_room_post(post: Post<P>, tick: number): void {
    const bucket = this.timeline.get(tick);
    if (!bucket) {
      return;
    }
    const index = bucket.room.indexOf(post);
    if (index !== -1) {
      bucket.room.splice(index, 1);
    } else {
      const by_index = bucket.room.findIndex((p) => p.index === post.index);
      if (by_index !== -1) {
        bucket.room.splice(by_index, 1);
      }
    }
    if (bucket.room.length === 0 && bucket.local.length === 0) {
      this.timeline.delete(tick);
    }
  }

  private mark_dirty(tick: number): void {
    if (!this.cache_enabled) {
      return;
    }
    if (this.snapshot_start_tick !== null && tick < this.snapshot_start_tick) {
      return;
    }
    if (this.dirty_from_tick === null || tick < this.dirty_from_tick) {
      this.dirty_from_tick = tick;
    }
  }

  private advance_state(state: S, from_tick: number, to_tick: number): S {
    let next = state;
    for (let tick = from_tick + 1; tick <= to_tick; tick++) {
      next = this.apply_tick(next, tick);
    }
    return next;
  }

  private prune_before_tick(prune_tick: number): void {
    if (!this.cache_enabled) {
      return;
    }
    for (const tick of this.timeline.keys()) {
      if (tick < prune_tick) {
        this.timeline.delete(tick);
      }
    }
    for (const [index, info] of this.room_posts.entries()) {
      if (info.tick < prune_tick) {
        this.room_posts.delete(index);
      }
    }
    for (const [name, info] of this.local_posts.entries()) {
      if (info.tick < prune_tick) {
        this.local_posts.delete(name);
      }
    }
  }

  private ensure_snapshots(at_tick: number, initial_tick: number): void {
    if (!this.cache_enabled) {
      return;
    }
    if (this.snapshot_start_tick === null) {
      this.snapshot_start_tick = initial_tick;
    }
    if (this.snapshot_start_tick === null) {
      return;
    }
    let start_tick = this.snapshot_start_tick;
    if (this.dirty_from_tick !== null) {
      const dirty = this.dirty_from_tick;
      if (dirty >= start_tick) {
        const keep_until_tick = dirty - 1;
        const keep_index = Math.floor((keep_until_tick - start_tick) / this.snapshot_stride);
        if (keep_index < 0) {
          this.snapshots.length = 0;
        } else if (keep_index < this.snapshots.length - 1) {
          this.snapshots.length = keep_index + 1;
        }
      }
      this.dirty_from_tick = null;
    }

    if (at_tick < start_tick) {
      return;
    }

    const target_index = Math.floor((at_tick - start_tick) / this.snapshot_stride);
    let state: S;
    let current_tick: number;

    if (this.snapshots.length === 0) {
      state = this.init;
      current_tick = start_tick - 1;
    } else {
      state = this.snapshots[this.snapshots.length - 1];
      current_tick = start_tick + (this.snapshots.length - 1) * this.snapshot_stride;
    }

    for (let idx = this.snapshots.length; idx <= target_index; idx++) {
      const next_tick = start_tick + idx * this.snapshot_stride;
      state = this.advance_state(state, current_tick, next_tick);
      this.snapshots.push(state);
      current_tick = next_tick;
    }

    if (this.snapshots.length > this.snapshot_count) {
      const overflow = this.snapshots.length - this.snapshot_count;
      this.snapshots.splice(0, overflow);
      start_tick += overflow * this.snapshot_stride;
    }

    this.snapshot_start_tick = start_tick;
    this.prune_before_tick(start_tick);
  }

  private add_room_post(post: Post<P>): void {
    const tick = this.official_tick(post);
    if (post.index === 0 && this.initial_time_value === null) {
      const t = this.official_time(post);
      this.initial_time_value = t;
      this.initial_tick_value = this.time_to_tick(t);
    }
    if (this.cache_enabled && this.snapshot_start_tick !== null && tick < this.snapshot_start_tick) {
      return;
    }

    const existing = this.room_posts.get(post.index);
    if (existing) {
      this.remove_room_post(existing.post, existing.tick);
      this.room_posts.set(post.index, { post, tick });
      this.insert_room_post(post, tick);
      this.mark_dirty(Math.min(existing.tick, tick));
      return;
    }

    this.room_posts.set(post.index, { post, tick });
    this.insert_room_post(post, tick);
    this.mark_dirty(tick);
  }

  private add_local_post(name: string, post: Post<P>): void {
    if (this.local_posts.has(name)) {
      this.remove_local_post(name);
    }

    const tick = this.official_tick(post);
    if (this.cache_enabled && this.snapshot_start_tick !== null && tick < this.snapshot_start_tick) {
      return;
    }
    this.local_posts.set(name, { post, tick });
    this.get_bucket(tick).local.push(post);
    this.mark_dirty(tick);
  }

  private remove_local_post(name: string): void {
    const info = this.local_posts.get(name);
    if (!info) {
      return;
    }
    this.local_posts.delete(name);

    const bucket = this.timeline.get(info.tick);
    if (bucket) {
      const index = bucket.local.indexOf(info.post);
      if (index !== -1) {
        bucket.local.splice(index, 1);
      } else {
        const by_name = bucket.local.findIndex((p) => p.name === name);
        if (by_name !== -1) {
          bucket.local.splice(by_name, 1);
        }
      }
      if (bucket.room.length === 0 && bucket.local.length === 0) {
        this.timeline.delete(info.tick);
      }
    }

    this.mark_dirty(info.tick);
  }

  private apply_tick(state: S, tick: number): S {
    let next = this.on_tick(state);
    const bucket = this.timeline.get(tick);
    if (bucket) {
      for (const post of bucket.room) {
        next = this.on_post(post.data, next);
      }
      for (const post of bucket.local) {
        next = this.on_post(post.data, next);
      }
    }
    return next;
  }

  private compute_state_at_uncached(initial_tick: number, at_tick: number): S {
    let state = this.init;
    for (let tick = initial_tick; tick <= at_tick; tick++) {
      state = this.apply_tick(state, tick);
    }
    return state;
  }

  constructor(
    room:      string,
    init:      S,
    on_tick:   (state: S) => S,
    on_post:   (post: P, state: S) => S,
    smooth:    (past: S, curr: S) => S,
    tick_rate: number,
    tolerance: number,
    cache:     boolean = true,
    snapshot_stride: number = 8,
    snapshot_count:  number = 256
  ) {
    this.room              = room;
    this.init              = init;
    this.on_tick           = on_tick;
    this.on_post           = on_post;
    this.smooth            = smooth;
    this.tick_rate         = tick_rate;
    this.tolerance         = tolerance;
    this.room_posts        = new Map();
    this.local_posts       = new Map();
    this.timeline          = new Map();
    this.cache_enabled     = cache;
    this.snapshot_stride   = Math.max(1, Math.floor(snapshot_stride));
    this.snapshot_count    = Math.max(1, Math.floor(snapshot_count));
    this.snapshots         = [];
    this.snapshot_start_tick = null;
    this.dirty_from_tick   = null;
    this.initial_time_value = null;
    this.initial_tick_value = null;

    // Wait for initial time sync before interacting with server
    client.on_sync(() => {
      console.log(`[VIBI] synced; watching+loading room=${this.room}`);
      // Watch the room with callback
      client.watch(this.room, (post) => {
        // If this official post matches a local predicted one, drop the local copy
        if (post.name) {
          this.remove_local_post(post.name);
        }
        this.add_room_post(post);
      });

      // Load all existing posts
      client.load(this.room, 0);
    });
  }

  time_to_tick(server_time: number): number {
    return Math.floor((server_time * this.tick_rate) / 1000);
  }

  server_time(): number {
    return client.server_time();
  }

  server_tick(): number {
    return this.time_to_tick(this.server_time());
  }

  // Total official posts loaded for this room
  post_count(): number {
    return this.room_posts.size;
  }

  // Compute a render-ready state by blending authoritative past and current
  // using the provided smooth(past, curr) function.
  compute_render_state(): S {
    const curr_tick  = this.server_tick();
    const tick_ms    = 1000 / this.tick_rate;
    const tol_ticks  = Math.ceil(this.tolerance / tick_ms);
    const rtt_ms     = client.ping();
    const half_rtt   = isFinite(rtt_ms) ? Math.ceil((rtt_ms / 2) / tick_ms) : 0;
    const past_ticks = Math.max(tol_ticks, half_rtt + 1);
    const past_tick  = Math.max(0, curr_tick - past_ticks);

    const past_state = this.compute_state_at(past_tick);
    const curr_state = this.compute_state_at(curr_tick);

    return this.smooth(past_state, curr_state);
  }

  initial_time(): number | null {
    if (this.initial_time_value !== null) {
      return this.initial_time_value;
    }
    const info = this.room_posts.get(0);
    if (!info) {
      return null;
    }
    const t = this.official_time(info.post);
    this.initial_time_value = t;
    this.initial_tick_value = this.time_to_tick(t);
    return t;
  }

  initial_tick(): number | null {
    if (this.initial_tick_value !== null) {
      return this.initial_tick_value;
    }
    const t = this.initial_time();
    if (t === null) {
      return null;
    }
    this.initial_tick_value = this.time_to_tick(t);
    return this.initial_tick_value;
  }

  compute_state_at(at_tick: number): S {
    const initial_tick = this.initial_tick();

    if (initial_tick === null) {
      return this.init;
    }

    if (at_tick < initial_tick) {
      return this.init;
    }

    if (!this.cache_enabled) {
      return this.compute_state_at_uncached(initial_tick, at_tick);
    }

    this.ensure_snapshots(at_tick, initial_tick);

    const start_tick = this.snapshot_start_tick;
    if (start_tick === null || this.snapshots.length === 0) {
      return this.init;
    }

    if (at_tick < start_tick) {
      return this.snapshots[0];
    }

    const stride = this.snapshot_stride;
    const snap_index = Math.floor((at_tick - start_tick) / stride);
    const index = Math.min(snap_index, this.snapshots.length - 1);
    const snap_tick = start_tick + index * stride;
    const base_state = this.snapshots[index];
    return this.advance_state(base_state, snap_tick, at_tick);
  }

  // Post data to the room
  post(data: P): void {
    const name = client.post(this.room, data);
    const t    = this.server_time();

    const local_post: Post<P> = {
      room:        this.room,
      index:       -1,
      server_time: t,
      client_time: t,
      name,
      data
    };

    this.add_local_post(name, local_post);
  }

  compute_current_state(): S {
    return this.compute_state_at(this.server_tick());
  }
}
