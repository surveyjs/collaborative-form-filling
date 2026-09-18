import { createReadStream } from "node:fs";
import express, { type Express, type Request, type Response } from "express";
import type { FileStore } from "./FileStore.js";
import { MAX_FILE_BYTES, ROOM_ID_RE } from "./protocol.js";

export { MAX_FILE_BYTES };


/**
 * Content types served inline. Everything else is handed over as an
 * attachment with a generic type.
 *
 * These files now come from the SAME ORIGIN as the app, which they did not
 * when storage was a third-party host — so an uploaded document rendered
 * inline would be stored XSS against the app itself. `image/svg+xml` is
 * deliberately absent: SVG executes script.
 */
const INLINE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"];

/** Strips anything that would break out of a quoted filename parameter. */
function headerSafeName(name: string): string {
  return name.replace(/[^\w.\- ]+/g, "_").slice(0, 100) || "file";
}

/**
 * Registers the file endpoints on `app`.
 *
 * A separate module rather than inline in index.ts: importing index.ts boots
 * Vite and listens on a port, so routes defined there cannot be tested. Here
 * they mount onto a bare Express app in a test.
 *
 * Routes are registered with full paths instead of `app.use("/api/rooms", …)`
 * so the existing two-segment `GET /api/rooms/:id` stays independent of mount
 * order — Express matches segment counts exactly, so the two never collide.
 */
export function createFileRoutes(app: Express, hasRoom: (roomId: string) => boolean, files: FileStore): void {
  const raw = express.raw({ type: "*/*", limit: MAX_FILE_BYTES });

  app.post("/api/rooms/:roomId/files", raw, (req: Request, res: Response) => {
    const { roomId } = req.params;
    if (!ROOM_ID_RE.test(roomId)) {
      res.status(400).json({ error: "invalid room id" });
      return;
    }
    // Deliberately NOT getOrCreate: an upload must not conjure a room. Rooms
    // are pruned when their last participant leaves, so a room nobody ever
    // joined would have no one to clean it up.
    if (!hasRoom(roomId)) {
      res.status(404).json({ error: "room not found" });
      return;
    }
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.byteLength === 0) {
      res.status(400).json({ error: "empty body" });
      return;
    }

    const type = String(req.headers["content-type"] ?? "application/octet-stream");
    const name = typeof req.query.name === "string" ? req.query.name : "file";

    files
      .add(roomId, body, type, name)
      .then((stored) => {
        if (!stored) {
          res.status(413).json({ error: "room storage budget exceeded" });
          return;
        }
        // Root-relative: every client is served from this same origin, so
        // there is no host to hard-code and none to get wrong behind a proxy.
        res.status(201).json({ url: `/api/rooms/${roomId}/files/${stored.id}` });
      })
      .catch((error) => {
        console.error("[files] failed to store an upload", error);
        res.status(500).json({ error: "failed to store the file" });
      });
  });

  app.get("/api/rooms/:roomId/files/:fileId", (req: Request, res: Response) => {
    const stored = files.get(req.params.roomId, req.params.fileId);
    if (!stored) {
      res.status(404).json({ error: "file not found" });
      return;
    }

    const inline = INLINE_TYPES.indexOf(stored.type) >= 0;
    // Headers are set by hand rather than via res.sendFile: the file on disk
    // has no extension (its name is a UUID), so sendFile would sniff a type of
    // its own and bypass the allowlist — and the allowlist is the defence.
    res.setHeader("Content-Type", inline ? stored.type : "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      inline ? "inline" : `attachment; filename="${headerSafeName(stored.name)}"`,
    );
    res.setHeader("Content-Length", String(stored.size));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    // The id is immutable, so the bytes behind a URL never change.
    res.setHeader("Cache-Control", "private, max-age=86400, immutable");

    const stream = createReadStream(stored.path);
    stream.on("error", (error) => {
      console.error("[files] failed to read a stored file", error);
      if (!res.headersSent) res.status(404).json({ error: "file not found" });
      else res.destroy();
    });
    stream.pipe(res);
  });

  // 200, not 204: the client checks `response.status === 200`, not `.ok`.
  app.delete("/api/rooms/:roomId/files/:fileId", (req: Request, res: Response) => {
    files
      .delete(req.params.roomId, req.params.fileId)
      .then((removed) => {
        if (removed) res.status(200).json({ ok: true });
        else res.status(404).json({ error: "file not found" });
      })
      .catch((error) => {
        console.error("[files] failed to delete a stored file", error);
        res.status(500).json({ error: "failed to delete the file" });
      });
  });
}
