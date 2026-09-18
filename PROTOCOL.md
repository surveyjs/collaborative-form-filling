# Collaborative Form Filling Protocol

A language-agnostic specification of the server side. The Node server in
[`server/src`](server/src) is a *reference implementation*: it has no SurveyJS
dependency and is meant to be straightforward to port to Go, .NET, Java or Python.

## Core idea

Clients run SurveyJS with the collaboration plugin from `survey-core/collaboration`.
The plugin turns every local answer change into a small `{ key, value }` message and
applies incoming ones. All convergence lives in the clients: last write wins per key.

A room is:

```
room = { id, seed, values, clients }
```

- `seed` — the survey schema. **Opaque**: never parsed, validated or executed.
- `values` — `key → last value`. Both **opaque**; `key` is used only as a map key.
- `clients` — the connected WebSockets, each with a server-assigned id.

The server's whole job is: hand a newcomer the seed, the values and the roster; store
and fan out each answer change; relay presence; reclaim rooms nobody is in.

**Why a snapshot map rather than an append-only log.** The collaborative state of a
form filling session already *is* a flat key → value map with last-write-wins per key,
so a log adds no convergence power: replaying `[{a,1},{a,2}]` and storing `{a:2}` are
the same thing. A log would instead grow without bound during a session and make a
late joiner `O(edits)` rather than `O(questions)`.

**The one thing the server knows about a key** is that it is a string it can use as a
map key. It never splits it, never matches it against a schema, never interprets the
value. (The plugin encodes a question's comment into the same key space; that encoding
is a client-side convention the server is unaware of.)

## Forward compatibility

Both sides **MUST** ignore, in silence:

- a message whose `type` they do not know, and
- fields they do not know inside a message they do.

This is a contract, not advice. It is what lets a client forward frames straight into
the plugin and out of it without an adapter, and what lets the vocabulary grow without
rewiring every application. The server already relies on it: it adds `from` to a
relayed `value`, and `init` carries several fields only the host reads.

## Identifiers

- **Room id** — chosen by clients, `^[A-Za-z0-9_-]{1,64}$`. Anything else is rejected
  with HTTP 400 or a refused WebSocket upgrade. It admits neither `.` nor `/`, which
  is what also makes it safe as a path segment for the file store.
- **Client id** — assigned by the server per connection (the reference uses a UUID).
  A reconnect is a *new* client id, not a resumed session.
- **Display name** — from `?name=`, trimmed, at most 32 **code points** (never cut
  mid-surrogate), empty becomes `Anonymous`.

## HTTP API

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/health` | `200 {"ok":true}` |
| `GET` | `/api/rooms/{id}` | `200 {roomId, exists:true, participantCount}` · `404 {exists:false}` · `400` |
| `POST` | `/api/rooms` | `201 {roomId}` · `409` (exists; its seed is **not** touched) · `400` |

`POST` body is `{ roomId, surveyJson? }`. The only check on `surveyJson` is that it is
a plain object; without it the room gets the server's configured default. A room's seed
is fixed at creation — that is why `409` is a normal outcome and clients treat it as
"someone created it first, just join".

## WebSocket

`ws(s)://host/ws/rooms/{roomId}?name={displayName}`

One connection is one participant in one room. A room that does not exist is created
on connect, so a pasted deep link works. Every message is a single JSON object.

**The message names are deliberately the vocabulary the collaboration plugin speaks**,
so a client forwards frames in both directions without translating them.

### Server → client

```jsonc
// once, first, and again on every reconnect
{ "type": "init",
  "clientId": "3f2c…", "name": "Ann", "colorIndex": 1,
  "seed":   { /* survey schema, opaque */ },
  "values": { "q1": "answer" },
  "peers":  [ { "clientId": "…", "name": "Bob", "colorIndex": 2, "state": { } } ] }

{ "type": "value", "from": "3f2c…", "key": "q1", "value": 42 }   // to everyone but the author
{ "type": "peer",  "peer": { "clientId": "…", "name": "…", "colorIndex": 2, "state": { } }, "retain": true }
{ "type": "peer-left", "clientId": "3f2c…" }
```

`init` is **one** frame rather than three (identity, then state, then roster) so that a
peer's edit cannot land between them and be erased by a state that does not contain it
yet. `seed` and the identity triple `clientId`/`name`/`colorIndex` are for the host; the
plugin reads `values` and `peers` and ignores the rest.

### Client → server

```jsonc
{ "type": "value", "key": "q1", "value": 42 }
{ "type": "presence", "state": { /* opaque */ }, "retain": true }
```

The server stores the value under the key (replacing whatever was there) and relays it
to everyone else. It never echoes a message back to its author.

### Guards

| Guard | Value | Why |
| --- | --- | --- |
| frame size, checked **before** `JSON.parse` | 17 MiB | a 20 MiB parse is itself the attack |
| `ws` `maxPayload` | 20 MiB | anything larger closes the socket (code 1009) |
| presence frame | 4096 bytes | presence is small by construction |
| presence rate | 50/s, burst 100 | a token bucket per client |

The size limits form one chain whose order must hold, and a test asserts it numerically:

