import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStore } from "./FileStore.js";

/**
 * Every test gets its own root via mkdtemp so they never trample the shared
 * temp directory — or each other, since the suite runs in one process.
 */
describe("FileStore", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "filestore-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes the bytes to disk and keeps only metadata in the index", async () => {
    const store = new FileStore(root);
    const body = Buffer.from("hello");

    const stored = await store.add("r1", body, "image/png", "photo.png");

    expect(stored).not.toBeNull();
    expect(stored).toMatchObject({ type: "image/png", name: "photo.png", size: 5 });
    expect(await readFile(stored!.path)).toEqual(body);
    expect(store.get("r1", stored!.id)).toEqual(stored);
    expect(store.roomBytes("r1")).toBe(5);
  });

  it("does not serve a file that is missing from the index", async () => {
    const store = new FileStore(root);
    expect(store.get("r1", "nope")).toBeUndefined();
  });

  it("refuses a file that would push the room over its budget", async () => {
    const store = new FileStore(root, 10);
    await store.add("r1", Buffer.alloc(8), "application/octet-stream", "a.bin");

    const rejected = await store.add("r1", Buffer.alloc(8), "application/octet-stream", "b.bin");

    expect(rejected).toBeNull();
    expect(store.roomBytes("r1")).toBe(8);
  });

  it("budgets each room separately", async () => {
    const store = new FileStore(root, 10);
    await store.add("r1", Buffer.alloc(8), "application/octet-stream", "a.bin");

    const other = await store.add("r2", Buffer.alloc(8), "application/octet-stream", "b.bin");

    expect(other).not.toBeNull();
  });

  it("delete removes the file from the index and from disk", async () => {
    const store = new FileStore(root);
    const stored = await store.add("r1", Buffer.alloc(4), "image/png", "a.png");

    expect(await store.delete("r1", stored!.id)).toBe(true);

    expect(store.get("r1", stored!.id)).toBeUndefined();
    expect(existsSync(stored!.path)).toBe(false);
    expect(store.roomBytes("r1")).toBe(0);
  });

  it("delete reports false for a file it does not have", async () => {
    const store = new FileStore(root);
    expect(await store.delete("r1", "nope")).toBe(false);
  });

  it("deleteRoom removes the room's directory, not just the index", async () => {
    const store = new FileStore(root);
    const stored = await store.add("r1", Buffer.alloc(4), "image/png", "a.png");

    await store.deleteRoom("r1");

    expect(store.get("r1", stored!.id)).toBeUndefined();
    expect(existsSync(path.join(root, "r1"))).toBe(false);
  });

  it("init sweeps whatever a previous run left behind", async () => {
    // Stand in for an orphan after a hard kill: bytes on disk that no index
    // knows about. Only the startup sweep can ever collect those.
    await mkdir(path.join(root, "stale-room"), { recursive: true });
    await writeFile(path.join(root, "stale-room", "orphan"), "leftover");

    await new FileStore(root).init();

    expect(existsSync(path.join(root, "stale-room"))).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  it("refuses a room id that could escape the root", async () => {
    const store = new FileStore(root);
    // ROOM_ID_RE admits neither "." nor "/", which is what closes traversal —
    // re-checked here because this is the layer that builds a real path.
    await expect(store.add("../escape", Buffer.alloc(1), "text/plain", "x")).rejects.toThrow(
      /invalid room id/,
    );
  });
});
