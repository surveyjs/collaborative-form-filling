import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  IBarParticipant,
  ParticipantsBarModel,
  presenceInitials,
} from "../../../shared/participantsBar";

const roster = (...names: Array<string>): Array<IBarParticipant> =>
  names.map((name, i) => ({ id: "id" + i, name: name, color: "#00000" + i }));

describe("presenceInitials", () => {
  test("derives initials from the display name", () => {
    expect(presenceInitials("Alice")).toBe("AL");
    expect(presenceInitials("Alice Smith")).toBe("AS");
    expect(presenceInitials("Anna Maria Grande")).toBe("AG");
    expect(presenceInitials("  bob  ")).toBe("BO");
    expect(presenceInitials("")).toBe("?");
    expect(presenceInitials("   ")).toBe("?");
  });
});

describe("ParticipantsBarModel", () => {
  test("chips show only other participants (self is excluded)", () => {
    const model = new ParticipantsBarModel({ roomId: "r1", selfId: "id0" });
    model.setParticipants(roster("Alice", "Bob Brown"));

    expect(model.roomId).toBe("r1");
    const chips = model.chips;
    expect(chips.length).toBe(1);
    expect(chips[0]).toEqual({
      id: "id1", initials: "BB", color: "#000001", name: "Bob Brown", title: "Bob Brown",
    });
    expect(model.overflowCount).toBe(0);

    // Without a selfId nothing is filtered out.
    const anon = new ParticipantsBarModel();
    anon.setParticipants(roster("Alice", "Bob Brown"));
    expect(anon.chips.length).toBe(2);
  });

  test("caps avatars at MAX_AVATARS and reports overflow names", () => {
    const model = new ParticipantsBarModel();
    const names: Array<string> = [];
    for (let i = 0; i < 10; i++) names.push("User" + i);
    model.setParticipants(roster(...names));

    expect(model.chips.length).toBe(ParticipantsBarModel.MAX_AVATARS);
    expect(model.overflowCount).toBe(2);
    expect(model.overflowTitle).toBe("User8, User9");

    model.setParticipants(roster("Alice"));
    expect(model.overflowCount).toBe(0);
    expect(model.overflowTitle).toBe("");
  });

  test("setParticipants skips updates when the visible roster is unchanged", () => {
    const model = new ParticipantsBarModel();
    let changeCounter = 0;
    model.onPropertyChanged.add((sender, options) => {
      if (options.name === "participants") changeCounter++;
    });

    model.setParticipants(roster("Alice", "Bob"));
    const afterFirst = changeCounter;
    expect(afterFirst).toBeGreaterThan(0);

    model.setParticipants(roster("Alice", "Bob"));
    expect(changeCounter).toBe(afterFirst);

    model.setParticipants(roster("Bob", "Alice"));
    expect(changeCounter).toBeGreaterThan(afterFirst);
  });

  describe("copyInviteLink", () => {
    const writeText = vi.fn(() => Promise.resolve());
    beforeEach(() => {
      vi.useFakeTimers();
      writeText.mockClear();
      vi.stubGlobal("navigator", { clipboard: { writeText: writeText } });
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    test("copies the invite link and reverts the caption after the timeout", () => {
      const model = new ParticipantsBarModel({ getInviteLink: () => "http://x/?room=r1" });
      expect(model.showInvite).toBe(true);
      expect(model.inviteCaption).toBe("Invite");

      model.copyInviteLink();
      expect(writeText).toHaveBeenCalledWith("http://x/?room=r1");
      expect(model.inviteCaption).toBe("Copied");

      vi.advanceTimersByTime(ParticipantsBarModel.COPIED_REVERT_MS);
      expect(model.inviteCaption).toBe("Invite");
    });

    test("a second click restarts the revert timer", () => {
      const model = new ParticipantsBarModel({ getInviteLink: () => "link" });
      model.copyInviteLink();
      vi.advanceTimersByTime(ParticipantsBarModel.COPIED_REVERT_MS - 100);
      model.copyInviteLink();
      vi.advanceTimersByTime(100);
      expect(model.inviteCaption).toBe("Copied");
      vi.advanceTimersByTime(ParticipantsBarModel.COPIED_REVERT_MS - 100);
      expect(model.inviteCaption).toBe("Invite");
    });

    test("does nothing without the option or the clipboard API", () => {
      const noOption = new ParticipantsBarModel();
      expect(noOption.showInvite).toBe(false);
      expect(() => noOption.copyInviteLink()).not.toThrow();
      expect(writeText).not.toHaveBeenCalled();

      vi.stubGlobal("navigator", {});
      const model = new ParticipantsBarModel({ getInviteLink: () => "link" });
      expect(() => model.copyInviteLink()).not.toThrow();
      expect(model.inviteCaption).toBe("Invite");
    });
  });

  test("dispose is idempotent and cancels the pending caption revert", () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { clipboard: { writeText: () => Promise.resolve() } });
    try {
      const model = new ParticipantsBarModel({ getInviteLink: () => "link" });
      model.copyInviteLink();

      // The host disposes the bar on rejoin/cleanup — possibly twice.
      model.dispose();
      expect(model.isDisposed).toBe(true);
      expect(() => model.dispose()).not.toThrow();
      expect(() => vi.runAllTimers()).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
