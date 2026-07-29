<template>
  <!-- Flex column: the bar keeps its own height, the survey gets the rest
       and scrolls internally. overflow:hidden prevents a second page-level
       scrollbar of the bar's height. -->
  <main style="height: 100vh; display: flex; flex-direction: column; overflow: hidden">
    <template v-if="survey && bar">
      <ParticipantsBar :model="bar" />
      <div style="flex: 1 1 auto; min-height: 0">
        <SurveyComponent :model="survey" />
      </div>
    </template>
    <p v-else>Connecting to the room…</p>
  </main>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, shallowRef } from "vue";
import type { Model } from "survey-core";
import { SurveyComponent } from "survey-vue3-ui";
import "survey-core/survey-core.min.css";
import "../../../shared/presenceSync.css";
import "../../../shared/customComponents";
import type { ParticipantsBarModel } from "../../../shared/participantsBar";
import { createSocket } from "../../../shared/socket";
import { connectRoom, getRoomFromUrl, lobbyJoinUrl } from "../../../shared/room";
import ParticipantsBar from "./ParticipantsBar.vue";

// The lobby (served at "/") navigates here with ?room=<id>&name=<n>.
// Without a room there is nothing to render — go back to the lobby.
const { roomId, name } = getRoomFromUrl();
if (!roomId) window.location.href = "../";

// shallowRef: the survey/bar models manage their own reactivity — wrapping
// them in a deep Vue proxy would break survey-core's identity checks.
const survey = shallowRef<Model | null>(null);
const bar = shallowRef<ParticipantsBarModel | null>(null);
let detach: (() => void) | null = null;

onMounted(() => {
  if (!roomId) return;
  detach = connectRoom({
    socket: createSocket(),
    roomId,
    name,
    onSurvey: (model, barModel) => {
      survey.value = model;
      bar.value = barModel;
    },
    getInviteLink: () => lobbyJoinUrl(roomId),
  });
});
onUnmounted(() => {
  detach?.();
  detach = null;
});
</script>
