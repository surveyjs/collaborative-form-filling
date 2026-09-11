import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStore } from "./FileStore.js";
import { createFileRoutes, MAX_FILE_BYTES } from "./fileRoutes.js";
import { RoomManager } from "./RoomManager.js";

/**
 * The routes live in their own module precisely so they can be mounted on a
 * bare Express app here — importing index.ts would boot Vite and bind a port.
 */
function start(rooms: RoomManager, files: FileStore): Promise<{ http: HttpServer; base: string }> {
  const app = express();
  createFileRoutes(app, rooms, files);
  const http = createServer(app);
  return new Promise((resolve) => {
    http.listen(0, () => {
      const { port } = http.address() as { port: number };
      resolve({ http, base: `http://localhost:${port}` });
    });
  });
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

describe("file routes", () => {
  let root: string;
  let http: HttpServer;
  let base: string;
  let rooms: RoomManager;
  let files: FileStore;

  async function serve(maxRoomBytes?: number) {
    files = new FileStore(root, maxRoomBytes);
    rooms = new RoomManager();
    ({ http, base } = await start(rooms, files));
  }

  function upload(roomId: string, body: Buffer, type: string, name: string) {
    return fetch(`${base}/api/rooms/${roomId}/files?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": type },
      body,
    });
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "fileroutes-test-"));
  });

  afterEach(async () => {
    http?.close();
    await rm(root, { recursive: true, force: true });
  });

  it("refuses to upload into a room that does not exist", async () => {
    await serve();
    // Deliberately not getOrCreate: an upload must never conjure a room,
    // because a room nobody joined has nobody to prune it.
    const response = await upload("ghost", PNG, "image/png", "a.png");

    expect(response.status).toBe(404);
    expect(files.roomBytes("ghost")).toBe(0);
  });

  it("rejects a malformed room id", async () => {
    await serve();
    const response = await fetch(`${base}/api/rooms/..%2Fescape/files?name=a.png`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: PNG,
    });

    expect(response.status).toBe(400);
  });

  it("rejects an empty body", async () => {
    await serve();
    rooms.getOrCreate("r1");

    const response = await upload("r1", Buffer.alloc(0), "image/png", "a.png");

    expect(response.status).toBe(400);
  });

  it("stores an upload and serves the bytes back from the returned url", async () => {
    await serve();
    rooms.getOrCreate("r1");

    const posted = await upload("r1", PNG, "image/png", "photo.png");
    expect(posted.status).toBe(201);
    const { url } = (await posted.json()) as { url: string };
    // Root-relative, because every client is served from this same origin.
    expect(url).toMatch(/^\/api\/rooms\/r1\/files\/[0-9a-f-]{36}$/);

    const got = await fetch(base + url);
    expect(got.status).toBe(200);
    expect(Buffer.from(await got.arrayBuffer())).toEqual(PNG);
  });

  it("serves an allowed image inline with its own type", async () => {
    await serve();
    rooms.getOrCreate("r1");
    const { url } = (await (await upload("r1", PNG, "image/png", "photo.png")).json()) as {
      url: string;
    };

    const got = await fetch(base + url);

    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("content-disposition")).toBe("inline");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("hands anything else over as an attachment with a generic type", async () => {
    await serve();
    rooms.getOrCreate("r1");
    // These files come from the same origin as the app, so an uploaded
    // document rendered inline would be stored XSS against the app itself.
    const { url } = (await (
      await upload("r1", Buffer.from("<script>alert(1)</script>"), "text/html", "evil.html")
    ).json()) as { url: string };

    const got = await fetch(base + url);

    expect(got.headers.get("content-type")).toBe("application/octet-stream");
    expect(got.headers.get("content-disposition")).toBe('attachment; filename="evil.html"');
  });

  it("does not serve svg inline, because svg executes script", async () => {
    await serve();
    rooms.getOrCreate("r1");
    const { url } = (await (
      await upload("r1", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/svg+xml", "a.svg")
    ).json()) as { url: string };

    const got = await fetch(base + url);

    expect(got.headers.get("content-type")).toBe("application/octet-stream");
    expect(got.headers.get("content-disposition")).toContain("attachment");
  });

  it("refuses an upload that would push the room over its budget", async () => {
    await serve(1024);
    rooms.getOrCreate("r1");

    const response = await upload("r1", Buffer.alloc(2048), "application/octet-stream", "big.bin");

    expect(response.status).toBe(413);
  });

  it("refuses a body over the per-file limit before it reaches the store", async () => {
    await serve();
    rooms.getOrCreate("r1");

    const response = await upload(
      "r1",
      Buffer.alloc(MAX_FILE_BYTES + 1024),
      "application/octet-stream",
      "huge.bin",
    );

    expect(response.status).toBe(413);
    expect(files.roomBytes("r1")).toBe(0);
  });

  it("deletes a stored file and then reports it missing", async () => {
    await serve();
    rooms.getOrCreate("r1");
    const { url } = (await (await upload("r1", PNG, "image/png", "a.png")).json()) as {
      url: string;
    };

    const deleted = await fetch(base + url, { method: "DELETE" });
    // 200 rather than 204: the client checks `status === 200`, not `.ok`.
    expect(deleted.status).toBe(200);

    expect((await fetch(base + url)).status).toBe(404);
  });

  it("reports 404 when deleting something that is not there", async () => {
    await serve();
    rooms.getOrCreate("r1");

    const response = await fetch(`${base}/api/rooms/r1/files/00000000-0000-0000-0000-000000000000`, {
      method: "DELETE",
    });

    expect(response.status).toBe(404);
  });
});
