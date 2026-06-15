import { createServer, type Server as HttpServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Server } from "socket.io";
import { io as ioc, type Socket as ClientSocket } from "socket.io-client";
import type {
  ClientToServerEvents,
  RoomStatePayload,
  ServerToClientEvents,
  ValueChangedPayload,
} from "../../shared/events.js";
import { RoomManager } from "./RoomManager.js";

/** Spins up a real Socket.IO server wired to RoomManager, mirroring index.ts. */
function startServer(): Promise<{ http: HttpServer; port: number }> {
  const http = createServer();
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(http, {
    cors: { origin: "*" },
  });
  const rooms = new RoomManager();

  io.on("connection", (socket) => {
    socket.on("join-room", ({ roomId, name }) => {
      const participant = rooms.join(roomId, socket.id, name);
      socket.join(roomId);
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
    socket.on("disconnect", () => {
      const left = rooms.leave(socket.id);
      if (left) socket.to(left.roomId).emit("participant-left", { id: socket.id });
    });
  });

  return new Promise((resolve) => {
    http.listen(0, () => {
      const port = (http.address() as { port: number }).port;
      resolve({ http, port });
    });
  });
}

function connect(port: number): ClientSocket {
  return ioc(`http://localhost:${port}`, { transports: ["websocket"], forceNew: true });
}

function once<T>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, resolve as (...args: unknown[]) => void));
}

describe("socket handlers", () => {
  let http: HttpServer;
  let port: number;

  beforeEach(async () => {
    ({ http, port } = await startServer());
  });

  afterEach(() => {
    http.close();
  });

  it("returns room-state to the joiner", async () => {
    const a = connect(port);
    a.emit("join-room", { roomId: "r1", name: "Alice" });
    const state = await once<RoomStatePayload>(a, "room-state");
    expect(state.surveyJson).toBeDefined();
    expect(state.participants).toHaveLength(1);
    expect(state.selfId).toBeTruthy();
    a.close();
  });

  it("broadcasts value-changed to others but not back to sender", async () => {
    const a = connect(port);
    const b = connect(port);

    a.emit("join-room", { roomId: "r1", name: "Alice" });
    await once(a, "room-state");
    b.emit("join-room", { roomId: "r1", name: "Bob" });
    await once(b, "room-state");

    // Sender must NOT receive its own echo.
    let echoed = false;
    a.on("value-changed", () => {
      echoed = true;
    });

    const received = once<ValueChangedPayload>(b, "value-changed");
    a.emit("value-changed", { roomId: "r1", name: "projectName", value: "Apollo" });

    const payload = await received;
    expect(payload).toMatchObject({ name: "projectName", value: "Apollo" });
    expect(echoed).toBe(false);

    a.close();
    b.close();
  });

  it("notifies others when a participant leaves", async () => {
    const a = connect(port);
    const b = connect(port);
    a.emit("join-room", { roomId: "r1", name: "Alice" });
    await once(a, "room-state");
    b.emit("join-room", { roomId: "r1", name: "Bob" });
    await once(b, "room-state");

    const left = once<{ id: string }>(a, "participant-left");
    b.close();
    const payload = await left;
    expect(payload.id).toBeTruthy();

    a.close();
  });
});
