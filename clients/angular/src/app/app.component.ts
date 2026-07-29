import { Component, OnDestroy, OnInit } from "@angular/core";
import { Model } from "survey-core";
import "../../../../shared/customComponents";
import { ParticipantsBarModel } from "../../../../shared/participantsBar";
import { createSocket } from "../../../../shared/socket";
import { connectRoom, getRoomFromUrl, lobbyJoinUrl } from "../../../../shared/room";

@Component({
  selector: "app-root",
  templateUrl: "./app.component.html"
})
export class AppComponent implements OnInit, OnDestroy {
  public survey: Model | null = null;
  public bar: ParticipantsBarModel | null = null;
  private detach: (() => void) | null = null;
  // The lobby (served at "/") navigates here with ?room=<id>&name=<n>.
  private readonly params = getRoomFromUrl();

  ngOnInit(): void {
    const { roomId, name } = this.params;
    if (!roomId) {
      // Without a room there is nothing to render — go back to the lobby.
      window.location.href = "../";
      return;
    }
    this.detach = connectRoom({
      socket: createSocket(),
      roomId,
      name,
      onSurvey: (model, bar) => {
        this.survey = model;
        this.bar = bar;
      },
      getInviteLink: () => lobbyJoinUrl(roomId)
    });
  }

  ngOnDestroy(): void {
    this.detach?.();
    this.detach = null;
  }
}
