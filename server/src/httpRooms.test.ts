import { createServer, type Server as HttpServer } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpRooms } from "./httpRooms.js";
import { RoomStore } from "./roomStore.js";

/**
 * These endpoints used to live inside index.ts, which boots Vite and binds a port -
 * so they could not be tested at all. They are a compatibility contract with the
 * lobby, which drives its "join vs create" hint and its schema block off them.
 */
let http: HttpServer;
let base: string;
let store: RoomStore;

beforeEach(async () => {
  store = new RoomStore({ defaultSeed: { pages: [] } });
  const app = express();
  app.use(express.json());
  createHttpRooms(app, store);
  http = createServer(app);
  await new Promise<void>((resolve) => http.listen(0, resolve));
  base = `http://localhost:${(http.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

describe("GET /health", () => {
  it("reports liveness", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("GET /api/rooms/:id", () => {
  it("404s for a room nobody created", async () => {
    const res = await fetch(`${base}/api/rooms/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ exists: false });
  });

  it("reports an existing room and its participant count", async () => {
    store.create("demo");
    const res = await fetch(`${base}/api/rooms/demo`);
    expect(res.status).toBe(200);
    // The lobby renders this number verbatim; renaming the field breaks its hint.
    expect(await res.json()).toEqual({ roomId: "demo", exists: true, participantCount: 0 });
  });

  it("rejects an id that could escape a path", async () => {
    for (const id of ["a/b", "a.b", "a b"]) {
      const res = await fetch(`${base}/api/rooms/${encodeURIComponent(id)}`);
      expect(res.status).toBe(400);
    }
    // ".." never reaches the handler at all: the HTTP layer normalizes the path
    // first, so the route simply does not match. Rejected either way, just not here.
    expect((await fetch(`${base}/api/rooms/..`)).status).toBe(404);
  });
});

describe("POST /api/rooms", () => {
  it("creates a room with the supplied schema", async () => {
    const res = await fetch(`${base}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "demo", surveyJson: { pages: [{ name: "p1" }] } }),
    });
    expect(res.status).toBe(201);
    expect(store.get("demo")!.seed).toEqual({ pages: [{ name: "p1" }] });
  });

  it("falls back to the configured default schema", async () => {
    await fetch(`${base}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "demo" }),
    });
    expect(store.get("demo")!.seed).toEqual({ pages: [] });
  });

  it("409s rather than replacing an existing room", async () => {
    store.create("demo", { pages: [{ name: "original" }] });
    const res = await fetch(`${base}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "demo", surveyJson: { pages: [{ name: "other" }] } }),
    });
    expect(res.status).toBe(409);
    // A room schema is fixed at creation: a late POST must not rewrite it.
    expect(store.get("demo")!.seed).toEqual({ pages: [{ name: "original" }] });
  });

  it("rejects a schema that is not a plain object", async () => {
    for (const surveyJson of [[], "text", 42, null]) {
      const res = await fetch(`${base}/api/rooms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId: "demo", surveyJson }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("rejects an invalid room id", async () => {
    const res = await fetch(`${base}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "a/b" }),
    });
    expect(res.status).toBe(400);
  });
});