```
MAX_FILE_BYTES × 4/3  <  MAX_VALUE_CHARS  <  MAX_FRAME_BYTES
      13.4 MiB        <      16 MiB       <      20 MiB
```

The left-hand term is a file question left on survey-core's `storeDataAsText: true`,
where the file's own base64 *is* the answer.

## Presence

An optional extension. A server that does not implement it interoperates unchanged —
its frames simply never arrive, and unknown types are ignored anyway.

- **Ephemeral.** Presence never becomes part of the room state.
- **Opaque.** The state is produced and consumed by the plugin; the server does not
  look inside it.
- **Identity lives in the envelope, not the state.** The server stamps `clientId`,
  `name` and `colorIndex` onto every relayed entry. That is what keeps the state
  portable and makes a reconnect self-healing.
- **Colours are a slot number, never a colour.** The server assigns the lowest slot
  not held by another client in the room — stable and collision-free per room, and a
  leaver's slot is reusable — but it never resolves that slot to a colour. The palette
  belongs to the client theme (survey-core's `--sjs2-color-utility-user-bg-color-N`
  and its paired `-fg-on-color-N`), which is the only thing that knows whether the
  page is light or dark and what stays legible on it.

  A server that stamped a hex would be a second palette indexed by the same number, and
  the same person would come out one colour on their avatar and another on their focus
  ring. **Slot 0 is reserved** for an unknown user, so participants get `1..9`; a
  client that receives no `colorIndex` derives one by hashing `clientId` into the same
  range.
- **Full state, never diffs.** Any single frame fully re-establishes a participant.

`retain` (default `true`) decides two things:

| | `retain: true` | `retain: false` |
| --- | --- | --- |
| carries | page, focused question | the above plus the mouse cursor path |
| stored by the server | yes — replayed in the next `init` | no |
| may be dropped | never | yes, for a peer whose send buffer is congested |

The droppable half is the hand-rolled equivalent of socket.io's `volatile`, which raw
WebSocket does not provide. Losing a cursor frame is invisible: every packet is a
self-contained path segment and the receiver replays it ~100 ms behind, interpolating.

**Colours** come from a fixed palette: the lowest slot not held by another client in
the room, wrapping with modulo. A leaver's slot is reusable. The client's own colour
arrives in `init`; peers' colours ride every envelope, so no client needs the palette.

## Room lifecycle

Created by `POST /api/rooms` or on first connect. When the last client leaves, a
**grace period** starts (`EMPTY_ROOM_TTL_MS`, default 2000 ms); if nobody reconnects
before it elapses, the room and its stored files are deleted.

The grace is not decoration. A room has to survive its last socket blipping — a
reconnect, a development-mode double mount, a 200 ms network drop. Pruning on the spot
loses the schema the creator registered, and the next connect silently re-creates the
room with the default survey.

## Ordering and consistency

1. **Per-room total order.** All clients observe values in the order the server stored
   them. Handle a room's messages sequentially.
2. **Nothing before `init`.** A client receives no `value` or `peer` frame before its
   own `init`. Registering the client and sending `init` in the same synchronous step
   gives this for free. State and roster need no separate guarantee — they are inside
   `init`.
3. **No echo.** Never send a client its own message back.

Nothing else is required: conflict resolution is entirely client-side.

## Keepalive and reconnect

The server pings each socket every 30 s and terminates one that does not answer, which
produces the same `peer-left` a clean close would. A browser answers pings at the
WebSocket layer even in a throttled background tab, so clients do **not** run their own
staleness sweep — a JS-timer sweep would wrongly drop an idle observer.

The server does not resume sessions: a reconnect gets a new client id and a new colour.
The `init` that follows is **authoritative** — it replaces the local values, including
erasing keys it does not carry. **Edits made while disconnected are lost.** That is a
deliberate choice, not an oversight: an outbox would need a merge policy for the case
where the same question changed on both sides.

## File storage (a demo extension, outside the relay protocol)

| Method | Path |
| --- | --- |
| `POST` | `/api/rooms/{id}/files?name={fileName}` — raw body, ≤ 10 MiB, `404` if the room does not exist, `413` over the 50 MiB per-room budget → `201 {url}` |
| `GET` | `/api/rooms/{id}/files/{fileId}` |
| `DELETE` | `/api/rooms/{id}/files/{fileId}` → `200 {ok:true}` |

An upload deliberately does **not** create the room: a room nobody joined would have
nobody to clean it up. Served files carry `X-Content-Type-Options: nosniff` and
`Content-Security-Policy: default-src 'none'`, and only png/jpeg/gif/webp/bmp are
served inline — **`image/svg+xml` is excluded on purpose**, because an inline SVG is
same-origin script. Blobs die with the room.

This is not part of the collaboration protocol and does not involve the plugin: it is
survey-core's own `onUploadFiles`/`onClearFiles` pointed at an endpoint of this app.

## Static serving (optional)

The reference server also hosts the lobby at `/` and the built clients at `/react/`,
`/js/`, `/vue/` and `/angular/`. A production server may host the UI anywhere; only
`/api/*` and `/ws/*` are the protocol surface.
