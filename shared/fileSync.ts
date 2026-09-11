import type { Model, Question } from "survey-core";

/**
 * File upload for collaborative file questions.
 *
 * survey-core offers two storage modes and the schema picks, not this module:
 *
 * - `storeDataAsText: true` (survey-core's default) — the file is read with
 *   FileReader and its base64 IS the question's value. `onUploadFiles` never
 *   fires, nothing here participates, and the bytes ride the socket and sit in
 *   the room snapshot. The limits in ./sync are what keep that survivable.
 * - `storeDataAsText: false` — survey-core raises `onUploadFiles`, we upload to
 *   our own endpoint and the value holds only `{name, type, content: <url>}`,
 *   a few dozen bytes regardless of file size.
 *
 * Whichever the author chose is what ends up in the survey results, so this
 * module does not override it: forcing one mode would silently change the data
 * a schema was written to collect.
 *
 * Storage is the Express server that already serves this app, so every URL
 * below is root-relative — same origin, no host to hard-code, nothing to get
 * wrong behind a proxy.
 */
const FILES_PATH_PREFIX = "/api/rooms/";

function uploadUrl(roomId: string, fileName: string): string {
  return (
    FILES_PATH_PREFIX +
    encodeURIComponent(roomId) +
    "/files?name=" +
    encodeURIComponent(fileName)
  );
}

/** True for URLs this module produced, i.e. files it is responsible for. */
function isStoredRemotely(content: string): boolean {
  return typeof content === "string" && content.indexOf(FILES_PATH_PREFIX) === 0;
}

/**
 * Per-file ceiling applied to every file question, whatever the schema says.
 *
 * A room's schema is arbitrary JSON pasted by whoever created the room, so the
 * app cannot rely on the author setting `maxSize` (survey-core's default is 0,
 * meaning unlimited). This does not change the shape of the results — only the
 * validation boundary — but without it a `storeDataAsText: true` question
 * would read a file of any size into memory before anything noticed. Mirrored
 * by MAX_FILE_BYTES in server/src/fileRoutes.ts; keep the two in sync.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** One entry of a file question's value, as survey-core stores it. */
interface StoredFile {
  name: string;
  type: string;
  content: string;
}

/**
 * Clamps a file question's `maxSize`.
 *
 * Deliberately leaves `storeDataAsText` alone — see the module comment. Only
 * the file question has `maxSize` (a signature is drawn, not picked), and a
 * stricter value from the schema is respected.
 */
export function normalizeFileQuestion(question: Question): void {
  if (question.getType() !== "file") return;
  const q = question as Question & { maxSize?: number };
  const maxSize = q.maxSize;
  if (!maxSize || maxSize <= 0 || maxSize > MAX_FILE_BYTES) q.maxSize = MAX_FILE_BYTES;
}

/**
 * Uploads one file as a raw request body and returns its URL.
 *
 * One request per file, rather than one multipart request per batch: the
 * server then needs no multipart parser (express.raw covers it, and enforces
 * the size limit on its own), and two files picked under the SAME NAME cannot
 * collide, which a field-name-keyed multipart response could not avoid.
 */
async function uploadToStorage(roomId: string, file: File): Promise<string> {
  const response = await fetch(uploadUrl(roomId, file.name), {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!response.ok) throw new Error("upload failed with status " + response.status);
  const stored = (await response.json()) as { url: string };
  if (!stored || !stored.url) throw new Error("upload response had no url");
  return stored.url;
}

/** Deletes one stored file. Returns false on any failure, never throws. */
async function deleteFromStorage(content: string): Promise<boolean> {
  // `onClearFiles` is NOT gated by storeDataAsText the way `onUploadFiles` is:
  // it fires in both modes. In the base64 mode `content` is a `data:` URL and
  // there is nothing on any server to remove — the file lives inside the value
  // and goes away with it. Reporting success is correct; issuing a request
  // would be pure noise.
  if (!isStoredRemotely(content)) return true;
  try {
    const response = await fetch(content, { method: "DELETE" });
    return response.status === 200;
  } catch (error) {
    console.error("[fileSync] failed to delete a file from storage", error);
    return false;
  }
}

export interface AttachFileSyncOptions {
  survey: Model;
  roomId: string;
}

/**
 * Makes file questions work in a shared room, independently of the schema.
 *
 * The `maxSize` clamp runs in two places because neither covers the other's
 * case: the `getAllQuestions` walk catches everything built by the
 * `new Model(json)` constructor (it recurses into static panels), while
 * `onQuestionCreated` — raised from `Question.setSurveyImpl`, so once per
 * question ever created — catches matrixdynamic cells and dynamic-panel
 * questions that only appear once a row is added. `includeNested` is
 * deliberately NOT used on the walk: it calls `page.onFirstRendering()`,
 * forcing a first render that defeats `lazyRenderEnabled`, and the
 * subscription already covers those questions.
 *
 * Both handlers are registered unconditionally. A question left on
 * `storeDataAsText: true` simply never raises `onUploadFiles`, so there is no
 * need to branch on the mode anywhere.
 *
 * Must be attached BEFORE the room snapshot is assigned to `survey.data`.
 *
 * Returns a detach function that removes all listeners.
 */
export function attachFileSync({ survey, roomId }: AttachFileSyncOptions): () => void {
  survey.getAllQuestions().forEach(normalizeFileQuestion);

  const onQuestionCreated = (_sender: Model, options: { question: Question }) =>
    normalizeFileQuestion(options.question);

  const onUploadFiles = (
    _sender: Model,
    options: { files: File[]; callback: (data: unknown, errors?: unknown) => void },
  ) => {
    Promise.all(options.files.map((file) => uploadToStorage(roomId, file)))
      .then((urls) =>
        options.callback(
          options.files.map((file, index) => ({ file: file, content: urls[index] })),
        ),
      )
      .catch((error) => {
        console.error("[fileSync] failed to upload files to storage", error);
        // An empty success list plus an error message: survey-core keeps the
        // existing value and surfaces the message on the question.
        options.callback([], ["An error occurred during file upload."]);
      });
  };

  // Fires only on the participant who removed the file. Peers receive the
  // already-filtered value through `value-changed`, and `survey.setValue` does
  // not raise this event — so a stored file is deleted exactly once.
  const onClearFiles = (
    _sender: Model,
    options: {
      value: StoredFile[] | null;
      fileName: string | null;
      callback: (status: string, data?: unknown) => void;
    },
  ) => {
    const value = options.value;
    if (!value || value.length === 0) return options.callback("success");

    const doomed = options.fileName
      ? value.filter((item) => item.name === options.fileName)
      : value;
    if (doomed.length === 0) {
      console.error("[fileSync] no file named " + options.fileName + " to delete");
      return options.callback("error");
    }

    Promise.all(doomed.map((item) => deleteFromStorage(item.content))).then((results) =>
      options.callback(results.every(Boolean) ? "success" : "error"),
    );
  };

  survey.onQuestionCreated.add(onQuestionCreated);
  survey.onUploadFiles.add(onUploadFiles);
  survey.onClearFiles.add(onClearFiles);

  return () => {
    survey.onQuestionCreated.remove(onQuestionCreated);
    survey.onUploadFiles.remove(onUploadFiles);
    survey.onClearFiles.remove(onClearFiles);
  };
}
