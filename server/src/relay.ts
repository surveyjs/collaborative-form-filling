import type { Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import {
  ClientToServer,
  MAX_FRAME_BYTES,
  MAX_SET_FRAME_BYTES,
  PRESENCE_BUCKET_CAPACITY,
  PRESENCE_MAX_BYTES,
  PRESENCE_TOKENS_PER_SEC,
  ROOM_ID_RE,
  sanitizeName,
  ServerToClient,
} from "./protocol.js";
import type { Room, RoomStore } from "./roomStore.js";

/**
 * Beyond this many queued bytes a peer's socket is considered congested and an
 * EPHEMERAL frame is skipped for it rather than queued. That is socket.io's
 * `volatile` by hand: every cursor packet is a self-contained path segment, so loss
 * shows only as a gap the receiver's replay glides over — whereas queuing would
 * build a backlog of stale positions.
 */
const RELAY_DROP_BYTES = 64 * 1024;

/** WebSocket-level keepalive: a socket that misses a round trip is terminated. */
const PING_MS = Number(process.env.PRESENCE_PING_MS) || 30_000;

interface AliveSocket extends WebSocket {
  isAlive?: boolean;
}

function send(ws: WebSocket, message: ServerToClient): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(message));
}

/**
 * The relay. It has no SurveyJS dependency and no knowledge of what a question is:
 * it keeps a key -> value map per room, fans out edits, and relays presence
 * envelopes it stamps with identity.
 *
 * Express is not in this path at all — the upgrade is taken straight off the HTTP
 * server — which is what keeps this file portable to any language.
 */
export function attachRelay(httpServer: HttpServer, store: RoomStore): () => void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  const onUpgrade = (req: any, socket: any, head: any) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const match = /^\/ws\/rooms\/([^/]+)$/.exec(url.pathname);
    // Only /ws/rooms/* is claimed. Everything else is left alone rather than
    // destroyed: Vite's HMR sockets live on their own ports precisely because
    // sharing this upgrade channel made the HMR handshake lose the race, and a
    // future change that points HMR back here must not be silently killed.
    if (!match) return;
    const roomId = decodeURIComponent(match[1]);
    if (!ROOM_ID_RE.test(roomId)) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    // A pasted deep link must work, so an unknown room is created here.
    const room = store.getOrCreate(roomId);
    const name = sanitizeName(url.searchParams.get("name"));
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws as AliveSocket, room, name));
  };
  httpServer.on("upgrade", onUpgrade);

  function onConnection(ws: AliveSocket, room: Room, name: string): void {
    const clientId = randomUUID();
    // Registering the client and sending init happen in the same synchronous step,
    // so no broadcast can slip in front of this client's bootstrap.
    store.addClient(room, clientId, ws, name);
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    send(ws, {
      type: "init",
      clientId,
      name,
      colorIndex: store.colorIndexOf(room, clientId),
      seed: room.seed,
      values: store.snapshot(room),
      peers: store.roster(room, clientId),
    });

    let tokens = PRESENCE_BUCKET_CAPACITY;
    let lastRefill = Date.now();

    ws.on("message", (data: any) => {
      const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.length;
      // Guarded BEFORE parse: a 20 MiB JSON.parse is itself the attack.
      if (bytes > MAX_SET_FRAME_BYTES) {
        console.warn(`[relay] dropped a ${bytes}B frame in room ${room.id}`);
        return;
      }
      let msg: ClientToServer;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "value" && typeof msg.key === "string") {
        store.setValue(room, msg.key, msg.value);
        room.clients.forEach((peer, id) => {
          if (id === clientId) return;
          send(peer, { type: "value", from: clientId, key: msg.key, value: (msg as any).value });
        });
        return;
      }

      if (msg.type === "presence" && msg.state !== undefined && msg.state !== null) {
        if (bytes > PRESENCE_MAX_BYTES) return;
        const now = Date.now();
        tokens = Math.min(
          PRESENCE_BUCKET_CAPACITY,
          tokens + ((now - lastRefill) / 1000) * PRESENCE_TOKENS_PER_SEC
        );
        lastRefill = now;
        if (tokens < 1) return;
        tokens -= 1;

        const retain = msg.retain !== false;
        if (retain) store.setPresence(room, clientId, msg.state);
        const entry = {
          clientId,
          name: store.nameOf(room, clientId),
          colorIndex: store.colorIndexOf(room, clientId),
          state: msg.state,
        };
        room.clients.forEach((peer, id) => {
          if (id === clientId) return;
          if (!retain && peer.bufferedAmount > RELAY_DROP_BYTES) return;
          send(peer, { type: "peer", peer: entry, retain });
        });
      }
      // Unknown types are ignored in silence: that is what lets the vocabulary grow.
    });

    let dropped = false;
    const drop = () => {
      if (dropped) return;
      dropped = true;
      store.removeClient(room, clientId);
      room.clients.forEach((peer) => send(peer, { type: "peer-left", clientId }));
    };
    ws.on("close", drop);
    ws.on("error", drop);
  }

  // A browser answers pings at the WebSocket layer even in a throttled background
  // tab, so this detects genuinely dead sockets without falsely dropping an idle
  // observer — which a JS-timer staleness sweep on the client would do.
  const keepAlive = setInterval(() => {
    wss.clients.forEach((client) => {
      const ws = client as AliveSocket;
      if (ws.isAlive === false) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, PING_MS);

  return () => {
    clearInterval(keepAlive);
    httpServer.off("upgrade", onUpgrade);
    wss.close();
  };
}
