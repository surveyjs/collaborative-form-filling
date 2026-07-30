# Collaborative Form Filling by SurveyJS

A real-time collaborative survey and form filling service that allows multiple participants to complete the same form simultaneously (similar to Google Docs for for document editing).

- **Frontend** &ndash; a lobby plus four framework clients ([SurveyJS](https://surveyjs.io/) everywhere): React, Plain JS (`survey-js-ui`), Vue 3 and Angular
- **Backend** &ndash; Node + Express + Socket.IO
- **Storage** &ndash; In-memory (MVP, no database or authentication)
- **survey-library** &ndash; all clients consume the sibling `survey-library` build (`file:` dependencies on its `packages/*/build`); all collaboration code (including the participants bar) lives in this repo

## How It Works

- The repository mirrors the layout of [collaborative-form-editing](https://github.com/surveyjs/collaborative-form-editing): `lobby/` + `clients/{react,js,vue,angular}/` + `server/` + `shared/`.
- The **lobby** at `/` collects a framework (image picker), display name, room id and an optional custom survey schema, then navigates to `/{framework}/?room=<id>&name=<name>`. A custom schema is registered first via `POST /api/rooms`.
- Each **client** (`/react/`, `/js/`, `/vue/`, `/angular/`) reads the room and name from the URL and joins over Socket.IO; without `?room=` it redirects back to the lobby.
- The server stores the survey schema and current responses in memory.
- When a participant changes a value, the [`onValueChanged`](https://surveyjs.io/form-library/documentation/api-reference/survey-data-model#onValueChanged) event in SurveyJS is triggered, and the update is broadcast to other participants via Socket.IO.
- Clients apply incoming updates using [`survey.setValue()`](https://surveyjs.io/form-library/documentation/api-reference/survey-data-model#setValue).
- An `applyingRemote` flag prevents update loops (see [`shared/sync.ts`](shared/sync.ts)).
- Conflicts are resolved using a last-write-wins strategy at the individual question level.
- The framework-agnostic wiring (sync + presence + participants bar) lives in [`shared/room.ts`](shared/room.ts) (`connectRoom`) and is shared by all four clients.

### Presence

- The **participants bar** (room id, avatar chips of the OTHER participants — self is not shown — and an Invite button that copies the lobby join link) is app chrome rendered by each client ABOVE its Survey component: `connectRoom` hands the host a [`ParticipantsBarModel`](shared/participantsBar.ts) alongside the survey, and the host renders its framework's view of it — React and Plain JS share one [react-family view](shared/participantsBarView.ts) (survey-js-ui re-exports the survey-react-ui API on preact), Vue and Angular ship their own components (`clients/vue/src/ParticipantsBar.vue`, `clients/angular/src/app/participants-bar/`).
- Each participant's **currently focused question** is broadcast (`focus-question`) and shown to others as a colored ring with a name badge around the question. The focus is stored per participant on the server, so late joiners see it immediately.
- Each participant's **mouse cursor** is broadcast (`cursor-moved`) as a colored arrow with a name label. Positions are anchored to the hovered question — or, outside question blocks, to the nearest question with fractions extrapolated beyond 0..1 — so cursors stay visible anywhere in the window and line up across differently sized windows. Cursor packets are ephemeral: throttled on the client, relayed as volatile, and never stored.
- See [`shared/presenceSync.ts`](shared/presenceSync.ts) for capture and rendering details.

## Server Setup

- The Express server hosts the lobby, all client applications, the room REST API and Socket.IO on a single port in both development and production.
- In development, the lobby and the React/JS/Vue clients run as Vite middleware instances with HMR (inline configs — see the note in `index.ts`); the Angular client is always served from its built `dist` (rebuild with `npm run build:angular`).
- In production, everything is served from the built `dist` folders with SPA fallback routing per mount.

See [`server/src/index.ts`](server/src/index.ts).

## Running

### Development

```bash
npm install
npm run install:angular   # once: the Angular client is not an npm workspace
npm run build:angular     # once (and after fork/shared changes): /angular/ serves this build
npm run dev
```

The application is available at [`http://localhost:3001`](http://localhost:3001). The first startup may take longer while Vite optimizes dependencies.

To test collaboration, open the lobby in two browser tabs, pick any frameworks and join the same room identifier.

> The survey-library fork must be built first (its `packages/*/build` folders are the `file:` targets): `survey-core`, then `survey-react-ui`, `survey-js-ui`, `survey-vue3-ui`, `survey-angular-ui`. After rebuilding the fork, restart the dev server.

### Production

```bash
npm run build
npm start
```

`npm run build` compiles the server and builds the lobby and all four clients. `npm start` serves the production build and Socket.IO on [`http://localhost:3001`](http://localhost:3001).

Use the PORT environment variable to override the default port.

## Tests

```bash
npm test
npm run test:e2e
```

- `npm test` &ndash; Unit tests (Vitest) for the server, sockets, client synchronization logic, and the participants-bar model (`clients/react/src/participantsBar.test.ts` — shared-code tests run under the React client's Vitest).
- `npm run test:e2e` &ndash; End-to-end tests (Playwright): collaborative editing across browser contexts plus a cross-framework smoke suite (each client co-edits with a React peer). Requires the Angular client to be built (`npm run build:angular`).

Before running E2E tests for the first time, install Playwright browsers:

```bash
npm run test:e2e:install
```

## Project Structure

- [`shared/events.ts`](shared/events.ts) &ndash; Shared Socket.IO event definitions.
- [`server/src/index.ts`](server/src/index.ts) &ndash; Express + Socket.IO server, room REST API, lobby/client mounts.
- [`server/src/RoomManager.ts`](server/src/RoomManager.ts) &ndash; In-memory room state and conflict resolution.
- [`shared/`](shared/) &ndash; Socket.IO event contracts (`events.ts`) and framework-agnostic client logic shared by all clients: `room.ts` (connectRoom), `sync.ts`, `presenceSync.ts`, `socket.ts`, `customComponents.ts`, `participantsBar.ts` (bar model) + `participantsBarView.ts` (react-family view).
- [`lobby/`](lobby/) &ndash; The join form with the framework picker (served at `/`).
- [`clients/react/`](clients/react/) &ndash; React client (`/react/`).
- [`clients/js/`](clients/js/) &ndash; Plain JS client on `survey-js-ui` (`/js/`).
- [`clients/vue/`](clients/vue/) &ndash; Vue 3 client (`/vue/`).
- [`clients/angular/`](clients/angular/) &ndash; Angular client (`/angular/`, built statically, not an npm workspace).

<!-- ## License -->

## Related Resources

- [Collaborative Form Editing by SurveyJS](https://github.com/surveyjs/collaborative-form-editing)
- [SurveyJS Website](https://surveyjs.io/)
- [SurveyJS Documentation](https://surveyjs.io/documentation)
- [SurveyJS Form Library Demos](https://surveyjs.io/form-library/examples/overview)
- [What's New in SurveyJS](https://surveyjs.io/WhatsNew)
