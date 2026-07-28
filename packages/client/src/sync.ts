import type { Model } from "survey-core";
import type { ValueChangedPayload } from "../../shared/events";

/**
 * Minimal transport surface the sync needs. The real socket.io-client `Socket`
 * satisfies this; tests pass a mock. Decoupling from the concrete socket keeps
 * the sync logic unit-testable without a network.
 */
export interface SyncSocket {
  emit(event: "value-changed", payload: ValueChangedPayload): void;
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
/**
 * Pads a matrixdynamic value with empty row objects up to the question's
 * current `rowCount`.
 *
 * When the last non-empty cell of a matrixdynamic is cleared, survey-core
 * collapses the value to `[]` while the sender's rows stay on screen
 * (`isRowChanging` guards its own rowCount). Broadcasting the raw `[]` makes
 * every OTHER client drop to `rowCount = 0` — their rows vanish. Padding to
 * the sender's rowCount keeps row counts in sync while still clearing cells.
 *
 * Genuine row removal is unaffected: survey-core decrements `rowCount` before
 * writing the shortened value, so at emit time no padding is needed.
 */
function normalizeOutgoingValue(survey: Model, name: string, value: unknown): unknown {
  const question = survey.getQuestionByValueName(name);
  if (question?.getType() !== "matrixdynamic") return value;
  const rowCount = (question as { rowCount: number }).rowCount;
  const rows = Array.isArray(value) ? [...value] : [];
  while (rows.length < rowCount) rows.push({});
  return rows;
}

export function attachSurveySync({ survey, socket, roomId }: AttachSyncOptions): () => void {
  let applyingRemote = false;

  const onLocalChange = (_sender: Model, options: { name: string; value: unknown }) => {
    if (applyingRemote) return;
    socket.emit("value-changed", {
      roomId,
      name: options.name,
      value: normalizeOutgoingValue(survey, options.name, options.value),
    });
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
