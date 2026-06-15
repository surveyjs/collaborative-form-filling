import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Server } from "socket.io";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "../../shared/events.js";
import { RoomManager } from "./RoomManager.js";

const PORT = Number(process.env.PORT) || 3001;
const isProd = process.env.NODE_ENV === "production";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In dev __dirname = packages/server/src, in prod = packages/server/dist.
// Either way ../../client points at the client package.
const clientRoot = path.resolve(__dirname, "../../client");

const app = express();
app.get("/health", (_req, res) => res.json({ ok: true }));

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
    socket.to(roomId).emit("focus-question", { id: socket.id, name });
  });

  socket.on("disconnect", () => {
    const left = rooms.leave(socket.id);
    if (left) {
      socket.to(left.roomId).emit("participant-left", { id: socket.id });
    }
  });
});

// Serve the client on the same port: built static assets in prod, the Vite
// dev server (with HMR over this same httpServer) in dev.
if (isProd) {
  const dist = path.resolve(clientRoot, "dist");
  app.use(express.static(dist));
  // SPA fallback for client-side routing.
  app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
} else {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    root: clientRoot,
    appType: "spa",
    server: {
      middlewareMode: true,
      // Run Vite's HMR websocket over our httpServer so everything stays on
      // a single port. Socket.IO (path /socket.io) and Vite HMR coexist on
      // the same 'upgrade' channel since they match on distinct paths.
      hmr: { server: httpServer },
    },
  });
  app.use(vite.middlewares);
}

httpServer.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});

export { io, httpServer, rooms };
