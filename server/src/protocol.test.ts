import { describe, expect, it } from "vitest";
import {
  MAX_FILE_BYTES,
  MAX_FRAME_BYTES,
  MAX_SET_FRAME_BYTES,
  MAX_VALUE_CHARS,
  PRESENCE_NAME_MAX,
  ROOM_ID_RE,
  sanitizeName,
  truncateCodePoints,
} from "./protocol.js";

describe("room ids", () => {
  it("accepts url-safe ids", () => {
    for (const id of ["a", "demo-1", "A_b-9", "x".repeat(64)]) {
      expect(ROOM_ID_RE.test(id)).toBe(true);
    }
  });
  it("rejects anything that could escape a path", () => {
    // This regex doubles as the path-traversal guard for the file store, so the
    // absence of "." and "/" is a security property, not a style choice.
    for (const id of ["", "..", "a/b", "a.b", "a b", "x".repeat(65)]) {
      expect(ROOM_ID_RE.test(id)).toBe(false);
    }
  });
});

describe("display names", () => {
  it("trims by code points, never splitting a surrogate pair", () => {
    // String#slice counts UTF-16 units and would leave a lone surrogate, which
    // strict JSON decoders reject - and which then breaks every later connect.
    const emoji = "\u{1F600}".repeat(40);
    const cut = truncateCodePoints(emoji, PRESENCE_NAME_MAX);
    expect(Array.from(cut)).toHaveLength(PRESENCE_NAME_MAX);
    expect(() => JSON.parse(JSON.stringify({ name: cut }))).not.toThrow();
  });
  it("falls back to a default for an empty name", () => {
    expect(sanitizeName("   ")).toBe("Anonymous");
    expect(sanitizeName(null)).toBe("Anonymous");
    expect(sanitizeName("  Ann  ")).toBe("Ann");
  });
});

describe("the size limit chain", () => {
  it("keeps its order", () => {
    // A file question left on storeDataAsText puts the file base64 in the value,
    // so the file ceiling must clear the value ceiling with the x4/3 expansion,
    // and the value ceiling must clear the frame ceiling. Asserted numerically so
    // nobody can reorder the constants without this failing.
    expect(MAX_FILE_BYTES * 4 / 3).toBeLessThan(MAX_VALUE_CHARS);
    expect(MAX_VALUE_CHARS).toBeLessThan(MAX_FRAME_BYTES);
    expect(MAX_SET_FRAME_BYTES).toBeGreaterThan(MAX_VALUE_CHARS);
    expect(MAX_SET_FRAME_BYTES).toBeLessThan(MAX_FRAME_BYTES);
  });
});
