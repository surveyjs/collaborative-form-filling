# Collaborative Form Filling by SurveyJS

A real-time collaborative survey filling service that allows multiple participants to complete the same questionnaire simultaneously (similar to Google Docs for forms).

- **Frontend** &ndash; React + TypeScript + [SurveyJS](https://surveyjs.io/) (`survey-core`, `survey-react-ui`), Vite
- **Backend** &ndash; Node + Express + Socket.IO
- **Storage** &ndash; In-memory (MVP, no database or authentication)

## How It Works

- Participants join a room using its identifier.
- The server stores the survey schema and current responses in memory.
- When a participant changes a value, the [`onValueChanged`](https://surveyjs.io/form-library/documentation/api-reference/survey-data-model#onValueChanged) event in SurveyJS is triggered, and the update is broadcast to other participants via Socket.IO.
- Clients apply incoming updates using [`survey.setValue()`](https://surveyjs.io/form-library/documentation/api-reference/survey-data-model#setValue).
- An `applyingRemote` flag prevents update loops (see [`packages/client/src/sync.ts`](packages/client/src/sync.ts)).
- Conflicts are resolved using a last-write-wins strategy at the individual question level.

## Server Setup

- The Express server hosts both the client application and Socket.IO on a single port in both development and production.
- In development, Vite runs in middleware mode with HMR.
- In production, the server serves the built client assets from `client/dist` and provides SPA fallback routing.

See [`packages/server/src/index.ts`](packages/server/src/index.ts).

## Running

### Development

```bash
npm install
npm run dev
```

The application is available at [`http://localhost:3001`](http://localhost:3001). The first startup may take longer while Vite optimizes dependencies.

To test collaboration, open the application in two browser tabs using the same room identifier and edit the survey simultaneously.

### Production

```bash
npm run build
npm start
```

`npm run build` compiles the server and builds the client application. `npm start` serves the production build and Socket.IO on [`http://localhost:3001`](http://localhost:3001).

Use the PORT environment variable to override the default port.

## Tests

```bash
npm test
npm run test:e2e
```

- `npm test` &ndash; Unit tests (Vitest) for the server, sockets, and client synchronization logic.
- `npm run test:e2e` &ndash; End-to-end tests (Playwright) that verify collaborative editing across two browser contexts.

Before running E2E tests for the first time, install Playwright browsers:

```bash
npm run test:e2e:install
```

## Project Structure

- [`packages/shared/events.ts`](packages/shared/events.ts) &ndash; Shared Socket.IO event definitions.
- [`packages/server/src/index.ts`](packages/server/src/index.ts) &ndash; Express and Socket.IO server.
- [`packages/server/src/RoomManager.ts`](packages/server/src/RoomManager.ts) &ndash; In-memory room state and conflict resolution.
- [`packages/client/src/CollaborativeSurvey.tsx`](packages/client/src/CollaborativeSurvey.tsx) &ndash; Room management and survey rendering.
- [`packages/client/src/sync.ts`](packages/client/src/sync.ts) &ndash; SurveyJS &harr; Socket.IO synchronization.

<!-- ## License -->

## Related Resources

- [Collaborative Form Editing by SurveyJS](https://github.com/surveyjs/collaborative-form-editing)
- [SurveyJS Website](https://surveyjs.io/)
- [SurveyJS Documentation](https://surveyjs.io/documentation)
- [SurveyJS Form Library Demos](https://surveyjs.io/form-library/examples/overview)
- [What's New in SurveyJS](https://surveyjs.io/WhatsNew)