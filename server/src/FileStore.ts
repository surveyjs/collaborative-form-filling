import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ROOM_ID_RE } from "./RoomManager.js";

/** Metadata for one uploaded file. The bytes live at `path`, never in here. */
export interface StoredFile {
  id: string;
  path: string;
  type: string;
  name: string;
  size: number;
}

export const DEFAULT_ROOT = path.join(os.tmpdir(), "collaborative-form-filling");

/**
 * Per-room ceiling on stored bytes. There is no authentication, so without it
 * one room can fill the container's writable layer.
 */
export const MAX_ROOM_BYTES = 50 * 1024 * 1024;

/**
 * Uploaded files: bytes on disk under a temp directory, index in memory.
 *
 * Bytes go to disk so the process RSS does not grow with the contents of every
 * room. The index is the source of truth: a file that is not in it is never
 * served, even if its bytes somehow survived on disk. Losing the index on a
 * restart costs nothing, because no room survives a restart either.
 *
 * The root lives under `os.tmpdir()` — `/tmp` inside the container, and on a
 * developer's Windows machine the real temp dir (a literal "/tmp" would resolve
 * to a `C:\tmp` that does not exist). Either way it sits outside the repo, so
 * `tsx watch` does not see writes and does not restart the dev server on every
 * upload.
 */
export class FileStore {
  private byRoom = new Map<string, Map<string, StoredFile>>();

  constructor(
    private readonly root: string = DEFAULT_ROOT,
    private readonly maxRoomBytes: number = MAX_ROOM_BYTES,
  ) {}

  /**
   * Wipes and recreates the root directory. Safe by construction: no room
   * survives a restart, so anything left from a previous run is garbage. This
   * is what collects orphans after a hard kill, which the disk — unlike memory
   * — would otherwise keep forever.
   */
  async init(): Promise<void> {
    this.byRoom.clear();
    await rm(this.root, { recursive: true, force: true });
    await mkdir(this.root, { recursive: true });
  }

  roomBytes(roomId: string): number {
    let total = 0;
    const room = this.byRoom.get(roomId);
    if (room) for (const file of room.values()) total += file.size;
    return total;
  }

  /** Stores one file, or returns null when the room is over its budget. */
  async add(roomId: string, body: Buffer, type: string, name: string): Promise<StoredFile | null> {
    const dir = this.roomDir(roomId);
    if (this.roomBytes(roomId) + body.byteLength > this.maxRoomBytes) return null;

    const id = randomUUID();
    const filePath = path.join(dir, id);
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, body);

    const stored: StoredFile = { id, path: filePath, type, name, size: body.byteLength };
    let room = this.byRoom.get(roomId);
    if (!room) {
      room = new Map();
      this.byRoom.set(roomId, room);
    }
    room.set(id, stored);
    return stored;
  }

  get(roomId: string, fileId: string): StoredFile | undefined {
    return this.byRoom.get(roomId)?.get(fileId);
  }

  async delete(roomId: string, fileId: string): Promise<boolean> {
    const room = this.byRoom.get(roomId);
    const stored = room?.get(fileId);
    if (!room || !stored) return false;
    room.delete(fileId);
    if (room.size === 0) this.byRoom.delete(roomId);
    // force: on Windows a file being streamed to a response can report EBUSY,
    // and a failed unlink must not turn into a failed request — the startup
    // sweep collects it either way.
    await rm(stored.path, { force: true });
    return true;
  }

  async deleteRoom(roomId: string): Promise<void> {
    const dir = this.roomDir(roomId);
    this.byRoom.delete(roomId);
    await rm(dir, { recursive: true, force: true });
  }

  /**
   * Room directory. The id is re-validated here, at the filesystem boundary,
   * even though the routes already check it: this is the only place that turns
   * a request value into a path, and ROOM_ID_RE is what rules out `.` and `/`.
   */
  private roomDir(roomId: string): string {
    if (!ROOM_ID_RE.test(roomId)) throw new Error("invalid room id");
    return path.join(this.root, roomId);
  }
}
