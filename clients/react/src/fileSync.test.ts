import { describe, expect, it } from "vitest";
import { Model, type QuestionMatrixDynamicModel } from "survey-core";
import { attachFileSync, MAX_FILE_BYTES } from "../../../shared/fileSync";

/**
 * A room's schema is arbitrary JSON pasted by whoever created the room, so
 * none of these tests may rely on the schema opting in: every expectation
 * below is about what the app forces onto the question regardless.
 */

/** Reads the two properties the normalization owns. */
function fileProps(question: unknown) {
  const q = question as { storeDataAsText: boolean; maxSize?: number };
  return { storeDataAsText: q.storeDataAsText, maxSize: q.maxSize };
}

describe("attachFileSync: normalization", () => {
  it("puts a bare file question on the URL transport with a size cap", () => {
    const survey = new Model({ elements: [{ type: "file", name: "files" }] });
    attachFileSync({ survey });

    // Left alone, survey-core would base64 the whole file into the value.
    expect(fileProps(survey.getQuestionByName("files"))).toEqual({
      storeDataAsText: false,
      maxSize: MAX_FILE_BYTES,
    });
  });

  it("overrides storeDataAsText even when the schema sets it explicitly", () => {
    const survey = new Model({
      elements: [{ type: "file", name: "files", storeDataAsText: true }],
    });
    attachFileSync({ survey });

    expect(fileProps(survey.getQuestionByName("files")).storeDataAsText).toBe(false);
  });

  it("keeps a stricter maxSize from the schema", () => {
    const survey = new Model({
      elements: [{ type: "file", name: "files", maxSize: 102400 }],
    });
    attachFileSync({ survey });

    expect(fileProps(survey.getQuestionByName("files")).maxSize).toBe(102400);
  });

  it("normalizes a file question nested in a panel", () => {
    const survey = new Model({
      elements: [
        { type: "panel", name: "docs", elements: [{ type: "file", name: "files" }] },
      ],
    });
    attachFileSync({ survey });

    expect(fileProps(survey.getQuestionByName("files")).storeDataAsText).toBe(false);
  });

  it("normalizes a signature pad, which has no maxSize of its own", () => {
    const survey = new Model({ elements: [{ type: "signaturepad", name: "sign" }] });
    attachFileSync({ survey });

    const props = fileProps(survey.getQuestionByName("sign"));
    expect(props.storeDataAsText).toBe(false);
    expect(props.maxSize).toBeUndefined();
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
    attachFileSync({ survey });

    // The row does not exist yet at attach time, so the one-off walk over
    // getAllQuestions cannot reach this question — onQuestionCreated does.
    const matrix = survey.getQuestionByName("docs") as QuestionMatrixDynamicModel;
    matrix.addRow();
    const cell = matrix.visibleRows[0].getQuestionByName("scan");

    expect(fileProps(cell)).toEqual({ storeDataAsText: false, maxSize: MAX_FILE_BYTES });
  });

  it("leaves other question types alone", () => {
    const survey = new Model({ elements: [{ type: "text", name: "projectName" }] });
    attachFileSync({ survey });

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
    const detach = attachFileSync({ survey });
    detach();

    const matrix = survey.getQuestionByName("docs") as QuestionMatrixDynamicModel;
    matrix.addRow();
    const cell = matrix.visibleRows[0].getQuestionByName("scan");

    expect(fileProps(cell).storeDataAsText).toBe(true);
  });
});
