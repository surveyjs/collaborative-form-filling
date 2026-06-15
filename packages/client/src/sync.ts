import type { Model } from "survey-core";
import type { ValueChangedPayload } from "../../shared/events";

/**
 * Minimal transport surface the sync needs. The real socket.io-client `Socket`
 * satisfies this; tests pass a mock. Decoupling from the concrete socket keeps
 * the sync logic unit-testable without a network.
 */
export interface SyncSocket {
  emit(event: "value-changed", payload: ValueChangedPayload): void;
  emit(event: "focus-question", payload: { roomId: string; name: string | null }): void;
  on(event: "value-changed", handler: (payload: ValueChangedPayload) => void): void;
  off(event: "value-changed", handler: (payload: ValueChangedPayload) => void): void;
}

export interface AttachSyncOptions {
  survey: Model;
  socket: SyncSocket;
  roomId: string;
}

/**
 * Wires a SurveyJS model to the socket for bidirectional, real-time co-editing.
 *
 * - Local edits (`onValueChanged`) are emitted to the server.
 * - Remote `value-changed` events are applied via `survey.setValue`.
 *
 * `setValue` re-triggers `onValueChanged`, which would echo the change back and
 * loop forever; the `applyingRemote` guard suppresses the re-emit while a remote
 * change is being applied.
 *
 * Returns a detach function that removes all listeners.
 */
export function attachSurveySync({ survey, socket, roomId }: AttachSyncOptions): () => void {
  let applyingRemote = false;

  const onLocalChange = (_sender: Model, options: { name: string; value: unknown }) => {
    if (applyingRemote) return;
    socket.emit("value-changed", { roomId, name: options.name, value: options.value });
  };

  const onRemoteChange = (payload: ValueChangedPayload) => {
    if (payload.roomId !== roomId) return;
    applyingRemote = true;
    try {
      survey.setValue(payload.name, payload.value);
    } finally {
      applyingRemote = false;
    }
  };

  survey.onValueChanged.add(onLocalChange);
  socket.on("value-changed", onRemoteChange);

  return () => {
    survey.onValueChanged.remove(onLocalChange);
    socket.off("value-changed", onRemoteChange);
  };
}
