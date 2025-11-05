import { WebSocketServer, WebSocket } from "ws";
import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import http from "http";
import { readFile } from "fs/promises";

// Build walkers bundle on startup (idempotent)
async function build_walkers() {
  try {
    // Generate version label from commit count
    let version = "V0";
    try {
      const rev = Bun.spawnSync({ cmd: ["git", "rev-list", "--count", "HEAD"] });
      if (rev.success) {
        const n = parseInt(new TextDecoder().decode(rev.stdout).trim() || "0", 10);
        if (!Number.isNaN(n)) version = `V${n}`;
      }
    } catch {}
    try { writeFileSync("walkers/version.ts", `export const VERSION_LABEL = "${version}";\n`); } catch {}

    const r1 = Bun.spawnSync({ cmd: ["bun", "build", "src/client.ts", "--outdir", "walkers/dist", "--target=browser", "--format=esm"] });
    const r2 = Bun.spawnSync({ cmd: ["bun", "build", "src/vibi.ts", "--outdir", "walkers/dist", "--target=browser", "--format=esm"] });
    const r3 = Bun.spawnSync({ cmd: ["bun", "build", "walkers/version.ts", "--outdir", "walkers/dist", "--target=browser", "--format=esm"] });
    const r4 = Bun.spawnSync({ cmd: ["bun", "build", "walkers/index.ts", "--outdir", "walkers/dist", "--target=browser", "--format=esm"] });
    if (!r1.success || !r2.success || !r3.success || !r4.success) {
      console.error("[BUILD] walkers build failed", { r1: r1.success, r2: r2.success, r3: r3.success, r4: r4.success });
    } else {
      console.log("[BUILD] walkers bundle ready");
    }
  } catch (e) {
    console.error("[BUILD] error while building walkers:", e);
  }
}

await build_walkers();

// Simple static server + WebSocket on the same port
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    let path = url.pathname;
    if (path === "/") path = "/index.html";

    let filesystem_path: string;
    filesystem_path = path.startsWith("/dist/") ? `walkers${path}` : `walkers${path}`;

    const ct = path.endsWith(".html") ? "text/html" :
               path.endsWith(".js")   ? "application/javascript" :
               path.endsWith(".css")  ? "text/css" :
               path.endsWith(".map")  ? "application/json" :
               "application/octet-stream";

    const data = await readFile(filesystem_path);
    res.writeHead(200, { "Content-Type": ct });
    res.end(data);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

const wss = new WebSocketServer({ server });

function now(): number {
  return Math.floor(Date.now());
}

const watchers = new Map<string, Set<WebSocket>>();

setInterval(() => { console.log("Server time:", now()); }, 1000);

if (!existsSync("./db")) mkdirSync("./db");

wss.on("connection", (ws) => {
  ws.on("message", (buffer) => {
    const message = JSON.parse(buffer.toString());
    switch (message.$) {
      case "get_time":
        ws.send(JSON.stringify({ $: "info_time", time: now() }));
        break;
      case "post": {
        const server_time = now();
        const client_time = Math.floor(message.time);
        const room        = message.room;
        const name        = message.name;
        const data        = message.data;
        const path        = `./db/${room}.jsonl`;
        let index = 0;
        if (existsSync(path)) {
          const content = readFileSync(path, "utf-8");
          const lines   = content.trim().split("\n").filter(l => l.trim());
          index = lines.length;
        }
        const file_line = JSON.stringify({ server_time, client_time, name, data });
        appendFileSync(path, file_line + "\n");
        console.log("Post received:", { room, data });
        const room_watchers = watchers.get(room);
        if (room_watchers) {
          const info = { $: "info_post", room, index, server_time, client_time, name, data };
          const json = JSON.stringify(info);
          for (const watcher of room_watchers) watcher.send(json);
        }
        break;
      }
      case "load": {
        const room = message.room;
        const from = Math.max(0, message.from || 0);
        const path = `./db/${room}.jsonl`;
        if (existsSync(path)) {
          const content = readFileSync(path, "utf-8");
          const lines   = content.trim().split("\n");
          for (let index = from; index < lines.length; index++) {
            const line = lines[index];
            if (line && line.trim()) {
              const record      = JSON.parse(line);
              const server_time = record.server_time;
              const client_time = record.client_time;
              const name        = record.name;
              const data        = record.data;
              const msg         = { $: "info_post", room, index, server_time, client_time, name, data };
              ws.send(JSON.stringify(msg));
            }
          }
        }
        break;
      }
      case "watch": {
        const room = message.room;
        if (!watchers.has(room)) watchers.set(room, new Set());
        watchers.get(room)!.add(ws);
        console.log("Watching:", { room });
        break;
      }
      case "unwatch": {
        const room = message.room;
        const set = watchers.get(room);
        if (set) { set.delete(ws); if (set.size === 0) watchers.delete(room); }
        console.log("Unwatching:", { room });
        break;
      }
    }
  });

  ws.on("close", () => {
    for (const [room, set] of watchers.entries()) {
      set.delete(ws);
      if (set.size === 0) watchers.delete(room);
    }
  });
});

server.listen(8080, () => {
  console.log("Server running at http://localhost:8080 (HTTP + WebSocket)");
});

