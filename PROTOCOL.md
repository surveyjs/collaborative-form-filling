# Collaborative Form Filling Protocol

This document describes the server protocol used by the SurveyJS collaboration plugin. The [Node.js server](server/src) is a reference implementation with no SurveyJS dependency and can be ported to other languages.

## Room State

Each room holds a form definition (`seed`), the latest answer for each key (`values`), and its connected clients. The server sends this snapshot to new participants, then stores and forwards answer changes as they arrive.

The server treats the form definition, answer keys, and values as data it does not interpret. It uses each key only to store and retrieve a value; it does not match keys against the form definition. For each key, the last value received replaces the previous one.

## Create or Find a Room

Clients choose a room ID and can create a room through HTTP before connecting. The server assigns a separate client ID to each WebSocket connection.

| Identifier | Rules |
| --- | --- |
| Room ID | Must match `^[A-Za-z0-9_-]{1,64}$`. Invalid IDs receive HTTP `400` or a refused WebSocket upgrade. |
| Client ID | Assigned by the server for each connection. Reconnecting creates a new ID. |
| Display name | Read from `?name=`, trimmed, and limited to 32 Unicode code points. Empty names become `Anonymous`. |

The HTTP API lets clients check whether a room exists or create one with a custom form:

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/health` | `200 {"ok":true}` |
| `GET` | `/api/rooms/{id}` | `200 {roomId, exists:true, participantCount}`, `404 {exists:false}`, or `400` for an invalid ID |
| `POST` | `/api/rooms` | `201 {roomId}`, `409` if the room exists, or `400` for an invalid request |

To create a room, send `{ roomId, surveyJson? }`. If provided, `surveyJson` must be a plain object; the server does not validate its contents. Otherwise, the server uses its default form definition.

A room's form definition is fixed at creation. A `409` response leaves the existing definition unchanged, and the client can join that room.

## Connect and Exchange Messages

Connect to `ws(s)://host/ws/rooms/{roomId}?name={displayName}`. Each connection represents one participant in one room. If the room does not exist, the server creates it with the default form definition.

Each message is a JSON object. Message types match the collaboration plugin's API, so clients can forward messages without translating them. Both sides must silently ignore unknown message types and unknown fields within known messages.

### Initial State

The server sends `init` first on every connection, including reconnects:

```json
{
  "type": "init",
  "clientId": "client-1",
  "name": "Ann",
  "colorIndex": 1,
  "seed": {},
  "values": { "q1": "answer" },
  "peers": [
    { "clientId": "client-2", "name": "Bob", "colorIndex": 2, "state": {} }
  ]
}
```

This message combines the client's identity, form definition, current answers, and peer roster. Send it as one message before any answer or presence updates, so an update cannot arrive before the snapshot and then be overwritten by it.

### Answer Changes

When an answer changes, the client sends:

```json
{ "type": "value", "key": "q1", "value": 42 }
```

The server replaces the stored value for that key and forwards the change to every other participant:

```json
{ "type": "value", "from": "client-1", "key": "q1", "value": 42 }
```

Process each room's messages sequentially and forward changes in the order they are stored. Never echo a message to its sender.

The server adds `from` to identify the author for client-side change history. It does not store authorship with the answer or use it to resolve conflicts. If `from` is omitted, clients can still apply the change but cannot identify its author.

Change history is optional and stays on the client. It starts empty and is cleared by each `init`, so it covers only edits seen during the current connection. The server keeps the latest values, not an edit log.

### Presence

Presence is optional. A server can omit it and still support shared answers. A client sends its full presence state, not a partial update:

```json
{ "type": "presence", "state": {}, "retain": true }
```

The server does not interpret `state`. It adds the participant's identity and forwards a `peer` message to the other clients:

```json
{
  "type": "peer",
  "peer": { "clientId": "client-1", "name": "Ann", "colorIndex": 1, "state": {} },
  "retain": true
}
```

The `retain` field defaults to `true`. It controls whether the server keeps the presence state for new participants and whether it can skip delivery to a client with a congested send buffer:

| Behavior | `retain: true` | `retain: false` |
| --- | --- | --- |
| Typical content | Current page and focused question | Page, focused question, and cursor path |
| Included in later `init` messages | Yes | No |
| May be dropped when the send buffer is congested | No | Yes |

Presence is separate from answer data and lasts only while the participant is connected. When that participant leaves, the server removes their presence and notifies the others:

```json
{ "type": "peer-left", "clientId": "client-1" }
```

For participant colors, the server assigns the lowest available slot and reuses slots when participants leave. It sends `colorIndex` in the range `1..9`, wrapping larger slot numbers into that range. Slot `0` is reserved for unknown users.

Clients use their theme to turn this index into a color. If no index is provided, they derive one by hashing `clientId` into the same range.

## Disconnect and Reconnect

The server pings each socket every 30 seconds and terminates connections that do not respond. A terminated connection produces the same `peer-left` message as a normal close. Browsers answer these pings at the WebSocket layer, so clients do not need a separate timer to detect inactive peers.

A reconnect creates a new client identity and assigns a color slot again. The new `init` replaces all local answers, including removing keys absent from the snapshot. Edits made while disconnected are lost.

When the last participant leaves, the server starts a grace period controlled by `EMPTY_ROOM_TTL_MS` (default: 2000 milliseconds). If nobody reconnects before it expires, the server deletes the room and its files. This delay preserves the room during brief connection drops.

## Message Limits

The reference server applies these limits before processing messages:

| Limit | Value | Behavior |
| --- | --- | --- |
| Message size before JSON parsing | 17 MiB | Drop larger messages without parsing them |
| WebSocket payload size | 20 MiB | Close the connection with code `1009` if exceeded |
| Presence message size | 4096 bytes | Drop larger presence messages |
| Presence rate per client | 50 per second, burst of 100 | Use a token bucket and drop messages when no tokens remain |

The 17 MiB message limit leaves room for a 16 MiB serialized answer and its message fields. This supports file questions that store file contents as Base64 answers: a 10 MiB file expands to about 13.4 MiB. Allow for this expansion when adjusting the limits.

## File Storage Extension

File uploads are a demo extension, separate from the collaboration protocol. The app connects SurveyJS's `onUploadFiles` and `onClearFiles` events to these endpoints:

| Method | Path | Response |
| --- | --- | --- |
| `POST` | `/api/rooms/{id}/files?name={fileName}` | `201 {url}`; `404` if the room does not exist; `413` if a size limit is exceeded |
| `GET` | `/api/rooms/{id}/files/{fileId}` | Stored file |
| `DELETE` | `/api/rooms/{id}/files/{fileId}` | `200 {ok:true}` |

Uploads use a raw request body, with a limit of 10 MiB per file and 50 MiB per room. An upload does not create a room, and files are deleted with their room.

Served files include `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'`. Only PNG, JPEG, GIF, WebP, and BMP files are served inline; SVG files are excluded because they can execute scripts.
