# Collaborative Form Filling by SurveyJS

A real-time collaborative survey and form filling service that allows multiple participants to complete the same form simultaneously (similar to Google Docs for document editing).

## Features

- **Shared answers** &ndash; every answer appears for all participants as it is entered.
- **Participants bar** &ndash; who is in the room, plus an **Invite** button that copies a join link.
- **Presence** &ndash; see which question each participant is in (a colored ring with their name) and where their mouse cursor is. Click an avatar to jump to that participant.
- **Change history** &ndash; the **Changes** button shows who changed which question and to what, and takes you to that question in one click.
- **File uploads** &ndash; files uploaded in one browser become available to everyone in the room.
- **Any framework** &ndash; React, Plain JS, Vue 3 and Angular clients; participants on different frameworks can share one room.
- **Custom forms** &ndash; paste your own [SurveyJS](https://surveyjs.io/) JSON schema in the lobby.

## Quick Start

```bash
npm install
npm run build:angular     # once: the Angular client is served from this build
npm run dev
```

Open [`http://localhost:3001`](http://localhost:3001) in two browser tabs, enter a name, pick a framework and join the same room id in both. The first startup may take longer while Vite optimizes dependencies.

## How It Works

- The **lobby** at `/` collects a display name, a framework, a room id and an optional custom schema, then opens the form in the chosen client.
- The **server** keeps the answers of each room and sends every change to the other participants. It knows nothing about SurveyJS; [`PROTOCOL.md`](PROTOCOL.md) describes it for anyone who wants to implement it in another language.
- If two people change the same question at the same moment, the last change wins.
- All collaboration features come from the `CollaborationPlugin` of `survey-core`. The clients themselves contain no collaboration UI.

## Using the Plugin

The plugin works with any `SurveyModel` and any transport. It gives you messages to send and accepts messages you receive:

```ts
import { Model } from "survey-core";
import { CollaborationPlugin } from "survey-core/collaboration";
import "survey-core/collaboration.css";

const survey = new Model(json);
const collab = new CollaborationPlugin(survey, {
  info: [{ label: "Room", value: roomId }],
  getInviteLink: () => inviteUrl,
});

collab.onEvent.add((_, o) => ws.send(JSON.stringify(o.message)));
ws.onmessage = (e) => collab.apply(JSON.parse(e.data));
```

In this repository that wiring, together with reconnects, is done by `connectCollab` from [`shared/collab-client.ts`](shared/collab-client.ts); see any client entry, e.g. [`clients/react/src/App.tsx`](clients/react/src/App.tsx).

| Option | Default | Description |
| --- | --- | --- |
| `info` | &ndash; | Label/value pairs shown in the participants bar, e.g. the room id |
| `getInviteLink` | &ndash; | Returns the link the **Invite** button copies; without it there is no button |
| `maxVisibleParticipants` | `8` | Avatars shown before the rest collapse into `+N` |
| `bar` | `true` | Set to `false` to hide the participants bar |
| `presence` | `true` | Set to `false` to hide participants' focus and cursors |
| `history` | `true` | Set to `false` to turn off the change history |
| `historyLimit` | `200` | How many changes the history keeps |

Call `collab.dispose()` when the form is removed from the page.

The plugin does not upload files itself: the application stores them and the plugin shares the resulting answer. Here that is [`shared/fileSync.ts`](shared/fileSync.ts).

## Working on the Plugin

The plugin lives in [survey-library](https://github.com/surveyjs/survey-library). `npm run dev` and `npm test` use a build of a sibling checkout when there is one, so changes there show up here without publishing:

```
WebstormProjects/
  survey-library/                 (branch: master)
  collaborative-form-filling/     (this repo)
```

Build it from `survey-library`:

```bash
cd packages/survey-core       && npm run build && npm run build:collaboration
cd ../survey-react-ui         && npm run build
cd ../survey-js-ui            && npm run build
cd ../survey-vue3-ui          && npm run build
```

The server log says which packages are in use. Without the build, or with `SURVEY_LIBRARY=npm`, the published npm packages are used. The Angular client always uses the npm packages.

> The published `3.1.2` packages still contain the previous version of the plugin; the version described here comes with the next release.

## Production

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
| `SURVEY_LIBRARY` | `../survey-library` | dev/test only: survey-library checkout to take the survey packages from; `npm` uses the npm packages |

## Tests

```bash
npm test                  # unit tests: server and clients
npm run test:e2e:install  # once: installs Playwright browsers
npm run test:e2e          # end-to-end tests in real browsers; requires npm run build:angular
```

The plugin's own tests are in `../survey-library/packages/survey-core/tests/collaboration/`.

## Project Structure

- [`PROTOCOL.md`](PROTOCOL.md) &ndash; the server specification.
- [`server/src/`](server/src/) &ndash; the server: [`relay.ts`](server/src/relay.ts) (WebSocket), [`roomStore.ts`](server/src/roomStore.ts) (rooms), [`protocol.ts`](server/src/protocol.ts) (message types and limits), [`index.ts`](server/src/index.ts) (HTTP and app hosting).
- [`shared/collab-client.ts`](shared/collab-client.ts) &ndash; the WebSocket connection shared by all four clients.
- [`shared/fileSync.ts`](shared/fileSync.ts), [`shared/customComponents.ts`](shared/customComponents.ts) &ndash; file uploads and custom question types.
- [`lobby/`](lobby/), [`clients/react/`](clients/react/), [`clients/js/`](clients/js/), [`clients/vue/`](clients/vue/), [`clients/angular/`](clients/angular/) &ndash; the apps.

## Limitations

This is an MVP:

- Rooms live in memory; a server restart loses them.
- There is no authentication.
- Changes made while offline are lost when the connection comes back.
- The change history covers the current connection only.

## Related Resources

- [SurveyJS Website](https://surveyjs.io/)
- [SurveyJS Documentation](https://surveyjs.io/documentation)
- [SurveyJS Form Library Demos](https://surveyjs.io/form-library/examples/overview)
- [What's New in SurveyJS](https://surveyjs.io/WhatsNew)
