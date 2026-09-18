# Collaborative Form Filling by SurveyJS

A real-time collaborative survey and form filling service that allows multiple participants to complete the same form simultaneously (similar to Google Docs for document editing).

- **Frontend** &ndash; a lobby plus four framework clients ([SurveyJS](https://surveyjs.io/) everywhere): React, Plain JS (`survey-js-ui`), Vue 3 and Angular
- **Backend** &ndash; Node + Express + a raw WebSocket relay (`ws`)
- **Storage** &ndash; In-memory rooms plus on-disk file blobs (MVP, no database or authentication)
- **survey-library** &ndash; all collaboration lives in `survey-core/collaboration`, a separate bundle of the sibling [survey-library](../survey-library) checkout; the clients consume it through `file:` dependencies

## How It Works

Collaboration is one plugin registered on a `SurveyModel`. It owns no transport:
outbound is an event, inbound is a method, and the message vocabulary is the same one
the relay speaks &mdash; so a client forwards frames both ways without translating them.

```
answer change   -> plugin.onEvent {type:"value"}    -> server: values.set(key, value)
                                                    -> {type:"value", from} to the others
                                                    -> peer: plugin.apply(...)   (echo-suppressed)
focus / page    -> plugin.onEvent {retain:true}     -> stored, replayed in the next init
mouse cursor    -> plugin.onEvent {retain:false}    -> relayed, droppable under congestion
joining         <- {type:"init", seed, values, peers} -> new Model(seed); plugin.apply(init)
```

The whole client side of a framework app is one file:

```ts
const survey = new Model(seed);
attachFileSync({ survey, roomId });                 // not collaboration - see below
const collab = new CollaborationPlugin(survey, { info, getInviteLink });
```

Everything else &mdash; the participants bar, the focus rings, the remote cursors, the
last-write-wins convergence, the rescue of half-typed text &mdash; comes with the plugin.
No client contains any collaboration markup.

- The **lobby** at `/` collects a framework, display name, room id and an optional custom survey schema, then navigates to `/{framework}/?room=<id>&name=<name>`. A custom schema is registered first via `POST /api/rooms`.
- The **relay** ([`PROTOCOL.md`](PROTOCOL.md)) stores an opaque `key -> value` map per room and fans changes out. It has **no SurveyJS dependency** and is meant to be portable to another language.
- Conflicts resolve as last-write-wins per key. There is no CRDT and no operational transform: the collaborative state of a form already is a flat map.

### What the plugin does that is easy to miss

- **Echo suppression is per question name, not a blanket flag.** survey-core writes *other* questions as a consequence of the one being applied (`clearInvisibleValues`, triggers); those are genuine local changes the peers must hear about, because a client that cannot re-derive the cascade would otherwise diverge in silence.
- **Half-typed text is rescued.** SurveyJS keeps a text input uncommitted until blur, so mid-typing the characters live only in the DOM &mdash; and the re-render that applying a peer's answer causes would overwrite them. The plugin commits the focused editor first.
- **`init` is authoritative.** It replaces the local values, erasing keys it does not carry. Edits made while disconnected are lost; see `PROTOCOL.md`.

### Presence

The participants bar, the focus rings with name badges and the remote cursors are all
drawn by the plugin. The bar reaches the screen through survey-core's existing layout
slot (`addLayoutElement` into `contentTop`, rendered by the action bar the library
already ships), so it needs no component in any UI package.

Cursors are sampled, downsampled to three points per packet, anchored to a question's
box as fractions, and replayed ~100 ms behind with spline interpolation &mdash; so they
glide, and a dropped packet is invisible.

### What is deliberately NOT in the plugin

File uploads. [`shared/fileSync.ts`](shared/fileSync.ts) only wires survey-core's own
`onUploadFiles`/`onClearFiles` to this app's blob endpoint and clamps `maxSize`; it
touches no socket and applies nothing remote. It is ordinary application code, so it
stays here &mdash; every client calls `attachFileSync` alongside the plugin.

## Setup

The clients build against the **sibling `survey-library` checkout**, not the npm
packages: `survey-core/collaboration` is not published yet. Expected layout:

```
WebstormProjects/
  survey-library/                 (branch: collaboration-plugin)
  collaborative-form-filling/     (this repo)
```

Build the library packages once (from `survey-library`), in dependency order:

```bash
cd packages/survey-core       && npm run build && npm run build:collaboration
cd ../survey-react-ui         && npm run build
cd ../survey-js-ui            && npm run build
cd ../survey-vue3-ui          && npm run build
cd ../survey-angular-ui       && npm run build
```

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

## Tests

```bash
npm test
npm run test:e2e
```

- `npm test` &ndash; Vitest for the relay, the room store, the HTTP endpoints, the protocol constants and the file store, plus the client-side transport and the consumer-side render canary.
- `npm run test:e2e` &ndash; Playwright: co-editing, custom schemas, presence and a cross-framework suite where each client co-edits with a React peer. Requires `npm run build:angular`.

Plugin-level coverage lives with the plugin, in
`../survey-library/packages/survey-core/tests/collaboration/`.

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
