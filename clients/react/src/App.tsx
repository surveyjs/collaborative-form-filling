import { useMemo } from "react";
import { createSocket } from "../../../shared/socket";
import { getRoomFromUrl } from "../../../shared/room";
import { CollaborativeSurvey } from "./CollaborativeSurvey";

/**
 * The client no longer hosts a join form: the lobby (served at "/") collects
 * the framework, name and room, then navigates here with ?room=<id>&name=<n>.
 * Without a room there is nothing to render — go back to the lobby.
 */
export function App() {
  const { roomId, name } = useMemo(getRoomFromUrl, []);
  const socket = useMemo(() => (roomId ? createSocket() : null), [roomId]);

  if (!roomId || !socket) {
    window.location.href = "../";
    return null;
  }

  return <CollaborativeSurvey socket={socket} roomId={roomId} name={name} />;
}
