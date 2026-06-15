/**
 * Shared Socket.IO event contracts between client and server.
 * Pure type declarations — no runtime code — so both packages can import
 * this file directly via relative path (resolved by tsc and Vite).
 */

export interface Participant {
  /** socket.id of the participant */
  id: string;
  name: string;
  /** hex color assigned for presence display */
  color: string;
}

/** Survey answers keyed by question name (SurveyJS `survey.data`). */
export type SurveyData = Record<string, unknown>;

// ---- Client -> Server payloads ----

export interface JoinRoomPayload {
  roomId: string;
  name: string;
  /**
   * Optional SurveyJS schema. Applied only when the room is first created;
   * ignored if the room already exists. Falls back to the default survey.
   */
  surveyJson?: object;
}

export interface ValueChangedPayload {
  roomId: string;
  /** SurveyJS question name */
  name: string;
  value: unknown;
}

export interface FocusPayload {
  roomId: string;
  /** SurveyJS question name being focused/blurred, or null on blur */
  name: string | null;
}

// ---- Server -> Client payloads ----

export interface RoomStatePayload {
  surveyJson: object;
  data: SurveyData;
  /** the joining socket's own participant id */
  selfId: string;
  participants: Participant[];
}

export interface ParticipantJoinedPayload {
  participant: Participant;
}

export interface ParticipantLeftPayload {
  id: string;
}

export interface FocusBroadcastPayload {
  /** participant whose focus changed */
  id: string;
  /** question name being edited, or null when blurred */
  name: string | null;
}

/** Events the client sends to the server. */
export interface ClientToServerEvents {
  "join-room": (payload: JoinRoomPayload) => void;
  "value-changed": (payload: ValueChangedPayload) => void;
  "focus-question": (payload: FocusPayload) => void;
}

/** Events the server sends to clients. */
export interface ServerToClientEvents {
  "room-state": (payload: RoomStatePayload) => void;
  "value-changed": (payload: ValueChangedPayload) => void;
  "participant-joined": (payload: ParticipantJoinedPayload) => void;
  "participant-left": (payload: ParticipantLeftPayload) => void;
  "focus-question": (payload: FocusBroadcastPayload) => void;
}
