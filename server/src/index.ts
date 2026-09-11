import { createServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Server } from "socket.io";
import type { PluginOption } from "vite";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "../../shared/events.js";
import { ROOM_ID_RE, RoomManager } from "./RoomManager.js";
import { FileStore } from "./FileStore.js";
import { createFileRoutes } from "./fileRoutes.js";

/**
 * Ceiling on one question's value, mirroring the client guard in
 * shared/sync.ts (MAX_VALUE_CHARS) — keep the two in sync. A client that does
 * not run that guard (an older build, someone else's client) must not be able
 * to park an oversized answer in a room or have it rebroadcast to everyone.
 *
 * Sized for a file question left on survey-core's `storeDataAsText: true`,
 * where the file's bytes ARE the value: 10 MiB of file becomes ~13.4 MiB of
 * base64 (x4/3) plus the data-URL prefix and the JSON wrapper. The three
 * limits form one chain and must keep their order:
 *
 *   MAX_FILE_BYTES x 4/3  <  MAX_VALUE_CHARS  <  maxHttpBufferSize
 *         13.4 MiB        <      16 MiB       <      20 MiB
 */
const MAX_VALUE_CHARS = 16 * 1024 * 1024;

const PORT = Number(process.env.PORT) || 3001;
const isProd = process.env.NODE_ENV === "production";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In dev __dirname = server/src, in prod = server/dist.
// Either way ../.. is the repo root (which holds clients/, lobby/, shared/).
const repoRoot = path.resolve(__dirname, "../..");

// Framework clients, mounted at /<prefix>/ (the lobby lives at /). The lobby
// navigates to `/<prefix>/?room=<id>&name=<name>` after the join form.
// Vite-based apps run as middleware in dev; Angular (its own CLI dev server)
// is always served from its built dist.
const VITE_CLIENTS = [
  { prefix: "react", root: path.join(repoRoot, "clients", "react") },
  { prefix: "js", root: path.join(repoRoot, "clients", "js") },
  { prefix: "vue", root: path.join(repoRoot, "clients", "vue") },
] as const;
const ANGULAR_ROOT = path.join(repoRoot, "clients", "angular");
const LOBBY_ROOT = path.join(repoRoot, "lobby");

const app = express();
app.use(express.json());
app.get("/health", (_req, res) => res.json({ ok: true }));

// Room lookup, used by the lobby to tell "join" from "create" while the user
// types a room id (drives the conditional schema block and the hint text).
app.get("/api/rooms/:id", (req, res) => {
  const id = req.params.id;
  if (!ROOM_ID_RE.test(id)) {
    res.status(400).json({ error: "invalid room id" });
    return;
  }
  const room = rooms.get(id);
  if (!room) {
    res.status(404).json({ exists: false });
    return;
  }
  res.json({ roomId: id, exists: true, participantCount: room.participants.size });
});

// Room creation API, used by the lobby when the creator supplies a custom
// schema (clients themselves join by room id only, over the socket).
app.post("/api/rooms", (req, res) => {
  const body = (req.body ?? {}) as { roomId?: unknown; surveyJson?: unknown };
  if (typeof body.roomId !== "string" || !ROOM_ID_RE.test(body.roomId)) {
    res.status(400).json({ error: "invalid room id" });
    return;
  }
  if (
    body.surveyJson !== undefined &&
    (typeof body.surveyJson !== "object" || body.surveyJson === null || Array.isArray(body.surveyJson))
  ) {
    res.status(400).json({ error: "invalid survey schema" });
    return;
  }
  if (rooms.get(body.roomId)) {
    // The schema of an existing room is fixed at creation time.
    res.status(409).json({ error: "room already exists", roomId: body.roomId });
    return;
  }
  rooms.getOrCreate(body.roomId, body.surveyJson as object | undefined);
  res.status(201).json({ roomId: body.roomId });
});

const httpServer = createServer(app);
interface SocketData {
  roomId?: string;
}

const io = new Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>(httpServer, {
  cors: { origin: "*" },
  // engine.io defaults to 1e6 bytes and enforces it by refusing the oversized
  // frame and closing the connection (ws code 1009) — a dropped socket with
  // nothing said. A file question on `storeDataAsText: true` puts the file's
  // own base64 in the value, so this has to clear MAX_VALUE_CHARS plus packet
  // framing (see the chain documented above it). The MVP has no auth, so every
  // extra megabyte is memory any client can make the server hold — this is the
  // ceiling of that exposure, not a free parameter.
  maxHttpBufferSize: 20 * 1024 * 1024,
});

