import { afterEach, describe, expect, it, vi } from "vitest";
import { Model, type QuestionFileModel, type QuestionMatrixDynamicModel } from "survey-core";
import { attachFileSync, MAX_FILE_BYTES } from "../../../shared/fileSync";

/**
 * A room's schema is arbitrary JSON pasted by whoever created the room, so the
 * app cannot assume anything is set in it. What it must NOT do either is
 * override what IS set: `storeDataAsText` decides whether the survey results
 * hold the file itself or a link to it, and that is the schema author's call.
 */

/** The two properties this module has an opinion about, or deliberately none. */
function fileProps(question: unknown) {
  const q = question as { storeDataAsText?: boolean; maxSize?: number };
  return { storeDataAsText: q.storeDataAsText, maxSize: q.maxSize };
}

function png(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

/** Resolves once survey-core has written the upload result into the value. */
function fileOf(survey: Model, name: string): QuestionFileModel {
  return survey.getQuestionByName(name) as QuestionFileModel;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("attachFileSync: normalization", () => {
  it("clamps an absent maxSize without touching storeDataAsText", () => {
    const survey = new Model({ elements: [{ type: "file", name: "files" }] });
    attachFileSync({ survey, roomId: "r1" });

    // storeDataAsText stays at survey-core's own default — the app has no
    // business changing what the results will contain.
    expect(fileProps(survey.getQuestionByName("files"))).toEqual({
      storeDataAsText: true,
      maxSize: MAX_FILE_BYTES,
    });
  });

  it("leaves an explicit storeDataAsText: true alone", () => {
    const survey = new Model({
      elements: [{ type: "file", name: "files", storeDataAsText: true }],
    });
    attachFileSync({ survey, roomId: "r1" });

    expect(fileProps(survey.getQuestionByName("files")).storeDataAsText).toBe(true);
  });

  it("leaves an explicit storeDataAsText: false alone", () => {
    const survey = new Model({
      elements: [{ type: "file", name: "files", storeDataAsText: false }],
    });
    attachFileSync({ survey, roomId: "r1" });

    expect(fileProps(survey.getQuestionByName("files")).storeDataAsText).toBe(false);
  });

  it("keeps a stricter maxSize from the schema", () => {
    const survey = new Model({
      elements: [{ type: "file", name: "files", maxSize: 102400 }],
    });
    attachFileSync({ survey, roomId: "r1" });

    expect(fileProps(survey.getQuestionByName("files")).maxSize).toBe(102400);
  });

  it("normalizes a file question nested in a panel", () => {
    const survey = new Model({
      elements: [
        { type: "panel", name: "docs", elements: [{ type: "file", name: "files" }] },
      ],
    });
    attachFileSync({ survey, roomId: "r1" });

    expect(fileProps(survey.getQuestionByName("files")).maxSize).toBe(MAX_FILE_BYTES);
  });

  it("normalizes a matrix cell created after the model was built", () => {
    const survey = new Model({
      elements: [
        {
          type: "matrixdynamic",
          name: "docs",
          rowCount: 0,
          columns: [{ name: "scan", cellType: "file" }],
        },
      ],
    });
    attachFileSync({ survey, roomId: "r1" });

    // The row does not exist at attach time, so the one-off getAllQuestions
    // walk cannot reach this question — onQuestionCreated does.
    const matrix = survey.getQuestionByName("docs") as QuestionMatrixDynamicModel;
    matrix.addRow();
    const cell = matrix.visibleRows[0].getQuestionByName("scan");

    expect(fileProps(cell).maxSize).toBe(MAX_FILE_BYTES);
  });

  it("leaves other question types alone", () => {
    const survey = new Model({ elements: [{ type: "text", name: "projectName" }] });
    attachFileSync({ survey, roomId: "r1" });

    expect(fileProps(survey.getQuestionByName("projectName"))).toEqual({
      storeDataAsText: undefined,
      maxSize: undefined,
    });
  });

  it("stops normalizing after detach", () => {
    const survey = new Model({
      elements: [
        {
          type: "matrixdynamic",
          name: "docs",
          rowCount: 0,
          columns: [{ name: "scan", cellType: "file" }],
        },
      ],
    });
    const detach = attachFileSync({ survey, roomId: "r1" });
    detach();

    const matrix = survey.getQuestionByName("docs") as QuestionMatrixDynamicModel;
    matrix.addRow();

    expect(fileProps(matrix.visibleRows[0].getQuestionByName("scan")).maxSize).toBe(0);
  });
});

/**
 * Both modes in ONE model. Two separate single-question tests would not catch
 * the thing most likely to go wrong: the handlers are attached to the survey
 * while `storeDataAsText` lives on the question, so a per-model shortcut would
 * pass those and fail here.
 */
describe("attachFileSync: both storage modes in one survey", () => {
  const BOTH_MODES = {
    elements: [
      { type: "file", name: "filesInline", storeDataAsText: true },
      { type: "file", name: "filesUrl", storeDataAsText: false },
    ],
  };

  function stubUpload() {
    let next = 0;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ url: `/api/rooms/r1/files/id-${next++}` }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("keeps each question on the mode its own schema asked for", () => {
    const survey = new Model(BOTH_MODES);
    attachFileSync({ survey, roomId: "r1" });

    expect(fileProps(survey.getQuestionByName("filesInline"))).toEqual({
      storeDataAsText: true,
      maxSize: MAX_FILE_BYTES,
    });
    expect(fileProps(survey.getQuestionByName("filesUrl"))).toEqual({
      storeDataAsText: false,
      maxSize: MAX_FILE_BYTES,
    });
  });

  it("uploads only the storeDataAsText: false question, and stores its url", async () => {
    const fetchMock = stubUpload();
    const survey = new Model(BOTH_MODES);
    attachFileSync({ survey, roomId: "r1" });

    fileOf(survey, "filesUrl").loadFiles([png("a.png")]);

    await vi.waitFor(() => expect(survey.getValue("filesUrl")).toHaveLength(1));
    expect(survey.getValue("filesUrl")[0].content).toBe("/api/rooms/r1/files/id-0");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/rooms/r1/files?name=a.png");
    expect(init.method).toBe("POST");
  });

  it("sends nothing for the storeDataAsText: true question and keeps base64 in the value", async () => {
    const fetchMock = stubUpload();
    const survey = new Model(BOTH_MODES);
    attachFileSync({ survey, roomId: "r1" });

    fileOf(survey, "filesInline").loadFiles([png("a.png")]);

    await vi.waitFor(() => expect(survey.getValue("filesInline")).toHaveLength(1));
    // survey-core never raises onUploadFiles in this mode — the file's own
    // base64 IS the value, which is exactly what the schema asked for.
    expect(survey.getValue("filesInline")[0].content).toMatch(/^data:image\/png;base64,/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("attachFileSync: upload and delete", () => {
  it("uploads two files picked under the same name as two distinct files", async () => {
    let next = 0;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ url: `/api/rooms/r1/files/id-${next++}` }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const survey = new Model({
      elements: [
        { type: "file", name: "files", storeDataAsText: false, allowMultiple: true },
      ],
    });
    attachFileSync({ survey, roomId: "r1" });

    fileOf(survey, "files").loadFiles([png("photo.png"), png("photo.png")]);

    await vi.waitFor(() => expect(survey.getValue("files")).toHaveLength(2));
    // One request per file is what makes this safe: a multipart batch keyed by
    // field name used to collapse two same-named files into one part.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const contents = survey.getValue("files").map((f: { content: string }) => f.content);
    expect(new Set(contents).size).toBe(2);
  });

  it("issues exactly one DELETE for a stored file", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "DELETE"
        ? { ok: true, status: 200, json: async () => ({ ok: true }) }
        : { ok: true, status: 201, json: async () => ({ url: "/api/rooms/r1/files/id-0" }) },
    );
    vi.stubGlobal("fetch", fetchMock);

    const survey = new Model({
      elements: [{ type: "file", name: "files", storeDataAsText: false }],
    });
    attachFileSync({ survey, roomId: "r1" });
    fileOf(survey, "files").loadFiles([png("a.png")]);
    await vi.waitFor(() => expect(survey.getValue("files")).toHaveLength(1));

    fileOf(survey, "files").removeFile("a.png");

    await vi.waitFor(() => expect(survey.getValue("files")).toBeFalsy());
    const deletes = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0][0]).toBe("/api/rooms/r1/files/id-0");
  });

  it("issues no request when removing a base64 file", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const survey = new Model({
      elements: [{ type: "file", name: "files", storeDataAsText: true }],
    });
    attachFileSync({ survey, roomId: "r1" });
    fileOf(survey, "files").loadFiles([png("a.png")]);
    await vi.waitFor(() => expect(survey.getValue("files")).toHaveLength(1));

    fileOf(survey, "files").removeFile("a.png");

    // onClearFiles fires in BOTH modes, unlike onUploadFiles. Here `content`
    // is a data: URL — there is nothing on a server to remove, and asking is
    // pure noise, so the removal must still succeed locally.
    await vi.waitFor(() => expect(survey.getValue("files")).toBeFalsy());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
