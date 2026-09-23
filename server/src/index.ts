import { createServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { PluginOption } from "vite";
import { FileStore } from "./FileStore.js";
import { createFileRoutes } from "./fileRoutes.js";
import { defaultSurvey } from "./defaultSurvey.js";
import { RoomStore } from "./roomStore.js";
import { createHttpRooms } from "./httpRooms.js";
import { attachRelay } from "./relay.js";
import { localSurvey } from "./localSurvey.js";

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
const httpServer = createServer(app);

const files = new FileStore();
const store = new RoomStore({
  defaultSeed: defaultSurvey,
  emptyRoomTtlMs: process.env.EMPTY_ROOM_TTL_MS !== undefined
    ? Number(process.env.EMPTY_ROOM_TTL_MS)
    : undefined,
  onRoomDeleted: (id) =>
    files.deleteRoom(id).catch((error) => console.warn("[files] failed to clean up a room", error)),
});
createHttpRooms(app, store);
createFileRoutes(app, (roomId) => !!store.get(roomId), files);
attachRelay(httpServer, store);

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
  // Dev resolves the survey packages from the sibling survey-library checkout
  // (see localSurvey.ts); vite build and prod use the npm versions.
  const survey = localSurvey();
  const pluginsByPrefix: Record<string, () => PluginOption[]> = {
    react: () => [survey, react()],
    js: () => [survey],
    vue: () => [survey, vue()],
  };
  // The checkout's build lives outside each app root, so allow the whole
  // parent directory.
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
    plugins: [localSurvey(), react()],
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

export { httpServer, store, files };
