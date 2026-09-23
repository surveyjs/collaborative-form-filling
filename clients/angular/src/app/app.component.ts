import { Component, OnDestroy, OnInit } from "@angular/core";
import { Model } from "survey-core";
import { CollaborationPlugin } from "survey-core/collaboration";
import "../../../../shared/customComponents";
import { attachFileSync } from "../../../../shared/fileSync";
import { connectCollab, getRoomFromUrl, lobbyJoinUrl } from "../../../../shared/collab-client";
// Separate type import: this client builds with a TypeScript version that predates
// inline `type` modifiers in named imports.
import type { ICollabConnection } from "../../../../shared/collab-client";

@Component({
  selector: "app-root",
  templateUrl: "./app.component.html"
})
export class AppComponent implements OnInit, OnDestroy {
  public survey: Model | null = null;
  private connection: ICollabConnection | null = null;
  // The lobby (served at "/") navigates here with ?room=<id>&name=<n>.
  private readonly params = getRoomFromUrl();

  ngOnInit(): void {
    const { roomId, name } = this.params;
    if (!roomId) {
      // Without a room there is nothing to render - go back to the lobby.
      window.location.href = "../";
      return;
    }
    this.connection = connectCollab({
      roomId,
      name,
      // Called once, on the first init: the schema comes from the server, so the
      // model cannot be built any earlier. A reconnect reuses what this returned.
      createSurvey: (seed: any) => {
        const model = new Model(seed);
        // Not collaboration: survey-core's own file hooks pointed at this app's
        // blob endpoint. Attached before any value arrives, so a file question is
        // already normalized when the room snapshot lands on it.
        attachFileSync({ survey: model, roomId });
        // App layout, not collaboration: make the FORM the scroller rather than the page.
        // position:sticky binds to the nearest scrolling ancestor, and survey-core always
        // wraps its content in .sv-scroll__scroller (overflow:auto). When the page scrolls
        // instead, that wrapper never moves, so nothing inside the form can stick - which
        // is equally true of survey-core's own top progress bar. Giving the form a definite
        // height hands scrolling to it and keeps the collaboration strip pinned.
        model.fitToContainer = true;
        if (seed && seed.lazyRenderEnabled === true) model.lazyRenderEnabled = true;
        const collab = new CollaborationPlugin(model, {
          info: [{ label: "Room", value: roomId }, { label: "Framework", value: "Angular" }],
          getInviteLink: () => lobbyJoinUrl(roomId)
        });
        this.survey = model;
        return collab;
      }
    });
  }

  ngOnDestroy(): void {
    this.connection?.dispose();
    this.connection = null;
  }
}
