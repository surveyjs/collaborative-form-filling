import { useEffect, useRef, useState } from "react";
import { Model } from "survey-core";
import { Survey } from "survey-react-ui";
import "survey-core/survey-core.min.css";
import "./customComponents";
import type {
  Participant,
  RoomStatePayload,
} from "../../shared/events";
import type { AppSocket } from "./socket";
import { attachSurveySync } from "./sync";
import { attachPresence } from "./presenceSync";
import { Presence } from "./Presence";

interface CollaborativeSurveyProps {
  socket: AppSocket;
  roomId: string;
  name: string;
  /** Custom SurveyJS schema to use if this client creates the room. */
  surveyJson?: object;
}

export function CollaborativeSurvey({ socket, roomId, name, surveyJson }: CollaborativeSurveyProps) {
  const [survey, setSurvey] = useState<Model | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [selfId, setSelfId] = useState<string | null>(null);
  const detachRef = useRef<(() => void) | null>(null);
  const detachPresenceRef = useRef<(() => void) | null>(null);
  // Live roster mirror so presence can resolve peer name/color without
  // re-attaching on every participants state change.
  const participantsRef = useRef<Participant[]>([]);

  useEffect(() => {
    const updateParticipants = (updater: (prev: Participant[]) => Participant[]) => {
      participantsRef.current = updater(participantsRef.current);
      setParticipants(participantsRef.current);
    };

    const onRoomState = (state: RoomStatePayload) => {
      const model = new Model(state.surveyJson);
      model.data = state.data;

      // Tear down any previous sync (e.g. on reconnect) before re-attaching.
      detachRef.current?.();
      detachRef.current = attachSurveySync({ survey: model, socket, roomId });
      detachPresenceRef.current?.();
      detachPresenceRef.current = attachPresence({
        survey: model,
        socket,
        roomId,
        selfId: state.selfId,
        initialParticipants: state.participants,
        getParticipant: (id) => participantsRef.current.find((p) => p.id === id),
      });

      setSelfId(state.selfId);
      updateParticipants(() => state.participants);
      setSurvey(model);
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

    socket.emit("join-room", { roomId, name, surveyJson });

    return () => {
      socket.off("room-state", onRoomState);
      socket.off("participant-joined", onJoined);
      socket.off("participant-left", onLeft);
      detachRef.current?.();
      detachRef.current = null;
      detachPresenceRef.current?.();
      detachPresenceRef.current = null;
    };
  }, [socket, roomId, name, surveyJson]);

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
      <main style={{ flex: 1, padding: "0 0 0 0", overflowY: "auto" }}>
        {survey ? (
          <Survey model={survey} />
        ) : (
          <p>Connecting to the room…</p>
        )}
      </main>
      <Presence roomId={roomId} participants={participants} selfId={selfId} />
    </div>
  );
}
