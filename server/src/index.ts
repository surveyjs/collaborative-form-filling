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
import { RoomManager } from "./RoomManager.js";

/** URL-safe room ids (they become a path/query segment and a socket room). */
const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

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
});

const rooms = new RoomManager();

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

httpServer.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});

export { io, httpServer, rooms };
