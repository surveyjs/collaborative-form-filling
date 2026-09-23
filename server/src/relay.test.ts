import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { attachRelay } from "./relay.js";
import { RoomStore } from "./roomStore.js";
import { MAX_SET_FRAME_BYTES } from "./protocol.js";

let httpServer: HttpServer;
let store: RoomStore;
let detach: () => void;
let port: number;
const sockets: WebSocket[] = [];

const deleted: string[] = [];

beforeEach(async () => {
  deleted.length = 0;
  httpServer = createServer();
  store = new RoomStore({
    defaultSeed: { pages: [{ name: "p1" }] },
    // Zero here on purpose: these tests are about the prune itself, not about the
    // grace period that protects a room from a blink of a reconnect.
    emptyRoomTtlMs: 0,
    onRoomDeleted: (id) => deleted.push(id),
  });
  detach = attachRelay(httpServer, store);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  port = (httpServer.address() as AddressInfo).port;
});

afterEach(async () => {
  sockets.splice(0).forEach((ws) => ws.close());
  detach();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

/** Connects and resolves with the socket plus its `init` frame. */
function connect(roomId: string, name = "Tester"): Promise<{ ws: WebSocket; init: any }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/rooms/${roomId}?name=${encodeURIComponent(name)}`);
  sockets.push(ws);
  return new Promise((resolve, reject) => {
    ws.once("error", reject);
    ws.once("message", (data) => resolve({ ws, init: JSON.parse(data.toString()) }));
  });
}

/** Resolves with the next frame of the given type, or rejects on timeout. */
function next(ws: WebSocket, type: string, timeoutMs = 1000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`no "${type}" frame within ${timeoutMs}ms`));
    }, timeoutMs);
    const onMessage = (data: any) => {
      const msg = JSON.parse(data.toString());
      if (msg.type !== type) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(msg);
    };
    ws.on("message", onMessage);
  });
}

/** Asserts no frame of the given type arrives within the window. */
async function silentFor(ws: WebSocket, type: string, ms = 150): Promise<void> {
  let seen = false;
  const onMessage = (data: any) => {
    if (JSON.parse(data.toString()).type === type) seen = true;
  };
  ws.on("message", onMessage);
  await new Promise((resolve) => setTimeout(resolve, ms));
  ws.off("message", onMessage);
  expect(seen).toBe(false);
}

describe("relay bootstrap", () => {
  it("sends init with identity, seed, values and roster", async () => {
    const { init } = await connect("demo");
    expect(init.type).toBe("init");
    expect(typeof init.clientId).toBe("string");
    expect(init.name).toBe("Tester");
    // A slot number, never a colour: the palette belongs to the client theme.
    expect(init.colorIndex).toBeGreaterThanOrEqual(1);
    expect(init.colorIndex).toBeLessThanOrEqual(9);
    expect(init.seed).toEqual({ pages: [{ name: "p1" }] });
    expect(init.values).toEqual({});
    expect(init.peers).toEqual([]);
  });

  it("auto-creates an unknown room so a pasted deep link works", async () => {
    expect(store.get("fresh")).toBeUndefined();
    await connect("fresh");
    expect(store.get("fresh")).toBeDefined();
  });

  it("an empty name becomes the default", async () => {
    const { init } = await connect("demo", "   ");
    expect(init.name).toBe("Anonymous");
  });

  it("a late joiner receives the state accumulated so far", async () => {
    const a = await connect("demo", "Alice");
    a.ws.send(JSON.stringify({ type: "value", key: "q1", value: "filled" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const b = await connect("demo", "Bob");
    expect(b.init.values).toEqual({ q1: "filled" });
  });

  it("two clients in one room get different colour slots", async () => {
    const a = await connect("demo", "Alice");
    const b = await connect("demo", "Bob");
    expect(a.init.colorIndex).not.toBe(b.init.colorIndex);
  });

  it("an invalid room id is refused", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/rooms/${encodeURIComponent("bad id!")}`);
    sockets.push(ws);
    await expect(new Promise((_resolve, reject) => ws.once("error", reject))).rejects.toThrow();
  });
});

