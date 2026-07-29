<template>
  <div class="sv-participants-bar" :style="barStyle">
    <div v-if="props.model.roomId" :style="{ color: '#555' }">
      Room:
      <strong data-testid="room-id">{{ props.model.roomId }}</strong>
    </div>
    <div :style="{ flex: 1 }" />
    <div
      data-testid="participants"
      role="list"
      aria-label="Participants"
      :style="{ display: 'flex', alignItems: 'center', paddingRight: '3px' }"
    >
      <div
        v-for="(chip, index) in props.model.chips"
        :key="chip.id"
        role="listitem"
        :title="chip.title"
        :style="{ display: 'inline-flex' }"
      >
        <span :style="chipCircleStyle(chip.color, index + 1)">{{
          chip.initials
        }}</span>
        <span :style="visuallyHidden">{{ chip.title }}</span>
      </div>
      <div
        v-if="props.model.overflowCount > 0"
        role="listitem"
        :title="props.model.overflowTitle"
        :style="{ display: 'inline-flex' }"
      >
        <span
          :style="chipCircleStyle('#909090', props.model.chips.length + 1)"
          >+{{ props.model.overflowCount }}</span
        >
        <span :style="visuallyHidden">{{ props.model.overflowTitle }}</span>
      </div>
    </div>
    <button
      v-if="props.model.showInvite"
      type="button"
      data-testid="copy-link"
      aria-label="Copy invite link"
      :style="inviteStyle"
      @click="props.model.copyInviteLink()"
    >
      {{ props.model.inviteCaption }}
    </button>
  </div>
</template>

<script lang="ts" setup>
import { useBase } from "survey-vue3-ui";
import type { CSSProperties } from "vue";
import type { ParticipantsBarModel } from "../../../shared/participantsBar";

const props = defineProps<{
  model: ParticipantsBarModel;
}>();

useBase(() => props.model);

// Inline styles (no SCSS): the bar ships with the collab tooling and must not
// depend on the survey theme pipeline. Mirrors shared/participantsBarView.
const barBg = "#f5f5f5";
const barStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "12px",
  padding: "8px 12px",
  background: barBg,
  borderBottom: "1px solid #d4d4d4",
  // Open Sans matches the survey theme below the bar; as app chrome the bar
  // no longer inherits the theme font from the survey.
  fontFamily: "Open Sans, sans-serif",
  fontSize: "14px",
};
const visuallyHidden: CSSProperties = {
  position: "absolute",
  width: "1px",
  height: "1px",
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};
const inviteStyle: CSSProperties = {
  border: "none",
  borderRadius: "8px",
  padding: "8px 12px",
  background: "#19b394",
  color: "#fff",
  fontWeight: 600,
  cursor: "pointer",
};

function chipCircleStyle(background: string, zIndex: number): CSSProperties {
  return {
    width: "28px",
    height: "28px",
    borderRadius: "50%",
    boxSizing: "border-box",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#fff",
    fontSize: "12px",
    fontWeight: 600,
    background,
    boxShadow: "0 0 0 2px " + barBg,
    marginRight: "-3px",
    position: "relative",
    zIndex,
  };
}
</script>
