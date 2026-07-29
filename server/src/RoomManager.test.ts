import { describe, expect, it } from "vitest";
import { RoomManager } from "./RoomManager.js";

describe("RoomManager", () => {
  it("creates a room once and reuses it", () => {
    const rm = new RoomManager();
    const a = rm.getOrCreate("r1");
    const b = rm.getOrCreate("r1");
    expect(a).toBe(b);
    expect(a.data).toEqual({});
    expect(a.surveyJson).toBeDefined();
  });

  it("uses a custom survey on creation and ignores it for an existing room", () => {
    const rm = new RoomManager();
    const custom = { pages: [{ name: "p1", elements: [] }] };
    const created = rm.getOrCreate("r1", custom);
    expect(created.surveyJson).toBe(custom);

    // A later join with a different schema must not replace the fixed one.
    const other = { pages: [{ name: "other", elements: [] }] };
    const same = rm.getOrCreate("r1", other);
    expect(same.surveyJson).toBe(custom);
  });

  it("falls back to the default survey when none is provided", () => {
    const rm = new RoomManager();
    const room = rm.getOrCreate("r1");
    expect(room.surveyJson).toBeDefined();
  });

  it("registers participants and assigns distinct colors", () => {
    const rm = new RoomManager();
    const p1 = rm.join("r1", "sock-1", "Alice");
    const p2 = rm.join("r1", "sock-2", "Bob");
    expect(p1.name).toBe("Alice");
    expect(p2.name).toBe("Bob");
    expect(p1.color).not.toBe(p2.color);
    expect(rm.listParticipants("r1")).toHaveLength(2);
  });

  it("falls back to 'Anonymous' for blank names", () => {
    const rm = new RoomManager();
    const p = rm.join("r1", "sock-1", "   ");
    expect(p.name).toBe("Anonymous");
  });

  it("applies last-write-wins per question", () => {
    const rm = new RoomManager();
    rm.setValue("r1", "q1", "first");
    rm.setValue("r1", "q1", "second");
    rm.setValue("r1", "q2", 42);
    expect(rm.get("r1")!.data).toEqual({ q1: "second", q2: 42 });
  });

  it("removes a participant and prunes the room when empty", () => {
    const rm = new RoomManager();
    rm.join("r1", "sock-1", "Alice");
    rm.join("r1", "sock-2", "Bob");

    expect(rm.leave("sock-1")).toEqual({ roomId: "r1" });
    expect(rm.listParticipants("r1")).toHaveLength(1);
    expect(rm.get("r1")).toBeDefined();

    expect(rm.leave("sock-2")).toEqual({ roomId: "r1" });
    expect(rm.get("r1")).toBeUndefined();
  });

  it("returns null when leaving with an unknown socket id", () => {
    const rm = new RoomManager();
    expect(rm.leave("ghost")).toBeNull();
  });

  it("stores and clears a participant's focus", () => {
    const rm = new RoomManager();
    rm.join("r1", "sock-1", "Alice");

    rm.setFocus("r1", "sock-1", "projectName");
    expect(rm.listParticipants("r1")[0].focus).toBe("projectName");

    rm.setFocus("r1", "sock-1", null);
    expect(rm.listParticipants("r1")[0].focus).toBeNull();
  });

  it("ignores setFocus for unknown rooms and participants", () => {
    const rm = new RoomManager();
    expect(() => rm.setFocus("ghost-room", "sock-1", "q1")).not.toThrow();

    rm.join("r1", "sock-1", "Alice");
    rm.setFocus("r1", "ghost-sock", "q1");
    expect(rm.listParticipants("r1")[0].focus).toBeUndefined();
  });

  it("stores and clears a participant's page", () => {
    const rm = new RoomManager();
    rm.join("r1", "sock-1", "Alice");

    rm.setPage("r1", "sock-1", "team");
    expect(rm.listParticipants("r1")[0].page).toBe("team");

    rm.setPage("r1", "sock-1", null);
    expect(rm.listParticipants("r1")[0].page).toBeNull();
  });

  it("ignores setPage for unknown rooms and participants", () => {
    const rm = new RoomManager();
    expect(() => rm.setPage("ghost-room", "sock-1", "team")).not.toThrow();

    rm.join("r1", "sock-1", "Alice");
    rm.setPage("r1", "ghost-sock", "team");
    expect(rm.listParticipants("r1")[0].page).toBeUndefined();
  });

  it("drops focus together with the participant on leave", () => {
    const rm = new RoomManager();
    rm.join("r1", "sock-1", "Alice");
    rm.join("r1", "sock-2", "Bob");
    rm.setFocus("r1", "sock-1", "projectName");

    rm.leave("sock-1");
    expect(rm.listParticipants("r1").some((p) => p.focus === "projectName")).toBe(false);
  });
});
