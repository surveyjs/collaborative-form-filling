import type { Express } from "express";
import { ICreateRoomRequest, IRoomInfo, ROOM_ID_RE } from "./protocol.js";
import type { RoomStore } from "./roomStore.js";

/**
 * The room REST surface, lifted out of index.ts so it can be tested without
 * booting Vite and binding a port.
 *
 * The response shapes are a compatibility contract with the lobby: it drives the
 * "join vs create" hint and the conditional schema block off `exists` and
 * `participantCount`.
 */
export function createHttpRooms(app: Express, store: RoomStore): void {
  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Room lookup, used by the lobby to tell "join" from "create" while the user
  // types a room id.
  app.get("/api/rooms/:id", (req, res) => {
    const id = req.params.id;
    if (!ROOM_ID_RE.test(id)) {
      res.status(400).json({ error: "invalid room id" });
      return;
    }
    const room = store.get(id);
    if (!room) {
      res.status(404).json({ exists: false });
      return;
    }
    const info: IRoomInfo = { roomId: id, exists: true, participantCount: room.clients.size };
    res.json(info);
  });

  // Room creation, used by the lobby when the creator supplies a custom schema.
  // Clients themselves join by room id only, over the socket.
  app.post("/api/rooms", (req, res) => {
    const body = (req.body ?? {}) as Partial<ICreateRoomRequest>;
    if (typeof body.roomId !== "string" || !ROOM_ID_RE.test(body.roomId)) {
      res.status(400).json({ error: "invalid room id" });
      return;
    }
    // The only thing the server checks about a schema is that it is a plain
    // object. It is never parsed, validated or executed here.
    if (
      body.surveyJson !== undefined &&
      (typeof body.surveyJson !== "object" || body.surveyJson === null || Array.isArray(body.surveyJson))
    ) {
      res.status(400).json({ error: "invalid survey schema" });
      return;
    }
    if (store.get(body.roomId)) {
      // A room's schema is fixed at creation time.
      res.status(409).json({ error: "room already exists", roomId: body.roomId });
      return;
    }
    store.create(body.roomId, body.surveyJson);
    res.status(201).json({ roomId: body.roomId });
  });
}
