import { useEffect, useState } from "react";
import { Model } from "survey-core";
import { CollaborationPlugin } from "survey-core/collaboration";
import { Survey } from "survey-react-ui";
import "survey-core/survey-core.min.css";
import "survey-core/collaboration.css";
import "../../../shared/customComponents";
import { attachFileSync } from "../../../shared/fileSync";
import {
  connectCollab,
  getRoomFromUrl,
  lobbyJoinUrl,
  type ICollabConnection,
} from "../../../shared/collab-client";

/**
 * The client hosts no join form: the lobby (served at "/") collects the framework,
 * name and room, then navigates here with ?room=<id>&name=<n>. Without a room there
 * is nothing to render - go back to the lobby.
 *
 * All the collaboration there is lives in the plugin: this component creates the
 * model from the schema the server sends, registers the plugin on it, and renders.
 * The transport is `connectCollab`, which forwards frames both ways without
 * translating them.
 */
export function App() {
  const [survey, setSurvey] = useState<Model | null>(null);
  const { roomId, name } = getRoomFromUrl();

  useEffect(() => {
    if (!roomId) {
      window.location.href = "../";
      return;
    }
    let connection: ICollabConnection | null = null;
    connection = connectCollab({
      roomId,
      name,
      // Called once, on the first init: the schema arrives from the server, so the
      // model cannot be built any earlier. A reconnect reuses what this returned.
      createSurvey: (seed: any) => {
        const model = new Model(seed);
        // Not collaboration: survey-core's own file hooks pointed at this app's
        // blob endpoint. Attached before any value arrives, so a file question is
        // already normalized when the room snapshot lands on it.
        attachFileSync({ survey: model, roomId });
        // lazyRenderEnabled is not a serialized survey property (survey-core drops it
        // from JSON), but it matters for large collaborative forms - honour it from
        // the room schema explicitly.
        // App layout, not collaboration: make the FORM the scroller rather than the page.
        // position:sticky binds to the nearest scrolling ancestor, and survey-core always
        // wraps its content in .sv-scroll__scroller (overflow:auto). When the page scrolls
        // instead, that wrapper never moves, so nothing inside the form can stick - which
        // is equally true of survey-core's own top progress bar. Giving the form a definite
        // height hands scrolling to it and keeps the collaboration strip pinned.
        model.fitToContainer = true;
        if (seed && seed.lazyRenderEnabled === true) model.lazyRenderEnabled = true;
        const collab = new CollaborationPlugin(model, {
          info: [{ label: "Room", value: roomId }, { label: "Framework", value: "React" }],
          getInviteLink: () => lobbyJoinUrl(roomId),
        });
        setSurvey(model);
        return collab;
      },
    });
    return () => connection?.dispose();
  }, [roomId, name]);

  if (!roomId) return null;
  return survey ? <Survey model={survey} /> : <p>Connecting to the room…</p>;
}
