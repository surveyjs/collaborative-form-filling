import { Model } from "survey-core";
import { CollaborationPlugin } from "survey-core/collaboration";
import { renderSurvey } from "survey-js-ui";
import "survey-core/survey-core.min.css";
import "survey-core/collaboration.css";
import "../../../shared/customComponents";
import { attachFileSync } from "../../../shared/fileSync";
import { connectCollab, getRoomFromUrl, lobbyJoinUrl } from "../../../shared/collab-client";

// The lobby (served at "/") navigates here with ?room=<id>&name=<n>.
// Without a room there is nothing to render - go back to the lobby.
const { roomId, name } = getRoomFromUrl();
if (!roomId) {
  window.location.href = "../";
} else {
  const root = document.getElementById("root")!;
  connectCollab({
    roomId,
    name,
    // Called once, on the first init: the schema comes from the server, so the model
    // cannot be built any earlier. A reconnect reuses what this returned.
    createSurvey: (seed: any) => {
      const survey = new Model(seed);
      // Not collaboration: survey-core's own file hooks pointed at this app's
      // blob endpoint. Attached before any value arrives, so a file question is
      // already normalized when the room snapshot lands on it.
      attachFileSync({ survey, roomId });
      // App layout, not collaboration: make the FORM the scroller rather than the page.
      // position:sticky binds to the nearest scrolling ancestor, and survey-core always
      // wraps its content in .sv-scroll__scroller (overflow:auto). When the page scrolls
      // instead, that wrapper never moves, so nothing inside the form can stick - which
      // is equally true of survey-core's own top progress bar. Giving the form a definite
      // height hands scrolling to it and keeps the collaboration strip pinned.
      survey.fitToContainer = true;
      if (seed && seed.lazyRenderEnabled === true) survey.lazyRenderEnabled = true;
      const collab = new CollaborationPlugin(survey, {
        info: [{ label: "Room", value: roomId }, { label: "Framework", value: "Plain JS" }],
        getInviteLink: () => lobbyJoinUrl(roomId),
      });
      root.replaceChildren();
      renderSurvey(survey, root);
      return collab;
    },
  });
}
