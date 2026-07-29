import type { Model } from "survey-core";
import { createElement, render, renderSurvey } from "survey-js-ui";
import "survey-core/survey-core.min.css";
import "../../../shared/presenceSync.css";
import "../../../shared/customComponents";
import { createSocket } from "../../../shared/socket";
import { connectRoom, getRoomFromUrl, lobbyJoinUrl } from "../../../shared/room";
import { SurveyParticipantsBar } from "./participantsBar";

// The lobby (served at "/") navigates here with ?room=<id>&name=<n>.
// Without a room there is nothing to render — go back to the lobby.
const { roomId, name } = getRoomFromUrl();
if (!roomId) {
  window.location.href = "../";
} else {
  const root = document.getElementById("root")!;
  const socket = createSocket();
  connectRoom({
    socket,
    roomId,
    name,
    getInviteLink: () => lobbyJoinUrl(roomId),
    onSurvey: (model: Model, bar) => {
      root.replaceChildren();
      // The bar is app chrome above the survey; render both into fresh
      // containers (the previous models are already disposed by connectRoom).
      // #root is a flex column: the survey container takes the remaining
      // height and the survey scrolls inside it (fitToContainer).
      const barEl = document.createElement("div");
      const surveyEl = document.createElement("div");
      surveyEl.style.flex = "1 1 auto";
      surveyEl.style.minHeight = "0";
      root.append(barEl, surveyEl);
      render(createElement(SurveyParticipantsBar, { model: bar }), barEl);
      renderSurvey(model, surveyEl);
    },
  });
}
