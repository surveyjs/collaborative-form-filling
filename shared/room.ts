import { Model } from "survey-core";
import type { Participant, RoomStatePayload } from "./events";
import { ParticipantsBarModel } from "./participantsBar";
import type { AppSocket } from "./socket";
import { attachSurveySync } from "./sync";
import { attachPresence } from "./presenceSync";
// Separate import type: the Angular client builds with a TS version that
// predates inline `type` modifiers in named imports.
import type { PresenceHandle } from "./presenceSync";

export interface ConnectRoomOptions {
  socket: AppSocket;
  roomId: string;
  name: string;
  /**
   * Called with a freshly initialized survey model and participants-bar model
   * on every (re)join — sync and presence are already attached, and the bar
   * already receives roster updates. The host renders the survey with its
   * framework's Survey component and the bar ABOVE it with its framework's
   * participants-bar view; both previous models are disposed by then.
   */
  onSurvey: (model: Model, bar: ParticipantsBarModel) => void;
  /** Invite link for the participants bar; omitted -> button hidden. */
  getInviteLink?: () => string;
}

/**
 * Framework-agnostic wiring of a socket + room into a live collaborative
 * survey: answer sync, presence (focus rings/cursors) and the participants
 * bar model (shared/participantsBar; the host renders it above the survey
 * with its framework's view). Returns a detach function.
 */
export function connectRoom({ socket, roomId, name, onSurvey, getInviteLink }: ConnectRoomOptions): () => void {
  // Live roster mirror so presence can resolve peer name/color without
  // re-attaching on every participants change.
  let participants: Participant[] = [];
  let detachSync: (() => void) | null = null;
  let presence: PresenceHandle | null = null;
  let bar: ParticipantsBarModel | null = null;

  const updateParticipants = (updater: (prev: Participant[]) => Participant[]) => {
    participants = updater(participants);
    bar?.setParticipants(participants);
  };

  const onRoomState = (state: RoomStatePayload) => {
    const model = new Model(state.surveyJson);
    // `lazyRenderEnabled` is not a serialized survey property (survey-core
    // ignores it in JSON), but lazy rendering matters for large collaborative
    // surveys — honor the flag from the room schema explicitly.
    if ((state.surveyJson as { lazyRenderEnabled?: boolean }).lazyRenderEnabled === true) {
      model.lazyRenderEnabled = true;
    }
    model.data = state.data;

    // Tear down any previous sync (e.g. on reconnect) before re-attaching.
    detachSync?.();
    detachSync = attachSurveySync({ survey: model, socket, roomId });
    presence?.detach();
    presence = attachPresence({
      survey: model,
      socket,
      roomId,
      selfId: state.selfId,
      initialParticipants: state.participants,
      getParticipant: (id) => participants.find((p) => p.id === id),
    });

    bar?.dispose();
    bar = new ParticipantsBarModel({
      roomId,
      selfId: state.selfId,
      getInviteLink,
      // Late-bound so the click always targets the current presence session.
      onChipClick: (id) => presence?.goToParticipant(id),
    });

    updateParticipants(() => state.participants);
    onSurvey(model, bar);
  };

  const onJoined = ({ participant }: { participant: Participant }) =>
    updateParticipants((prev) =>
      prev.some((p) => p.id === participant.id) ? prev : [...prev, participant],
    );

  const onLeft = ({ id }: { id: string }) =>
    updateParticipants((prev) => prev.filter((p) => p.id !== id));

  socket.on("room-state", onRoomState);
  socket.on("participant-joined", onJoined);
  socket.on("participant-left", onLeft);

  socket.emit("join-room", { roomId, name });

  return () => {
    socket.off("room-state", onRoomState);
    socket.off("participant-joined", onJoined);
    socket.off("participant-left", onLeft);
    detachSync?.();
    detachSync = null;
    presence?.detach();
    presence = null;
    bar?.dispose();
    bar = null;
  };
}

/** Room/name from the URL the lobby navigated to: /<fw>/?room=<id>&name=<n>. */
export function getRoomFromUrl(): { roomId: string; name: string } {
  const params = new URLSearchParams(window.location.search);
  return {
    roomId: (params.get("room") ?? "").trim(),
    name: (params.get("name") ?? "").trim() || "Anonymous",
  };
}

/** Shareable lobby URL that pre-fills the join form with this room. */
export function lobbyJoinUrl(roomId: string): string {
  const url = new URL("../", window.location.href);
  url.searchParams.set("room", roomId);
  return url.toString();
}
