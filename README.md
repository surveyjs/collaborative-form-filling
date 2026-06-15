# survey-collaboration

A real-time **collaborative survey filling** service — multiple participants
fill out the same questionnaire simultaneously (the Google Docs model for forms).

- **Frontend:** React + TypeScript + [SurveyJS](https://surveyjs.io/) (`survey-core`, `survey-react-ui`), Vite
- **Backend:** Node + Express + Socket.IO
- **Storage:** in-memory (MVP, no database or authentication)

## How it works

Participants join a *room* by its identifier. The server keeps the survey schema and
current answers in memory. Every value change (`onValueChanged` in SurveyJS) is broadcast
to the others over Socket.IO and applied to their models via `survey.setValue`. The echo
loop is broken by the `applyingRemote` flag (see [packages/client/src/sync.ts](packages/client/src/sync.ts)).
Conflicts are resolved last-write-wins at the level of an individual question.

The Express server serves the client and Socket.IO from a **single port** in both
dev and prod. In dev, Vite runs in middleware mode (with HMR over the same HTTP
server); in prod, the server serves the built static assets from `client/dist`
with an SPA fallback. See [packages/server/src/index.ts](packages/server/src/index.ts).

## Running

### Development

```bash
npm install
npm run dev
```

Everything is served from http://localhost:3001 (the first start is slower while
Vite optimizes dependencies). Open two tabs with the same room identifier and
fill out the survey together.

### Production

```bash
npm run build   # builds both server (tsc) and client (vite build)
npm start       # serves the built client + Socket.IO on http://localhost:3001
```

Set `PORT` to override the default `3001`.

## Tests

```bash
npm test            # unit (Vitest): server/RoomManager + sockets, client/sync
npm run test:e2e    # e2e (Playwright): collaborative editing across two contexts
```

Before the first e2e run, install the browsers: `npm run test:e2e:install`.

## Structure

```
packages/shared/events.ts            Socket.IO event types (shared by client and server)
packages/server/src/RoomManager.ts   in-memory rooms, participants, last-write-wins
packages/server/src/index.ts         Express + Socket.IO handlers; serves the client (Vite middleware in dev, static in prod)
packages/client/src/sync.ts          bidirectional SurveyJS <-> socket sync (core)
packages/client/src/CollaborativeSurvey.tsx  room + survey rendering
```
