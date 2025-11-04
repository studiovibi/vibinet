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
let is_ready = false;
let is_synced = false;
const sync_listeners: Array<() => void> = [];

function now(): number {
  return Math.floor(Date.now());
}

export function server_time(): number {
  // If not synced yet, return local time
  if (!isFinite(time_sync.clock_offset)) {
    throw "no server time yet";
  }
  return Math.floor(now() + time_sync.clock_offset);
}

// Helper to send message (no global queue)
function send(message: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(message);
    return;
  }
  if (ws.readyState === WebSocket.CONNECTING) {
    ws.addEventListener("open", () => ws.send(message), { once: true });
    return;
  }
  throw new Error("WebSocket not open when sending message");
}

// Setup time sync
ws.addEventListener("open", () => {
  console.log("[WS] Connected");
  is_ready = true;

  // Start time sync
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
  send(JSON.stringify({$: "post", room, time: server_time(), data}));
}

export function load(room: string, from: number = 0, handler?: MessageHandler): void {
  if (handler) {
    if (room_watchers.has(room)) {
      throw new Error(`Handler already registered for room: ${room}`);
    }
    room_watchers.set(room, handler);
  }
  send(JSON.stringify({$: "load", room, from}));
}

export function watch(room: string, handler?: MessageHandler): void {
  if (handler) {
    if (room_watchers.has(room)) {
      throw new Error(`Handler already registered for room: ${room}`);
    }
    room_watchers.set(room, handler);
  }
  send(JSON.stringify({$: "watch", room}));
}

export function unwatch(room: string): void {
  room_watchers.delete(room);
  send(JSON.stringify({$: "unwatch", room}));
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
