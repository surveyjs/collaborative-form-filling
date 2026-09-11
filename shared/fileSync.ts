import type { Model, Question } from "survey-core";

/**
 * File storage for collaborative file questions.
 *
 * Only a URL travels between peers: the browser that picked the file uploads
 * it here, and the question's value becomes `[{ name, type, content: <url> }]`
 * — a few dozen bytes that ride the normal `value-changed` path in ./sync.
 * Keeping the bytes in the value instead (survey-core's `storeDataAsText`
 * default) pushes a base64 copy of every file through the socket, into the
 * room snapshot, and back out to every late joiner; see normalizeFileQuestion.
 *
 * The SurveyJS demo service is the MVP backend — its uploads are temporary, so
 * links in a long-lived room eventually go stale. It is the only part of the
 * app that knows where files live, so swapping in an endpoint on our own
 * Express server touches this block alone.
 */
const UPLOAD_URL = "https://api.surveyjs.io/private/Surveys/uploadTempFiles";
const FILE_URL = "https://api.surveyjs.io/private/Surveys/getTempFile?name=";
const DELETE_URL = "https://api.surveyjs.io/private/Surveys/deleteTempFile?name=";

/**
 * Per-file ceiling forced onto every file question, whatever the schema says.
 *
 * A room's schema is arbitrary JSON pasted by whoever created the room, so the
 * app cannot rely on the author setting `maxSize` (survey-core's default is 0,
 * meaning unlimited). Without a cap the only feedback on an oversized file is
 * a dropped socket; with one, survey-core rejects it in `allFilesOk` with a
 * visible ExceedSizeError before anything is sent.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Question types that inherit `storeDataAsText` from QuestionFileModelBase. */
const FILE_QUESTION_TYPES = ["file", "signaturepad"];

/** One entry of a file question's value, as survey-core stores it. */
interface StoredFile {
  name: string;
  type: string;
  content: string;
}

/**
 * Forces a file/signature question onto the URL-based transport.
 *
 * `storeDataAsText` is overridden even when the schema sets it explicitly:
 * base64-in-value is not a viable transport for a collaborative room, so this
 * is the app's call, not the schema author's. Note that the override makes an
 * `onUploadFiles` handler mandatory — without one survey-core answers every
 * upload with `noUploadFilesHandler` — which is why this lives next to
 * attachFileSync and the two are wired together.
 *
 * `maxSize` exists on the file question only (a signature is drawn, not
 * picked), and a stricter value from the schema is left alone.
 */
export function normalizeFileQuestion(question: Question): void {
  const type = question.getType();
  if (FILE_QUESTION_TYPES.indexOf(type) < 0) return;
  const q = question as Question & { storeDataAsText: boolean; maxSize?: number };
  q.storeDataAsText = false;
  if (type !== "file") return;
  const maxSize = q.maxSize;
  if (!maxSize || maxSize <= 0 || maxSize > MAX_FILE_BYTES) q.maxSize = MAX_FILE_BYTES;
}

/**
 * Uploads one batch and returns a storage URL per file, in the input order.
 *
 * The multipart FIELD name is the key the storage answers with, so it must be
 * unique per part: keying by `file.name` collapses two files picked under the
 * same name into a single part, and the response can no longer be mapped back
 * onto the files. The index prefix keeps the parts distinct.
 */
async function uploadToStorage(files: File[]): Promise<string[]> {
  const form = new FormData();
  const keys = files.map((file, index) => {
    const key = index + "-" + file.name;
    form.append(key, file);
    return key;
  });
  const response = await fetch(UPLOAD_URL, { method: "POST", body: form });
  if (!response.ok) throw new Error("upload failed with status " + response.status);
  const uploaded = (await response.json()) as Record<string, string>;
  return keys.map((key) => FILE_URL + uploaded[key]);
}

/** Deletes one stored file. Returns false on any failure, never throws. */
async function deleteFromStorage(content: string): Promise<boolean> {
  try {
    const name = new URL(content).searchParams.get("name");
    if (!name) return false;
    const response = await fetch(DELETE_URL + encodeURIComponent(name), { method: "DELETE" });
    return response.status === 200;
  } catch (error) {
    console.error("[fileSync] failed to delete a file from storage", error);
    return false;
  }
}

export interface AttachFileSyncOptions {
  survey: Model;
}

/**
 * Makes file questions work in a shared room, independently of the schema.
 *
 * Normalization runs in two places because neither covers the other's case:
 * the `getAllQuestions` walk catches everything built by the `new Model(json)`
 * constructor (it recurses into static panels), while `onQuestionCreated` —
 * raised from `Question.setSurveyImpl`, so once per question ever created —
 * catches matrixdynamic cells and dynamic-panel questions that only appear
 * once a row is added. `includeNested` is deliberately NOT used on the walk:
 * it calls `page.onFirstRendering()`, forcing a first render that defeats
 * `lazyRenderEnabled`, and the subscription already covers those questions.
 *
 * Must be attached BEFORE the room snapshot is assigned to `survey.data`, so
 * incoming values land on questions that are already normalized.
 *
 * Returns a detach function that removes all listeners.
 */
export function attachFileSync({ survey }: AttachFileSyncOptions): () => void {
  survey.getAllQuestions().forEach(normalizeFileQuestion);

  const onQuestionCreated = (_sender: Model, options: { question: Question }) =>
    normalizeFileQuestion(options.question);

  const onUploadFiles = (
    _sender: Model,
    options: { files: File[]; callback: (data: unknown, errors?: unknown) => void },
  ) => {
    uploadToStorage(options.files)
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
  // not raise this event — so the file is deleted from storage exactly once.
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
