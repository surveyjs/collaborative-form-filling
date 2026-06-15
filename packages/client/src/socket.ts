import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "../../shared/events";

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Connects to the Socket.IO server. The client is served by the same Express
 * server that hosts Socket.IO (single port, both in dev and prod), so the
 * default same-origin connection works.
 */
export function createSocket(): AppSocket {
  return io({ autoConnect: true });
}
