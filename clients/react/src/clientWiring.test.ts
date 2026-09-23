import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A structural guard, not a behavioural one.
 *
 * Every client entry has to do three things that nothing else verifies: register the
 * collaboration plugin, attach the file hooks, and drive the connection. File uploads
 * in particular are NOT part of the plugin - `shared/fileSync.ts` only wires
 * survey-core's own onUploadFiles/onClearFiles to this app's blob endpoint - so a
 * client that forgets them still passes every collaboration test while silently
 * breaking uploads. That is exactly what happened once during the migration.
 *
 * Driving survey-core's file widget from Playwright turned out to be unreliable, and
 * `attachFileSync` itself is covered by fileSync.test.ts; this is the cheap check that
 * the wiring is actually present in all four apps.
 */
const ROOT = path.resolve(__dirname, "../../..");
const ENTRIES = [
  "clients/react/src/App.tsx",
  "clients/js/src/main.ts",
  "clients/vue/src/App.vue",
  "clients/angular/src/app/app.component.ts",
];

describe("every client entry wires collaboration the same way", () => {
  for (const entry of ENTRIES) {
    describe(entry, () => {
      const source = readFileSync(path.join(ROOT, entry), "utf8");

      it("registers the collaboration plugin", () => {
        expect(source).toContain("new CollaborationPlugin(");
        expect(source).toContain("survey-core/collaboration");
      });

      it("attaches the file hooks", () => {
        expect(source).toContain("attachFileSync(");
      });

      it("drives the connection through the shared transport", () => {
        expect(source).toContain("connectCollab(");
      });

      it("contains no participants-bar markup of its own", () => {
        // The bar is contributed by the plugin and drawn by the library's action bar.
        expect(source).not.toContain("ParticipantsBar");
        expect(source).not.toContain("sv-collab-bar");
      });

      it("no longer imports socket.io or the removed shared modules", () => {
        expect(source).not.toContain("socket.io");
        expect(source).not.toContain("shared/room");
        expect(source).not.toContain("shared/sync");
        expect(source).not.toContain("shared/presenceSync");
      });
    });
  }
});
