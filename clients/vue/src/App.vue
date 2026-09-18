<template>
  <SurveyComponent v-if="survey" :model="survey" />
  <p v-else>Connecting to the room…</p>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, shallowRef } from "vue";
import { Model } from "survey-core";
import { CollaborationPlugin } from "survey-core/collaboration";
import { SurveyComponent } from "survey-vue3-ui";
import "survey-core/survey-core.min.css";
import "survey-core/collaboration.css";
import "../../../shared/customComponents";
import { attachFileSync } from "../../../shared/fileSync";
import { connectCollab, getRoomFromUrl, lobbyJoinUrl } from "../../../shared/collab-client";
import type { ICollabConnection } from "../../../shared/collab-client";

// The lobby (served at "/") navigates here with ?room=<id>&name=<n>.
// Without a room there is nothing to render — go back to the lobby.
const { roomId, name } = getRoomFromUrl();
if (!roomId) window.location.href = "../";

// shallowRef: the survey model manages its own reactivity — wrapping it in a deep
// Vue proxy would break survey-core's identity checks.
const survey = shallowRef<Model | null>(null);
let connection: ICollabConnection | null = null;

onMounted(() => {
  if (!roomId) return;
  connection = connectCollab({
    roomId,
    name,
    // Called once, on the first init: the schema comes from the server, so the model
    // cannot be built any earlier. A reconnect reuses what this returned.
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
        info: [{ label: "Room", value: roomId }, { label: "Framework", value: "Vue 3" }],
        getInviteLink: () => lobbyJoinUrl(roomId),
      });
      survey.value = model;
      return collab;
    },
  });
});
onUnmounted(() => {
  connection?.dispose();
  connection = null;
});
</script>
