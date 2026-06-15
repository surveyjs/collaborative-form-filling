import type { Participant, SurveyData } from "../../shared/events.js";
import { defaultSurvey } from "./defaultSurvey.js";

export interface Room {
  surveyJson: object;
  data: SurveyData;
  participants: Map<string, Participant>;
}

/** Palette cycled to give each participant a distinct presence color. */
const PALETTE = [
  "#e6194b",
  "#3cb44b",
  "#4363d8",
  "#f58231",
  "#911eb4",
  "#46f0f0",
  "#f032e6",
  "#bcf60c",
];

/**
 * In-memory store of collaborative rooms. No persistence — state lives for the
 * lifetime of the process (MVP). Empty rooms are reclaimed when the last
 * participant leaves.
 */
export class RoomManager {
  private rooms = new Map<string, Room>();
  /** monotonically increasing counter per room, used to pick a palette color */
  private colorCursor = new Map<string, number>();

  /**
   * Returns the room, creating it on first access. A `surveyJson` is honored
   * only at creation time — once a room exists its survey is fixed, so every
   * participant fills out the same schema regardless of join order.
   */
  getOrCreate(roomId: string, surveyJson?: object): Room {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = {
        surveyJson: surveyJson ?? defaultSurvey,
        data: {},
        participants: new Map(),
      };
      this.rooms.set(roomId, room);
      this.colorCursor.set(roomId, 0);
    }
    return room;
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  join(roomId: string, socketId: string, name: string, surveyJson?: object): Participant {
    const room = this.getOrCreate(roomId, surveyJson);
    const cursor = this.colorCursor.get(roomId) ?? 0;
    const participant: Participant = {
      id: socketId,
      name: name.trim() || "Anonymous",
      color: PALETTE[cursor % PALETTE.length],
    };
    this.colorCursor.set(roomId, cursor + 1);
    room.participants.set(socketId, participant);
    return participant;
  }

  /**
   * Removes a participant from a room. Returns the roomId if the participant
   * was found (so the caller can broadcast), and prunes the room when empty.
   */
  leave(socketId: string): { roomId: string } | null {
    for (const [roomId, room] of this.rooms) {
      if (room.participants.delete(socketId)) {
        if (room.participants.size === 0) {
          this.rooms.delete(roomId);
          this.colorCursor.delete(roomId);
        }
        return { roomId };
      }
    }
    return null;
  }

  /** Applies a value change with last-write-wins semantics per question. */
  setValue(roomId: string, name: string, value: unknown): void {
    const room = this.getOrCreate(roomId);
    room.data[name] = value;
  }

  listParticipants(roomId: string): Participant[] {
    const room = this.rooms.get(roomId);
    return room ? [...room.participants.values()] : [];
  }
}
