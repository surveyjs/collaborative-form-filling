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
  /**
   * Question name this participant is currently editing, or null/absent when
   * not focused anywhere. Presence data, not identity — kept here so late
   * joiners receive it via the existing `room-state` participant list.
   */
  focus?: string | null;
  /**
   * Survey page this participant is currently on (page name, or "#<index>"
   * for unnamed pages), or null/absent when unknown. Presence data — kept
   * here so late joiners receive it via `room-state`, like `focus`.
   */
  page?: string | null;
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

export interface PagePayload {
  roomId: string;
  /** Page the sender is on (see `Participant.page`), or null when unknown. */
  name: string | null;
}

export interface CursorPayload {
  roomId: string;
  /**
   * Top-level question name the pointer is over, or null to hide the cursor
   * (pointer left the survey area or is not over any question).
   */
  name: string | null;
  /** Fraction 0..1 of the pointer position within the question's border box. */
  x: number;
  y: number;
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

export interface PageBroadcastPayload {
  /** participant whose page changed */
  id: string;
  /** page the participant is on (see `Participant.page`), or null */
  name: string | null;
}

export interface CursorBroadcastPayload {
  /** participant whose cursor moved */
  id: string;
  /** top-level question name the cursor is over, or null when hidden */
  name: string | null;
  /** fraction 0..1 within the question's border box */
  x: number;
  y: number;
}

/** Events the client sends to the server. */
export interface ClientToServerEvents {
  "join-room": (payload: JoinRoomPayload) => void;
  "value-changed": (payload: ValueChangedPayload) => void;
  "focus-question": (payload: FocusPayload) => void;
  "page-changed": (payload: PagePayload) => void;
  "cursor-moved": (payload: CursorPayload) => void;
}

/** Events the server sends to clients. */
export interface ServerToClientEvents {
  "room-state": (payload: RoomStatePayload) => void;
  "value-changed": (payload: ValueChangedPayload) => void;
  "participant-joined": (payload: ParticipantJoinedPayload) => void;
  "participant-left": (payload: ParticipantLeftPayload) => void;
  "focus-question": (payload: FocusBroadcastPayload) => void;
  "page-changed": (payload: PageBroadcastPayload) => void;
  "cursor-moved": (payload: CursorBroadcastPayload) => void;
}
