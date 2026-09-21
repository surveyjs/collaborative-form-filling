/**
 * Wire protocol types and constants — the TypeScript rendering of PROTOCOL.md.
 *
 * This file has ZERO imports on purpose: it is the whole contract a server port
 * needs, and it must stay readable by a Go/.NET/Java implementer. Survey schemas,
 * answer values and presence states are `unknown` everywhere — the server stores
 * and forwards them without ever looking inside.
 *
 * The message names are deliberately the same vocabulary the collaboration plugin
 * in survey-core speaks, so a client forwards frames into `plugin.apply()` and out
 * of `plugin.onEvent` without translating anything.
 */

/** URL-safe room ids. Doubles as the path-traversal guard for the file store. */
export const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Presence colours are a CLIENT concept: the relay assigns a slot NUMBER and never
 * resolves it to a colour. The palette lives in the client theme — survey-core's
 * `--sjs2-color-utility-user-bg-color-N` and its paired `-fg-on-color-N` — which
 * is the only thing that knows whether the page is light or dark and what stays
 * legible on it.
 *
 * A relay that stamped a hex would be a second palette indexed by the same number,
 * and the same person would come out one colour on their avatar and another on
 * their focus ring. That is not hypothetical: it is the bug this field replaced.
 *
 * The server assigns the lowest slot not held by another client in the room, so
 * colours are stable and collision-free per room; a leaver's slot is reusable.
 * Slot 0 is reserved for an unknown user (the theme paints it grey), so
 * participants get 1..9.
 */
export const PRESENCE_FIRST_COLOR_SLOT = 1;
export const PRESENCE_COLOR_SLOTS = 9;

/** Display names are trimmed to this many code points; empty becomes DEFAULT_NAME. */
export const PRESENCE_NAME_MAX = 32;
export const DEFAULT_NAME = "Anonymous";

/** Presence frames larger than this are dropped in silence. */
export const PRESENCE_MAX_BYTES = 4096;
/** Token bucket for presence: sustained rate and burst capacity, per client. */
export const PRESENCE_TOKENS_PER_SEC = 50;
export const PRESENCE_BUCKET_CAPACITY = 100;

/**
 * Ceiling on one answer's serialized form, mirroring the plugin's own guard — keep
 * the two in step. The plugin refuses an oversized value with a message on the
 * question; this copy is what actually enforces it, because a client that does not
 * run that guard (an older build, someone else's client) must not be able to park
 * an oversized answer in a room or have it rebroadcast to everyone.
 *
 * Sized for a file question left on survey-core's `storeDataAsText: true`, where
 * the file's bytes ARE the value: 10 MiB of file becomes ~13.4 MiB of base64 (x4/3)
 * plus the data-URL prefix and the JSON wrapper. The three limits form one chain
 * and MUST keep their order:
 *
 *   MAX_FILE_BYTES x 4/3  <  MAX_VALUE_CHARS  <  MAX_FRAME_BYTES
 *         13.4 MiB        <      16 MiB       <      20 MiB
 */
export const MAX_VALUE_CHARS = 16 * 1024 * 1024;
/** ws `maxPayload`: anything bigger closes the socket with code 1009. */
export const MAX_FRAME_BYTES = 20 * 1024 * 1024;
/** Per-file ceiling for the blob store (a demo extension, not part of the relay). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Per-room blob budget. */
export const MAX_ROOM_BYTES = 50 * 1024 * 1024;

/**
 * A `value` frame is rejected before JSON.parse when it exceeds this. Checking the
 * FRAME rather than re-serializing the parsed value is both cheaper (no second
 * stringify on every keystroke) and stronger: it also bounds parse cost.
 */
export const MAX_SET_FRAME_BYTES = MAX_VALUE_CHARS + 1024 * 1024;

/**
 * Truncate to at most `max` Unicode code points. String#slice counts UTF-16 units
 * and can cut a surrogate pair in half, leaving a lone surrogate that strict JSON
 * decoders reject; every name trim uses this.
 */
export function truncateCodePoints(s: string, max: number): string {
  return Array.from(s).slice(0, max).join("");
}

export function sanitizeName(raw: string | null | undefined): string {
  return truncateCodePoints((raw ?? "").trim(), PRESENCE_NAME_MAX) || DEFAULT_NAME;
}

// ---------------------------------------------------------------------------
// HTTP

/** GET /api/rooms/:id → 200 */
export interface IRoomInfo {
  roomId: string;
  exists: true;
  participantCount: number;
}

/** POST /api/rooms body. `surveyJson` is opaque beyond being a plain object. */
export interface ICreateRoomRequest {
  roomId: string;
  surveyJson?: unknown;
}

// ---------------------------------------------------------------------------
// WebSocket: client → server

/** One local answer edit. `key` is opaque: the server only uses it as a map key. */
export interface IValueMsg {
  type: "value";
  key: string;
  value: unknown;
}

/**
 * This client's FULL presence state (never a diff), which makes presence
 * self-healing: any single frame re-establishes the participant. Opaque to the
 * server. Identity is NOT inside it — the server stamps it onto the relayed
 * envelope.
 *
 * `retain` (default true) says whether the server keeps the state for late joiners
 * — focus and page do, a mouse cursor does not — and a non-retained frame may be
 * dropped for a peer whose send buffer is congested. That is the hand-rolled
 * equivalent of socket.io's `volatile`, which raw ws does not provide.
 */
export interface IPresenceMsg {
  type: "presence";
  state: unknown;
  retain?: boolean;
}

export type ClientToServer = IValueMsg | IPresenceMsg;

// ---------------------------------------------------------------------------
// WebSocket: server → client

/**
 * Bootstrap, sent once immediately after connect and again on every reconnect.
 *
 * One frame rather than three (identity, then state, then roster) so that no peer
 * edit can land between them and be erased by a state that does not contain it yet.
 * `seed` and the identity triple `clientId`/`name`/`colorIndex` are for the host;
 * the plugin reads `values` and `peers` and ignores the rest.
 */
export interface IInitMsg {
  type: "init";
  clientId: string;
  name: string;
  /** This client's own colour slot — the same identity the peers below carry. */
  colorIndex: number;
  seed: unknown;
  values: { [key: string]: unknown };
  peers: Array<IPresencePeerEntry>;
}

/**
 * A peer's edit, sent to everyone but the author.
 *
 * `from` takes no part in convergence - last write wins per key, whoever wrote it -
 * and the server does not store it: `values` is a key -> value map with no authors in
 * it. What reads it is the client's session history ("who changed what while I was
 * here"), which is why the field is stamped even though the relay never needs it.
 */
export interface IValueBroadcastMsg {
  type: "value";
  from: string;
  key: string;
  value: unknown;
}

/** One roster entry as the server knows it. `state` stays opaque. */
export interface IPresencePeerEntry {
  clientId: string;
  name: string;
  /**
   * Which theme colour slot paints this participant. A number rather than a colour
   * because a client renders one participant in several places at once — the ring
   * around the question they are in, their cursor, and their avatar in the strip —
   * and every one of those has to resolve the SAME source or the colour stops
   * identifying anybody. See PRESENCE_COLOR_SLOTS.
   */
  colorIndex: number;
  state: unknown;
}

export interface IPeerMsg {
  type: "peer";
  peer: IPresencePeerEntry;
  retain: boolean;
}

export interface IPeerLeftMsg {
  type: "peer-left";
  clientId: string;
}

export type ServerToClient = IInitMsg | IValueBroadcastMsg | IPeerMsg | IPeerLeftMsg;
