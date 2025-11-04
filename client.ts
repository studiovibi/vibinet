type TimeSync = {
  clock_offset: number;     // difference between server clock and local clock
  lowest_ping: number;      // best round-trip time achieved so far
  request_sent_at: number;  // timestamp when last get_time request was sent
};

const time_sync: TimeSync = {
  clock_offset: Infinity,
  lowest_ping: Infinity,
  request_sent_at: 0
};

// Auto-detect server hostname (works for both localhost and remote)
const ws = new WebSocket(`ws://${window.location.hostname}:8080`);

// Room watchers with callbacks
type MessageHandler = (message: any) => void;
const room_watchers = new Map<string, MessageHandler>();

// Connection + time sync state
let is_synced = false;
const sync_listeners: Array<() => void> = [];

function now(): number {
  return Math.floor(Date.now());
}

export function server_time(): number {
  if (!isFinite(time_sync.clock_offset)) {
    throw new Error("server_time() called before initial sync");
  }
  return Math.floor(now() + time_sync.clock_offset);
}

// Setup time sync
ws.addEventListener("open", () => {
  console.log("[WS] Connected");
  // Immediate time sync request to reduce wait
  time_sync.request_sent_at = now();
  ws.send(JSON.stringify({ $: "get_time" }));
  // Periodic sync every 2s
  setInterval(() => {
    time_sync.request_sent_at = now();
    ws.send(JSON.stringify({ $: "get_time" }));
  }, 2000);
});

ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);

  switch (message.$) {
    case "info_time": {
      const time = now();
      const ping = time - time_sync.request_sent_at;
      if (ping < time_sync.lowest_ping) {
        const local_avg_time   = Math.floor((time_sync.request_sent_at + time) / 2);
        time_sync.clock_offset = message.time - local_avg_time;
        time_sync.lowest_ping  = ping;
      }
      if (!is_synced) {
        is_synced = true;
        for (const cb of sync_listeners) cb();
        sync_listeners.length = 0;
      }
      break;
    }
    case "info_post": {
      // Notify room-specific handler
      const handler = room_watchers.get(message.room);
      if (handler) {
        handler(message);
      }
      break;
    }
  }
});

// API Functions

export function post(room: string, data: any): void {
  if (ws.readyState !== WebSocket.OPEN) throw new Error("ws not open in post()");
  ws.send(JSON.stringify({$: "post", room, time: server_time(), data}));
}

export function load(room: string, from: number = 0, handler?: MessageHandler): void {
  if (handler) {
    if (room_watchers.has(room)) {
      throw new Error(`Handler already registered for room: ${room}`);
    }
    room_watchers.set(room, handler);
  }
  if (ws.readyState !== WebSocket.OPEN) throw new Error("ws not open in load()");
  ws.send(JSON.stringify({$: "load", room, from}));
}

export function watch(room: string, handler?: MessageHandler): void {
  if (handler) {
    if (room_watchers.has(room)) {
      throw new Error(`Handler already registered for room: ${room}`);
    }
    room_watchers.set(room, handler);
  }
  if (ws.readyState !== WebSocket.OPEN) throw new Error("ws not open in watch()");
  ws.send(JSON.stringify({$: "watch", room}));
}

export function unwatch(room: string): void {
  room_watchers.delete(room);
  if (ws.readyState !== WebSocket.OPEN) throw new Error("ws not open in unwatch()");
  ws.send(JSON.stringify({$: "unwatch", room}));
}

export function close(): void {
  ws.close();
}

// Register a callback that fires once, on first successful time sync
export function on_sync(callback: () => void): void {
  if (is_synced) {
    callback();
    return;
  }
  sync_listeners.push(callback);
}
