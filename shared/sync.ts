import type { Model, Question, QuestionMatrixDynamicModel } from "survey-core";
import type { ValueChangedPayload } from "./events";

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

/**
 * Ceiling on one question's serialized value, mirrored by the server's own
 * check in server/src/index.ts — keep the two in sync.
 *
 * It sits under the socket's `maxHttpBufferSize`, because exceeding THAT is
 * not a recoverable error: engine.io refuses the oversized frame and closes
 * the connection (ws code 1009), which surfaces as the form quietly losing
 * sync with nothing said. Refusing the value here keeps the connection alive
 * and puts a message on the question instead.
 *
 * It is also the real ceiling of the `storeDataAsText: true` mode, where a
 * file question's value holds the file's own base64. Hence the chain the three
 * limits form, which must keep its order:
 *
 *   MAX_FILE_BYTES x 4/3  <  MAX_VALUE_CHARS  <  maxHttpBufferSize
 *         13.4 MiB        <      16 MiB       <      20 MiB
 *
 * Note what this bounds in that mode: the value of a file question is an
 * ARRAY, so with `allowMultiple` every file of that question travels in one
 * packet. The cap is therefore per QUESTION, not per file — roughly 12 MiB of
 * originals in total. That is survey-core's data model, not a choice here.
 *
 * This is also the one guard a room schema cannot sidestep, which is why it
 * stays even though ./fileSync clamps `maxSize`: a custom component wrapping a
 * file input, or a question type we do not know about, bypasses the clamp and
 * lands here.
 *
 * Measured in UTF-16 units rather than bytes: exact for the base64 and ASCII
 * payloads that actually approach the limit, and cheap enough to run on every
 * keystroke.
 */
export const MAX_VALUE_CHARS = 16 * 1024 * 1024;

export interface AttachSyncOptions {
  survey: Model;
  socket: SyncSocket;
  roomId: string;
}

/**
 * Wires a SurveyJS model to the socket for bidirectional, real-time co-editing.
 *
 * - Local edits (`onValueChanged`) are emitted to the server.
 * - Adding/removing an EMPTY matrixdynamic row changes only `rowCount` — no
 *   value is written and `onValueChanged` stays silent — so
 *   `onMatrixRowAdded`/`onMatrixRowRemoved` are synced as well, emitting the
 *   question's padded value.
 * - Remote `value-changed` events are applied via `survey.setValue`; names
 *   carrying the comment suffix ("-Comment") go through `survey.setComment`,
 *   otherwise the receiver's visible comment/Other text would not update.
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
  const rowCount = (question as QuestionMatrixDynamicModel).rowCount;
  const rows = Array.isArray(value) ? [...value] : [];
  while (rows.length < rowCount) rows.push({});
  return rows;
}

/**
 * Reconciles a matrixdynamic's rowCount with a freshly applied remote value.
 *
 * `survey.setValue` is a no-op when the incoming value is "equal" to the
 * current one, and survey-core treats `[]` and `undefined` as equal — so when
 * the sender removes the last (all-empty) row, receivers would silently keep
 * theirs. Setting rowCount explicitly covers that gap; when setValue already
 * did the job the counts match and this does nothing.
 */
function syncMatrixRowCount(survey: Model, name: string, value: unknown): void {
  if (!Array.isArray(value)) return;
  const question = survey.getQuestionByValueName(name);
  if (question?.getType() !== "matrixdynamic") return;
  const matrix = question as QuestionMatrixDynamicModel;
  if (matrix.rowCount !== value.length) matrix.rowCount = value.length;
}

export function attachSurveySync({ survey, socket, roomId }: AttachSyncOptions): () => void {
  let applyingRemote = false;

  /** Emits one question's value, refusing anything over MAX_VALUE_CHARS. */
  const emitValue = (name: string, value: unknown) => {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined && serialized.length > MAX_VALUE_CHARS) {
      survey
        .getQuestionByValueName(name)
        ?.addError("This answer is too large to share with the other participants.");
      return;
    }
    socket.emit("value-changed", { roomId, name, value });
  };

  const onLocalChange = (_sender: Model, options: { name: string; value: unknown }) => {
    if (applyingRemote) return;
    emitValue(options.name, normalizeOutgoingValue(survey, options.name, options.value));
  };

  // Adding/removing an empty matrixdynamic row never writes the question's
  // value, so onValueChanged stays silent. Both row events fire AFTER rowCount
  // is updated, so the pad in normalizeOutgoingValue yields an array of the
  // new length. Non-empty rows also write the value → a second, identical
  // emit; harmless (last-write-wins on the server, same-value setValue on
  // peers), so no dedup.
  const onRowsChanged = (_sender: Model, options: { question: Question }) => {
    if (applyingRemote) return;
    const name = options.question.getValueName();
    emitValue(name, normalizeOutgoingValue(survey, name, survey.getValue(name)));
  };

  const onRemoteChange = (payload: ValueChangedPayload) => {
    if (payload.roomId !== roomId) return;
    applyingRemote = true;
    try {
      const suffix = survey.commentSuffix;
      if (payload.name.endsWith(suffix)) {
        survey.setComment(payload.name.slice(0, -suffix.length), payload.value as string);
      } else {
        survey.setValue(payload.name, payload.value);
        syncMatrixRowCount(survey, payload.name, payload.value);
      }
    } finally {
      applyingRemote = false;
    }
  };

  survey.onValueChanged.add(onLocalChange);
  survey.onMatrixRowAdded.add(onRowsChanged);
  survey.onMatrixRowRemoved.add(onRowsChanged);
  socket.on("value-changed", onRemoteChange);

  return () => {
    survey.onValueChanged.remove(onLocalChange);
    survey.onMatrixRowAdded.remove(onRowsChanged);
    survey.onMatrixRowRemoved.remove(onRowsChanged);
    socket.off("value-changed", onRemoteChange);
  };
}