const rooms = new RoomManager();
const files = new FileStore();
createFileRoutes(app, rooms, files);

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, name, surveyJson }) => {
    const participant = rooms.join(roomId, socket.id, name, surveyJson);
    socket.join(roomId);
    socket.data.roomId = roomId;

    const room = rooms.getOrCreate(roomId);
    socket.emit("room-state", {
      surveyJson: room.surveyJson,
      data: room.data,
      selfId: socket.id,
      participants: rooms.listParticipants(roomId),
    });
    socket.to(roomId).emit("participant-joined", { participant });
  });

  socket.on("value-changed", ({ roomId, name, value }) => {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined && serialized.length > MAX_VALUE_CHARS) {
      console.warn(`[server] dropped an oversized value for "${name}" in room ${roomId}`);
      return;
    }
    rooms.setValue(roomId, name, value);
    socket.to(roomId).emit("value-changed", { roomId, name, value });
  });

  socket.on("focus-question", ({ roomId, name }) => {
    rooms.setFocus(roomId, socket.id, name);
    socket.to(roomId).emit("focus-question", { id: socket.id, name });
  });

  socket.on("page-changed", ({ roomId, name }) => {
    rooms.setPage(roomId, socket.id, name);
    socket.to(roomId).emit("page-changed", { id: socket.id, name });
  });

  // Cursor paths are ephemeral: relayed but never stored, and sent as
  // volatile so packets are dropped (not queued) for congested clients —
  // every packet is a self-contained path segment, so loss shows only as a
  // small gap the receiver's replay glides over.
  socket.on("cursor-moved", ({ roomId, name, points }) => {
    socket.to(roomId).volatile.emit("cursor-moved", { id: socket.id, name, points });
  });

  socket.on("disconnect", () => {
    const left = rooms.leave(socket.id);
    if (left) {
      socket.to(left.roomId).emit("participant-left", { id: socket.id });
      // `leave` returns the roomId whether or not it pruned the room, so ask
      // whether the room is still there rather than widening its signature —
      // socket.test.ts mirrors this wiring and would drift otherwise.
      if (!rooms.get(left.roomId)) {
        files
          .deleteRoom(left.roomId)
          .catch((error) => console.warn("[files] failed to clean up a room", error));
      }
    }
  });
});

/** Static mount with an SPA fallback onto the app's index.html. */
function mountDist(prefix: string, dist: string): boolean {
  if (!existsSync(path.join(dist, "index.html"))) return false;
  app.use(prefix, express.static(dist));
  app.get(`${prefix}/*`, (_req, res) => res.sendFile(path.join(dist, "index.html")));
  return true;
}

// Serve everything on this single port. Prod: built dists. Dev: Vite in
// middleware mode per app. Each instance gets its OWN HMR websocket port:
// sharing this httpServer's 'upgrade' channel between several Vite instances
// and Socket.IO makes the HMR handshake lose the race, and vite's client then
// reloads the page in an endless loop.
if (isProd) {
  for (const { prefix, root } of VITE_CLIENTS) {
    if (!mountDist(`/${prefix}`, path.join(root, "dist"))) {
      console.warn(`[server] /${prefix} not mounted — build ${path.basename(root)} first`);
    }
  }
} else {
  const { createServer: createViteServer } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react");
  const { default: vue } = await import("@vitejs/plugin-vue");
  const pluginsByPrefix: Record<string, () => PluginOption[]> = {
    react: () => [react()],
    js: () => [],
    vue: () => [vue()],
  };
  // In-repo file: deps are junctions into the survey-library fork — their real
  // paths live outside each app root, so allow the whole parent directory.
  const fsAllow = [path.resolve(repoRoot, "..")];
  // configFile: false is deliberate: loading each app's vite.config.ts writes
  // a compiled temp file into node_modules/.vite-temp, which tsx watch sees
  // and restarts the server — an infinite loop with several Vite instances.
  // The dev config is therefore inlined here; vite build still uses the
  // config files inside each package.
  const createMiddleware = async (root: string, base: string, plugins: PluginOption[], hmrPort: number) => {
    const vite = await createViteServer({
      root,
      configFile: false,
      appType: "spa",
      base,
      plugins,
      // NOTE: react/react-dom are deliberately NOT deduped. The fork's
      // survey-react-ui build runs against its own React 17 copy (matching its
      // build), while the app renders with React 18 — deduping them onto one
      // React 18 instance makes dropdown popups toggle open+closed per click.
      resolve: { dedupe: ["survey-core", "survey-react-ui", "survey-js-ui", "survey-vue3-ui", "vue"] },
      server: {
        middlewareMode: true,
        fs: { allow: fsAllow },
        hmr: { port: hmrPort },
      },
    });
    // Vite's middleware answers ANY request (its SPA fallback ignores `base`),
    // so an unguarded instance would shadow the lobby and the other clients.
    // Only hand it requests under its own prefix.
    app.use((req, res, next) => {
      if (req.url === base.slice(0, -1) || req.url.startsWith(base)) {
        vite.middlewares(req, res, next);
      } else {
        next();
      }
    });
  };
  let hmrPort = 24700;
  for (const { prefix, root } of VITE_CLIENTS) {
    if (!existsSync(root)) continue;
    await createMiddleware(root, `/${prefix}/`, pluginsByPrefix[prefix](), hmrPort++);
  }
}

// Angular has no Vite middleware mode — its dist is served statically in both
// modes (rebuild with `npm run build:angular` to refresh).
const angularDists = [path.join(ANGULAR_ROOT, "dist", "browser"), path.join(ANGULAR_ROOT, "dist")];
if (!angularDists.some((dist) => mountDist("/angular", dist))) {
  console.warn("[server] /angular not mounted — build client-angular first");
}

// The lobby owns "/" and must be mounted last: its SPA fallback would shadow
// the client prefixes above.
if (isProd) {
  if (!mountDist("", path.join(LOBBY_ROOT, "dist"))) {
    console.warn("[server] lobby dist missing — build lobby first");
  }
} else {
  const { createServer: createViteServer } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react");
  const vite = await createViteServer({
    root: LOBBY_ROOT,
    configFile: false, // see the note on the client middlewares above
    appType: "spa",
    base: "/",
    plugins: [react()],
    resolve: { dedupe: ["survey-core", "survey-react-ui"] },
    server: {
      middlewareMode: true,
      fs: { allow: [path.resolve(repoRoot, "..")] },
      hmr: { port: 24699 },
    },
  });
  app.use(vite.middlewares);
}

// Clears anything a previous run left behind before the first request lands.
await files.init();

httpServer.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});

export { io, httpServer, rooms, files };