describe("relay values", () => {
  it("relays an edit to the others and never echoes it to the author", async () => {
    const a = await connect("demo", "Alice");
    const b = await connect("demo", "Bob");
    a.ws.send(JSON.stringify({ type: "value", key: "q1", value: 42 }));
    const got = await next(b.ws, "value");
    expect(got).toMatchObject({ type: "value", key: "q1", value: 42, from: a.init.clientId });
    await silentFor(a.ws, "value");
  });

  it("rooms are isolated", async () => {
    const a = await connect("room-a");
    const b = await connect("room-b");
    a.ws.send(JSON.stringify({ type: "value", key: "q1", value: "x" }));
    await silentFor(b.ws, "value");
  });

  it("an oversized frame is dropped, not stored, and the socket survives", async () => {
    const a = await connect("demo", "Alice");
    const b = await connect("demo", "Bob");
    const huge = "x".repeat(MAX_SET_FRAME_BYTES + 10);
    a.ws.send(JSON.stringify({ type: "value", key: "big", value: huge }));
    await silentFor(b.ws, "value", 250);
    expect(store.get("demo")!.values.has("big")).toBe(false);
    // The connection is still usable: refusing the value is recoverable, closing is not.
    a.ws.send(JSON.stringify({ type: "value", key: "small", value: 1 }));
    await expect(next(b.ws, "value")).resolves.toMatchObject({ key: "small" });
  });

  it("malformed JSON is ignored", async () => {
    const a = await connect("demo");
    const b = await connect("demo");
    a.ws.send("not json at all");
    await silentFor(b.ws, "value");
    a.ws.send(JSON.stringify({ type: "value", key: "ok", value: 1 }));
    await expect(next(b.ws, "value")).resolves.toMatchObject({ key: "ok" });
  });

  it("an unknown message type is ignored", async () => {
    const a = await connect("demo");
    const b = await connect("demo");
    a.ws.send(JSON.stringify({ type: "something-new", payload: 1 }));
    await silentFor(b.ws, "value");
  });
});

describe("relay presence", () => {
  it("a retained state is stored and replayed to a newcomer", async () => {
    const a = await connect("demo", "Alice");
    a.ws.send(JSON.stringify({ type: "presence", state: { focus: "q1" }, retain: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const b = await connect("demo", "Bob");
    expect(b.init.peers).toHaveLength(1);
    expect(b.init.peers[0]).toMatchObject({
      clientId: a.init.clientId,
      name: "Alice",
      state: { focus: "q1" },
    });
  });

  it("an ephemeral state is relayed but never replayed", async () => {
    const a = await connect("demo", "Alice");
    const b = await connect("demo", "Bob");
    a.ws.send(JSON.stringify({ type: "presence", state: { cur: [1, 2] }, retain: false }));
    const peer = await next(b.ws, "peer");
    expect(peer.retain).toBe(false);
    expect(peer.peer.state).toEqual({ cur: [1, 2] });

    const c = await connect("demo", "Carol");
    expect(c.init.peers.some((p: any) => p.clientId === a.init.clientId)).toBe(false);
  });

  it("the server stamps identity onto the relayed envelope", async () => {
    const a = await connect("demo", "Alice");
    const b = await connect("demo", "Bob");
    // The client never sends its own name or colour - they are not in the state.
    a.ws.send(JSON.stringify({ type: "presence", state: { focus: "q1" } }));
    const peer = await next(b.ws, "peer");
    expect(peer.peer.name).toBe("Alice");
    expect(peer.peer.colorIndex).toBe(a.init.colorIndex);
  });

  it("an oversized presence frame is dropped in silence", async () => {
    const a = await connect("demo");
    const b = await connect("demo");
    a.ws.send(JSON.stringify({ type: "presence", state: { pad: "x".repeat(8000) } }));
    await silentFor(b.ws, "peer", 250);
  });

  it("a disconnect tells the others", async () => {
    const a = await connect("demo", "Alice");
    const b = await connect("demo", "Bob");
    const left = next(b.ws, "peer-left");
    a.ws.close();
    await expect(left).resolves.toMatchObject({ clientId: a.init.clientId });
  });
});

describe("relay room lifecycle", () => {
  it("an emptied room is reclaimed and its files are dropped", async () => {
    const a = await connect("demo");
    expect(store.get("demo")).toBeDefined();
    a.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(store.get("demo")).toBeUndefined();
    expect(deleted).toContain("demo");
  });

  it("a leaver's colour slot is reusable", async () => {
    const a = await connect("demo", "Alice");
    const b = await connect("demo", "Bob");
    const bSlot = b.init.colorIndex;
    b.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const c = await connect("demo", "Carol");
    expect(c.init.colorIndex).toBe(bSlot);
    expect(c.init.colorIndex).not.toBe(a.init.colorIndex);
  });
});
