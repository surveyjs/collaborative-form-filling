import type { WebSocket } from "ws";
import {
  IPresencePeerEntry,
  PRESENCE_COLOR_SLOTS,
  PRESENCE_FIRST_COLOR_SLOT,
} from "./protocol.js";

/**
 * In-memory room store. Deliberately trivial — this file plus protocol.ts is the
 * whole data model a server port has to reproduce:
 *
 *   room = { id, seed, values, clients }
 *
 * `seed` (the survey schema) and every entry of `values` are opaque; `key` is used
 * only as a map key and never parsed. A snapshot map rather than an append-only
 * log, because the collaborative state of a form filling session already IS a flat
 * key -> value map with last-write-wins per key: a log would grow without bound
 * during a session and make a late joiner O(edits) instead of O(questions).
 */
/** See RoomStoreOptions.emptyRoomTtlMs for why this is not zero. */
export const DEFAULT_EMPTY_ROOM_TTL_MS = 2000;

export interface Room {
  id: string;
  seed: unknown;
  values: Map<string, unknown>;
  clients: Map<string, WebSocket>;
  colorSlots: Map<string, number>;
  names: Map<string, string>;
  /** Last RETAINED presence state per client. Ephemeral frames never land here. */
  presence: Map<string, unknown>;
  gcTimer?: ReturnType<typeof setTimeout>;
}

export interface RoomStoreOptions {
  /** Seed for a room created without one. Injected, so the store knows no SurveyJS. */
  defaultSeed?: unknown;
  /**
   * How long an empty room lingers before it is reclaimed.
   *
   * NOT zero. A room has to survive its last socket blipping: a reconnect, a React
   * StrictMode double-mount in development, or a 200 ms network drop all leave the
   * room empty for an instant. Pruning on the spot loses the schema its creator
   * registered, and the next connect silently re-creates the room with the default
   * survey - which is exactly how this was found.
   *
   * Still short, because reclaiming an abandoned room id is a feature here.
   */
  emptyRoomTtlMs?: number;
  /** Fired after a room is deleted, so the caller can drop its blobs. */
  onRoomDeleted?: (roomId: string) => void;
}

export class RoomStore {
  private rooms = new Map<string, Room>();

  constructor(private options: RoomStoreOptions = {}) {}

  public get(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  public create(id: string, seed?: unknown): Room {
    const room: Room = {
      id,
      seed: seed !== undefined ? seed : this.options.defaultSeed,
      values: new Map<string, unknown>(),
      clients: new Map<string, WebSocket>(),
      colorSlots: new Map<string, number>(),
      names: new Map<string, string>(),
      presence: new Map<string, unknown>(),
    };
    this.rooms.set(id, room);
    return room;
  }

  public getOrCreate(id: string, seed?: unknown): Room {
    return this.rooms.get(id) ?? this.create(id, seed);
  }

  /** Last write wins, per opaque key. That is the entire conflict resolution. */
  public setValue(room: Room, key: string, value: unknown): void {
    room.values.set(key, value);
  }

  public snapshot(room: Room): { [key: string]: unknown } {
    const res: { [key: string]: unknown } = {};
    room.values.forEach((value, key) => {
      res[key] = value;
    });
    return res;
  }

  public addClient(room: Room, clientId: string, ws: WebSocket, name: string): void {
    room.clients.set(clientId, ws);
    room.names.set(clientId, name);
    this.assignColorSlot(room, clientId);
    if (room.gcTimer) {
      clearTimeout(room.gcTimer);
      room.gcTimer = undefined;
    }
  }

  /** Lowest colour slot not held by a connected client; a leaver's slot is reusable. */
  public assignColorSlot(room: Room, clientId: string): number {
    const taken = new Set(room.colorSlots.values());
    let slot = PRESENCE_FIRST_COLOR_SLOT;
    while (taken.has(slot)) slot++;
    room.colorSlots.set(clientId, slot);
    return slot;
  }

  /**
   * The theme colour slot this participant is painted with. Kept raw in the map and
   * wrapped only on read, so that past the ninth participant the slots keep cycling
   * instead of everyone piling onto the first one.
   */
  public colorIndexOf(room: Room, clientId: string): number {
    const raw = room.colorSlots.get(clientId) ?? PRESENCE_FIRST_COLOR_SLOT;
    return PRESENCE_FIRST_COLOR_SLOT +
      ((raw - PRESENCE_FIRST_COLOR_SLOT) % PRESENCE_COLOR_SLOTS);
  }

  public nameOf(room: Room, clientId: string): string {
    return room.names.get(clientId) ?? "";
  }

  public setPresence(room: Room, clientId: string, state: unknown): void {
    room.presence.set(clientId, state);
  }

  /** The roster as a newcomer receives it: only clients that have sent presence. */
  public roster(room: Room, exceptClientId?: string): Array<IPresencePeerEntry> {
    const res: Array<IPresencePeerEntry> = [];
    room.presence.forEach((state, clientId) => {
      if (clientId === exceptClientId) return;
      res.push({
        clientId,
        name: this.nameOf(room, clientId),
        colorIndex: this.colorIndexOf(room, clientId),
        state,
      });
    });
    return res;
  }

  public removeClient(room: Room, clientId: string): void {
    room.clients.delete(clientId);
    room.colorSlots.delete(clientId);
    room.names.delete(clientId);
    room.presence.delete(clientId);
    if (room.clients.size > 0) return;
    const ttl = this.options.emptyRoomTtlMs ?? DEFAULT_EMPTY_ROOM_TTL_MS;
    const prune = () => {
      if (room.clients.size > 0) return;
      this.rooms.delete(room.id);
      this.options.onRoomDeleted?.(room.id);
    };
    if (ttl <= 0) {
      prune();
      return;
    }
    room.gcTimer = setTimeout(prune, ttl);
  }
}
