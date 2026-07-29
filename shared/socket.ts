// Separate type import: the Angular client compiles this file with TS 4.3,
// which predates inline `type` modifiers in named imports (TS 4.5).
import { io } from "socket.io-client";
import type { Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "./events";

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Connects to the Socket.IO server. The client is served by the same Express
 * server that hosts Socket.IO (single port, both in dev and prod), so the
 * default same-origin connection works.
 */
export function createSocket(): AppSocket {
  return io({ autoConnect: true });
}
