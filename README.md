# Collaborative Form Filling by SurveyJS

A real-time collaborative survey and form filling service that allows multiple participants to complete the same form simultaneously (similar to Google Docs for document editing).

- **Frontend** &ndash; a lobby plus four framework clients ([SurveyJS](https://surveyjs.io/) everywhere): React, Plain JS (`survey-js-ui`), Vue 3 and Angular
- **Backend** &ndash; Node + Express + a raw WebSocket relay (`ws`)
- **Storage** &ndash; In-memory rooms plus on-disk file blobs (MVP, no database or authentication)
- **survey-library** &ndash; all collaboration lives in `survey-core/collaboration`, a separate bundle (plus `survey-core/collaboration.css`) of [survey-library](https://github.com/surveyjs/survey-library); the clients pin the published packages, and `npm run dev` / `npm test` swap in a build of the sibling [survey-library](../survey-library) checkout (see [Setup](#setup))

## How It Works

Collaboration is one plugin registered on a `SurveyModel`. It owns no transport:
outbound is an event, inbound is a method, and the message vocabulary is the same one
the relay speaks &mdash; so a client forwards frames both ways without translating them.

```
answer change   -> plugin.onEvent {type:"value", key, value} -> server: values.set(key, value)
                                                             -> {type:"value", from} to the others
                                                             -> peer: plugin.apply(...)   (echo-suppressed)
focus / page    -> plugin.onEvent {type:"presence", retain:true}  -> stored, replayed in the next init
mouse cursor    -> plugin.onEvent {type:"presence", retain:false} -> relayed, droppable under congestion
joining         <- {type:"init", seed, values, peers} -> new Model(seed); plugin.apply(init)
                                                      -> the plugin announces its own presence at once
socket state    host: plugin.apply({type:"status", status:"connecting" | "closed"})
```

`status` is not a wire frame: the host synthesizes it from the socket. There is no
`connected` status to send &mdash; receiving `init` is the proof &mdash; and `closed`
also drops every peer, so a lost connection leaves no frozen cursors behind.

The whole client side of a framework app is one callback. The schema comes from the
server, so the model is built on the first `init`, inside
[`connectCollab`](shared/collab-client.ts):

```ts
import { CollaborationPlugin } from "survey-core/collaboration";
import "survey-core/collaboration.css";                  // shipped separately from survey-core.css

connectCollab({
  roomId, name,
  createSurvey: (seed) => {
    const survey = new Model(seed);
    attachFileSync({ survey, roomId });                  // not collaboration - see below
    return new CollaborationPlugin(survey, {
      info: [{ label: "Room", value: roomId }],
      getInviteLink: () => lobbyJoinUrl(roomId),
    });
  },
});
```

`connectCollab` is nothing but the two directions of that wiring plus reconnects:

```ts
collab.onEvent.add((_, o) => ws.send(JSON.stringify(o.message)));
ws.onmessage = (e) => collab.apply(JSON.parse(e.data));
```

Everything else &mdash; the participants bar, the focus rings, the remote cursors, the
change history, the last-write-wins convergence, the rescue of half-typed text &mdash;
comes with the plugin. No client contains any collaboration markup.

- The **lobby** at `/` collects a framework, display name, room id and an optional custom survey schema, then navigates to `/{framework}/?room=<id>&name=<name>`. A custom schema is registered first via `POST /api/rooms`.
- The **relay** ([`PROTOCOL.md`](PROTOCOL.md)) stores an opaque `key -> value` map per room and fans changes out. It has **no SurveyJS dependency** and is meant to be portable to another language.
- Conflicts resolve as last-write-wins per key. There is no CRDT and no operational transform: the collaborative state of a form already is a flat map.

### Plugin API

```ts
new CollaborationPlugin(survey: SurveyModel, options?: ICollaborationOptions)
```

| Option | Default | Meaning |
| --- | --- | --- |
| `info` | &ndash; | `[{ label, value }]` rows shown at the left of the bar, e.g. the room id |
| `getInviteLink` | &ndash; | the **Invite** button copies what it returns; absent &rarr; no button |
| `maxVisibleParticipants` | `8` | avatars beyond this collapse into a `+N` dropdown |
| `onParticipantClick` | `goToParticipant` | what clicking an avatar does |
| `onHistoryToggle` | `toggleHistory` | what the **Changes** button does |
| `presence` | on | focus rings, name badges, cursors; `false` switches them off |
| `bar` | on | the participants bar; `false` switches it off |
| `history` | on | the change log and its panel; `false` switches them off |
| `presenceCoalesceMs` | `40` | at most one outgoing `presence` per window; `<= 0` sends at once |
| `historyLimit` | `200` | entries kept per connection, oldest out first |
| `historyMergeMs` | `1500` | consecutive edits of one question by one author within this window collapse |

Members:

- `onEvent` &ndash; the only outbound channel, `{ message: ICollabOut }`, where `ICollabOut` is `value | presence`.
- `apply(message: ICollabIn)` &ndash; the only inbound one: `init | value | peer | peer-left | status`. Unknown types and unknown fields are ignored, so a server can grow new frames without rewiring the apps.
- `dispose()` &ndash; safe to call twice.
- `status` (`"connecting" | "connected" | "closed"`), `isApplying`, `getSnapshot()` (the whole state in the shape `init.values` carries), `peers`, `onPeersChanged`.
- `goToParticipant(clientId)`, `goToQuestion(name)` &ndash; switch page and scroll, without focusing: focusing would steal the local caret and broadcast *our* focus. `toggleHistory()` opens or closes the changes panel.
- `data`, `presence`, `bar`, `history`, `historyPanel` &ndash; the parts; each is `undefined` when its option is off, and the members that delegate to it go quiet instead of throwing.

On the wire a key is the question's `valueName`; a comment travels under
`name + "\u0000comment"`, independent of `survey.commentSuffix`. Name and colour are not
part of a presence state: the relay stamps them onto the envelope, and it leaves the
receiver itself out of `init.peers`.

The bundle also exports the message types, `presenceInitials`, `presenceColorSlot`,
`PRESENCE_COLOR_SLOTS`, `HistoryController`, `describeValue`, `historyAuthorLabel`,
`MAX_HISTORY_TEXT` and `Version`; the collaboration bundle refuses to run against a
survey-core of a different version.

### What the plugin does that is easy to miss

- **Echo suppression is per question name, not a blanket flag.** survey-core writes *other* questions as a consequence of the one being applied (`clearInvisibleValues`, triggers); those are genuine local changes the peers must hear about, because a client that cannot re-derive the cascade would otherwise diverge in silence.
- **Half-typed text is rescued.** SurveyJS keeps a text input uncommitted until blur, so mid-typing the characters live only in the DOM &mdash; and the re-render that applying a peer's answer causes would overwrite them. The plugin commits the focused editor first. Inside a composite, a field being typed that the peer's object does not carry is written back after the apply.
- **Dynamic matrices keep their rows.** An outgoing value is padded to `rowCount`, so clearing the last cell does not delete rows on the peers, and adding or removing an empty row is synced too.
- **`init` is authoritative.** It replaces the local values, erasing keys it does not carry. Edits made while disconnected are lost; see `PROTOCOL.md`.

### Presence

The participants bar, the focus rings with name badges and the remote cursors are all
drawn by the plugin. The bar reaches the screen through survey-core's existing layout
slot (`addLayoutElement` into the `header` container, rendered by the `sv-action-bar`
the library already ships), so it needs no component in any UI package. A focus ring is
an attribute on the question's own element; cursors and badges live in one fixed layer
on `body`. Peer colours come from the theme's `--sjs2-color-utility-user-*` variables.

Cursors are sampled, downsampled to three points per packet, anchored to a question's
box as fractions, and replayed ~100 ms behind with spline interpolation &mdash; so they
glide, and a dropped packet is invisible.

### Change history

The **Changes** button in the strip opens a panel beside the form &mdash; who edited
which question, and to what, for as long as this connection lasts. While it is open
the survey container is a two-column grid, so the panel runs from under the strip to
the bottom and the form gives way instead of being covered. It stays put while the
form scrolls past it &mdash; only its list moves &mdash; which takes a measurement:
nothing in survey-core publishes the height of the sticky strip, so the panel reads
it and hands it to CSS. On a narrow screen it moves straight under the strip instead
and stops being pinned. It costs nothing on the wire &mdash; the
attribution rides on the `from` the relay already stamps onto every value it fans out.

The log is fed by the survey's own `onValueChanging`/`onValueChanged`, not by the
frames, so it records what actually changed here: a value that changes nothing locally
leaves no entry, and a cascade that applying a peer's value sets off is credited to
that peer. File and signature answers read as "changed", never as their content.
`historyLimit` and `historyMergeMs` bound and collapse the list.

The scope is the connection, not the room: the server keeps a snapshot map with no
authors in it, `init.values` carries no authorship, and every `init` clears the log.
A durable audit trail would be a different feature; see [`PROTOCOL.md`](PROTOCOL.md).

### What is deliberately NOT in the plugin

File uploads. [`shared/fileSync.ts`](shared/fileSync.ts) only wires survey-core's own
`onUploadFiles`/`onClearFiles` to this app's blob endpoint and clamps `maxSize`; it
touches no socket and applies nothing remote. It is ordinary application code, so it
stays here &mdash; every client calls `attachFileSync` alongside the plugin.

To the plugin a file answer is an ordinary value &mdash; a URL here, or base64 under
`storeDataAsText` &mdash; and it sends a value of any size as it is. The size limit
belongs to whoever owns the transport: this relay rejects an oversized `value` frame
(`MAX_SET_FRAME_BYTES`, `MAX_FRAME_BYTES` in [`server/src/protocol.ts`](server/src/protocol.ts)).

## Setup

`package.json` pins the published survey packages (`3.1.2`, which ships
`survey-core/collaboration`), so `npm install` and `npm run build` need nothing else.

> The API described above is the one on survey-library `master`. The published `3.1.2`
> still carries the previous plugin, which caps a value's size itself
> (`maxValueChars`/`onValueTooLarge`) and logs history from the wire frames; the current
> plugin reaches this repo through the local checkout below until the next release.

`npm run dev` and `npm test` instead resolve the survey packages from the **sibling
`survey-library` checkout**, so plugin work there shows up here without a publish
([`server/src/localSurvey.ts`](server/src/localSurvey.ts)). The server logs which one it
picked, e.g. `[survey] local survey-library 3.1.1 (<path>)`. Expected layout:

```
WebstormProjects/
  survey-library/                 (branch: master)
  collaborative-form-filling/     (this repo)
```

Build the library packages (from `survey-library`), in dependency order:

```bash
cd packages/survey-core       && npm run build && npm run build:collaboration
cd ../survey-react-ui         && npm run build
cd ../survey-js-ui            && npm run build
cd ../survey-vue3-ui          && npm run build
```

Without that build (or with `SURVEY_LIBRARY=npm`) dev falls back to the npm packages.
Angular is always built from npm: its dist is served as-is in both modes.

Then, here:

```bash
npm install
npm run build:angular     # once (and after shared changes): /angular/ serves this build
npm run dev
```

The application is available at [`http://localhost:3001`](http://localhost:3001). The first startup may take longer while Vite optimizes dependencies.

To test collaboration, open the lobby in two browser tabs, pick any frameworks and join the same room identifier.

### Production

```bash
npm run build
npm start
```

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3001` | HTTP + WebSocket port |
| `NODE_ENV` | `development` | `production` disables the Vite middleware |
| `EMPTY_ROOM_TTL_MS` | `2000` | grace period before an empty room is reclaimed |
| `PRESENCE_PING_MS` | `30000` | WebSocket keepalive interval |
| `SURVEY_LIBRARY` | `../survey-library` | dev/test only: survey-library checkout to resolve the survey packages from; `npm` uses the npm packages |

## Tests

```bash
npm test
npm run test:e2e
```

- `npm test` &ndash; Vitest for the relay, the HTTP endpoints, the protocol constants and the file store; on the client side, the wiring of all four entries, a single survey-core instance behind the collaboration bundle, `attachFileSync`, composite sync and the consumer-side render canary.
- `npm run test:e2e` &ndash; Playwright: co-editing, composites, custom schemas, presence and a cross-framework suite where each client co-edits with a React peer. Requires `npm run build:angular`.

Plugin-level coverage (value sync, composites, presence, the bar, history) lives with
the plugin, in `../survey-library/packages/survey-core/tests/collaboration/`.

Before running E2E tests for the first time, install Playwright browsers:

```bash
npm run test:e2e:install
```

## Project Structure

- [`PROTOCOL.md`](PROTOCOL.md) &ndash; the language-agnostic server specification.
- [`server/src/protocol.ts`](server/src/protocol.ts) &ndash; wire types and constants, zero imports.
- [`server/src/relay.ts`](server/src/relay.ts) &ndash; the WebSocket relay.
- [`server/src/roomStore.ts`](server/src/roomStore.ts) &ndash; the in-memory room model.
- [`server/src/index.ts`](server/src/index.ts) &ndash; composition plus the lobby/client hosting.
- [`shared/collab-client.ts`](shared/collab-client.ts) &ndash; the transport shared by all four clients. Zero runtime imports on purpose: each app compiles it against its own copy of survey-core.
- [`shared/fileSync.ts`](shared/fileSync.ts), [`shared/customComponents.ts`](shared/customComponents.ts) &ndash; application code, not collaboration.
- [`lobby/`](lobby/), [`clients/react/`](clients/react/), [`clients/js/`](clients/js/), [`clients/vue/`](clients/vue/), [`clients/angular/`](clients/angular/) &ndash; the apps.

## Limitations

- In-memory rooms; a restart loses them.
- No authentication: the byte ceilings are the abuse model.
- Edits made while disconnected are lost when the connection returns.

## Related Resources

- [SurveyJS Website](https://surveyjs.io/)
- [SurveyJS Documentation](https://surveyjs.io/documentation)
- [SurveyJS Form Library Demos](https://surveyjs.io/form-library/examples/overview)
- [What's New in SurveyJS](https://surveyjs.io/WhatsNew)
