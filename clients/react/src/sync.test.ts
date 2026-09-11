import { afterEach, describe, expect, it, vi } from "vitest";
import { Model, type QuestionMatrixDynamicModel } from "survey-core";
import { attachSurveySync, MAX_VALUE_CHARS, type SyncSocket } from "../../../shared/sync";
import type { ValueChangedPayload } from "../../../shared/events";

const SURVEY_JSON = {
  elements: [
    { type: "text", name: "projectName" },
    { type: "text", name: "owner" },
  ],
};

/** Mirrors the "members" matrixdynamic from the default survey. */
const MATRIX_SURVEY_JSON = {
  elements: [
    {
      type: "matrixdynamic",
      name: "members",
      rowCount: 1,
      columns: [
        { name: "member", cellType: "text" },
        { name: "role", cellType: "dropdown", choices: ["Developer", "Designer", "QA"] },
      ],
    },
  ],
};

/** A mock socket capturing emits and letting tests drive incoming events. */
function makeMockSocket() {
  const emit = vi.fn();
  const handlers = new Map<string, ((p: ValueChangedPayload) => void)[]>();

  const socket: SyncSocket = {
    emit: emit as SyncSocket["emit"],
    on: (event, handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    off: (event, handler) => {
      handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
    },
  };

  const receive = (payload: ValueChangedPayload) =>
    (handlers.get("value-changed") ?? []).forEach((h) => h(payload));

  return { socket, emit, receive, handlerCount: () => (handlers.get("value-changed") ?? []).length };
}

describe("attachSurveySync", () => {
  it("emits value-changed when the user edits locally", () => {
    const survey = new Model(SURVEY_JSON);
    const { socket, emit } = makeMockSocket();
    attachSurveySync({ survey, socket, roomId: "r1" });

    survey.setValue("projectName", "Apollo");

    expect(emit).toHaveBeenCalledWith("value-changed", {
      roomId: "r1",
      name: "projectName",
      value: "Apollo",
    });
  });

  it("applies remote changes to the model", () => {
    const survey = new Model(SURVEY_JSON);
    const { socket, receive } = makeMockSocket();
    attachSurveySync({ survey, socket, roomId: "r1" });

    receive({ roomId: "r1", name: "owner", value: "Bob" });

    expect(survey.getValue("owner")).toBe("Bob");
  });

  it("does NOT echo a remote change back (breaks the loop)", () => {
    const survey = new Model(SURVEY_JSON);
    const { socket, emit, receive } = makeMockSocket();
    attachSurveySync({ survey, socket, roomId: "r1" });

    receive({ roomId: "r1", name: "projectName", value: "Zephyr" });

    // applyingRemote guard must suppress the re-emit triggered by setValue.
    expect(emit).not.toHaveBeenCalled();
    expect(survey.getValue("projectName")).toBe("Zephyr");
  });

  it("ignores remote changes for a different room", () => {
    const survey = new Model(SURVEY_JSON);
    const { socket, receive } = makeMockSocket();
    attachSurveySync({ survey, socket, roomId: "r1" });

    receive({ roomId: "other", name: "owner", value: "Carol" });

    expect(survey.getValue("owner")).toBeUndefined();
  });

  it("detach removes both listeners", () => {
    const survey = new Model(SURVEY_JSON);
    const { socket, emit, receive, handlerCount } = makeMockSocket();
    const detach = attachSurveySync({ survey, socket, roomId: "r1" });

    detach();
    survey.setValue("projectName", "X");
    receive({ roomId: "r1", name: "owner", value: "Y" });

    expect(emit).not.toHaveBeenCalled();
    expect(handlerCount()).toBe(0);
    expect(survey.getValue("owner")).toBeUndefined();
  });
});

describe("attachSurveySync: matrixdynamic", () => {
  const getMatrix = (survey: Model) =>
    survey.getQuestionByName("members") as QuestionMatrixDynamicModel;

  it("pads the emitted value to rowCount when the last non-empty cell is cleared", () => {
    const survey = new Model(MATRIX_SURVEY_JSON);
    const { socket, emit } = makeMockSocket();
    attachSurveySync({ survey, socket, roomId: "r1" });

    const role = getMatrix(survey).visibleRows[0].getQuestionByName("role");
    role.value = "Developer";
    emit.mockClear();

    // Same code path as the dropdown's clear ("x") button. survey-core
    // collapses the all-empty rows array to [] — the pad must restore [{}].
    role.clearValue();

    expect(emit).toHaveBeenCalledWith("value-changed", {
      roomId: "r1",
      name: "members",
      value: [{}],
    });
  });

  it("keeps the remote participant's row when a cell is cleared (round-trip)", () => {
    const surveyA = new Model(MATRIX_SURVEY_JSON);
    const surveyB = new Model(MATRIX_SURVEY_JSON);
    const a = makeMockSocket();
    const b = makeMockSocket();
    attachSurveySync({ survey: surveyA, socket: a.socket, roomId: "r1" });
    attachSurveySync({ survey: surveyB, socket: b.socket, roomId: "r1" });
    // Deliver B's emits to A, as the server relay would.
    b.emit.mockImplementation((_event, payload) => a.receive(payload as ValueChangedPayload));

    const matrixA = getMatrix(surveyA);
    const roleB = getMatrix(surveyB).visibleRows[0].getQuestionByName("role");

    roleB.value = "Developer";
    expect(matrixA.visibleRows[0].getQuestionByName("role").value).toBe("Developer");

    roleB.clearValue();

    // Regression: A used to receive [] and drop to rowCount 0 — the row vanished.
    expect(matrixA.rowCount).toBe(1);
    expect(matrixA.visibleRows).toHaveLength(1);
    expect(matrixA.visibleRows[0].getQuestionByName("role").isEmpty()).toBe(true);
  });

  it("broadcasts adding an empty row (the 'Add team member' button)", () => {
    const surveyA = new Model(MATRIX_SURVEY_JSON);
    const surveyB = new Model(MATRIX_SURVEY_JSON);
    const a = makeMockSocket();
    const b = makeMockSocket();
    attachSurveySync({ survey: surveyA, socket: a.socket, roomId: "r1" });
    attachSurveySync({ survey: surveyB, socket: b.socket, roomId: "r1" });
    b.emit.mockImplementation((_event, payload) => a.receive(payload as ValueChangedPayload));

    // Same code path as the "Add team member" button (addRowUI → addRow).
    // An empty row writes no value, so onValueChanged alone would miss it.
    getMatrix(surveyB).addRow();

    expect(b.emit).toHaveBeenCalledWith("value-changed", {
      roomId: "r1",
      name: "members",
      value: [{}, {}],
    });
    expect(getMatrix(surveyA).rowCount).toBe(2);
    expect(getMatrix(surveyA).visibleRows).toHaveLength(2);
  });

  it("broadcasts removing an empty row", () => {
    const surveyA = new Model(MATRIX_SURVEY_JSON);
    const surveyB = new Model(MATRIX_SURVEY_JSON);
    const a = makeMockSocket();
    const b = makeMockSocket();
    attachSurveySync({ survey: surveyA, socket: a.socket, roomId: "r1" });
    attachSurveySync({ survey: surveyB, socket: b.socket, roomId: "r1" });
    b.emit.mockImplementation((_event, payload) => a.receive(payload as ValueChangedPayload));

    const matrixB = getMatrix(surveyB);
    matrixB.visibleRows; // generate rows so removeRow can resolve the row model
    // The row is empty → removeRowCore writes no value; only rowCount drops.
    matrixB.removeRow(0);

    expect(b.emit).toHaveBeenCalledWith("value-changed", {
      roomId: "r1",
      name: "members",
      value: [],
    });
    expect(getMatrix(surveyA).rowCount).toBe(0);
  });

  it("detach stops row add/remove broadcasting", () => {
    const survey = new Model(MATRIX_SURVEY_JSON);
    const { socket, emit } = makeMockSocket();
    const detach = attachSurveySync({ survey, socket, roomId: "r1" });

    detach();
    getMatrix(survey).addRow();

    expect(emit).not.toHaveBeenCalled();
  });

  it("still syncs genuine row removal", () => {
    const surveyA = new Model(MATRIX_SURVEY_JSON);
    const surveyB = new Model(MATRIX_SURVEY_JSON);
    const a = makeMockSocket();
    const b = makeMockSocket();
    attachSurveySync({ survey: surveyA, socket: a.socket, roomId: "r1" });
    attachSurveySync({ survey: surveyB, socket: b.socket, roomId: "r1" });
    b.emit.mockImplementation((_event, payload) => a.receive(payload as ValueChangedPayload));

    const matrixA = getMatrix(surveyA);
    const matrixB = getMatrix(surveyB);
    surveyB.setValue("members", [{ member: "Ann" }, { member: "Bob" }]);
    expect(matrixA.rowCount).toBe(2);

    matrixB.visibleRows; // generate rows so removeRow can resolve the row model
    matrixB.removeRow(0);

    // rowCount is decremented before the value write, so no padding kicks in.
    expect(b.emit).toHaveBeenLastCalledWith("value-changed", {
      roomId: "r1",
      name: "members",
      value: [{ member: "Bob" }],
    });
    expect(matrixA.rowCount).toBe(1);
    expect(matrixA.visibleRows[0].getQuestionByName("member").value).toBe("Bob");
  });
});

describe("attachSurveySync: comments", () => {
  const COMMENT_SURVEY_JSON = {
    elements: [
      { type: "radiogroup", name: "stage", choices: ["Idea"], showCommentArea: true },
    ],
  };

  it("applies a remote comment so the visible comment area updates", () => {
    const survey = new Model(COMMENT_SURVEY_JSON);
    const { socket, receive } = makeMockSocket();
    attachSurveySync({ survey, socket, roomId: "r1" });

    receive({ roomId: "r1", name: "stage-Comment", value: "remote note" });

    // Plain setValue would store the data but leave question.comment (and the
    // rendered textarea) empty — the payload must be routed to setComment.
    expect(survey.getQuestionByName("stage").comment).toBe("remote note");
    expect(survey.getComment("stage")).toBe("remote note");
  });

  it("does not echo a remote comment back", () => {
    const survey = new Model(COMMENT_SURVEY_JSON);
    const { socket, emit, receive } = makeMockSocket();
    attachSurveySync({ survey, socket, roomId: "r1" });

    receive({ roomId: "r1", name: "stage-Comment", value: "remote note" });

    expect(emit).not.toHaveBeenCalled();
  });
});

describe("attachSurveySync: oversized values", () => {
  // Read from the module rather than restated here: the limit moves with the
  // file-question base64 ceiling, and a local copy would quietly go stale.
  const LIMIT = MAX_VALUE_CHARS;

  it("refuses a value over the limit and reports it on the question", () => {
    const survey = new Model(SURVEY_JSON);
    const { socket, emit } = makeMockSocket();
    attachSurveySync({ survey, socket, roomId: "r1" });

    survey.setValue("projectName", "x".repeat(LIMIT + 1));

    // Emitting it would blow past the socket's maxHttpBufferSize, and
    // engine.io answers that by closing the connection rather than by
    // rejecting the packet — the form would silently stop syncing.
    expect(emit).not.toHaveBeenCalled();
    expect(survey.getQuestionByName("projectName").errors.length).toBeGreaterThan(0);
  });

  it("still emits a value just under the limit", () => {
    const survey = new Model(SURVEY_JSON);
    const { socket, emit } = makeMockSocket();
    attachSurveySync({ survey, socket, roomId: "r1" });

    // JSON.stringify wraps a string in two quotes, so this lands exactly on
    // the limit rather than over it.
    const value = "x".repeat(LIMIT - 2);
    survey.setValue("projectName", value);

    expect(emit).toHaveBeenCalledWith("value-changed", {
      roomId: "r1",
      name: "projectName",
      value,
    });
    expect(survey.getQuestionByName("projectName").errors).toHaveLength(0);
  });
});

describe("attachSurveySync: rescuing the focused editor", () => {
  /**
   * Mounts a bare input carrying the id survey-core would render for that
   * question and focuses it. No framework involved: the rescue only depends on
   * document.activeElement and the id, so the same code path covers React,
   * Plain JS, Vue and Angular. surveyRender.test.tsx covers the rendered half.
   */
  const focusEditorFor = (question: { inputId: string }, text: string) => {
    const input = document.createElement("input");
    input.id = question.inputId;
    document.body.appendChild(input);
    input.value = text;
    input.focus();
    return input;
  };

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("commits and broadcasts the half-typed text before applying a peer value", () => {
    const survey = new Model(SURVEY_JSON);
    const { socket, emit, receive } = makeMockSocket();
    attachSurveySync({ survey, socket, roomId: "r1" });
    const typed = survey.getQuestionByName("projectName") as unknown as { inputId: string };
    focusEditorFor(typed, "Apollo");

    receive({ roomId: "r1", name: "owner", value: "Bob" });

    // SurveyJS would only have committed this on blur; by then the repaint
    // triggered by the peer value has already overwritten the input.
    expect(survey.getValue("projectName")).toBe("Apollo");
    expect(emit).toHaveBeenCalledWith("value-changed", {
      roomId: "r1",
      name: "projectName",
      value: "Apollo",
    });
    expect(survey.getValue("owner")).toBe("Bob");
  });

  it("ignores a focused element that is not a survey editor", () => {
    const survey = new Model(SURVEY_JSON);
    const { socket, emit, receive } = makeMockSocket();
    attachSurveySync({ survey, socket, roomId: "r1" });
    const stray = document.createElement("input");
    stray.id = "some-other-field";
    document.body.appendChild(stray);
    stray.value = "typed elsewhere";
    stray.focus();

    receive({ roomId: "r1", name: "owner", value: "Bob" });

    expect(emit).not.toHaveBeenCalled();
    expect(survey.getValue("projectName")).toBeUndefined();
  });

  it("ignores an editor-shaped element with no id", () => {
    const survey = new Model(SURVEY_JSON);
    const { socket, emit, receive } = makeMockSocket();
    attachSurveySync({ survey, socket, roomId: "r1" });
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.value = "Apollo";
    input.focus();

    receive({ roomId: "r1", name: "owner", value: "Bob" });

    expect(emit).not.toHaveBeenCalled();
  });

  it("does not re-emit when the editor matches the model already", () => {
    const survey = new Model(SURVEY_JSON);
    const { socket, emit, receive } = makeMockSocket();
    attachSurveySync({ survey, socket, roomId: "r1" });
    survey.setValue("projectName", "Apollo");
    emit.mockClear();
    const typed = survey.getQuestionByName("projectName") as unknown as { inputId: string };
    focusEditorFor(typed, "Apollo");

    receive({ roomId: "r1", name: "owner", value: "Bob" });

    expect(emit).not.toHaveBeenCalled();
  });
});

describe("attachSurveySync: changes cascading from a remote value", () => {
  // Hiding a question clears its answer on this client. That clear is a local
  // change every peer has to hear about, even though it was set off by their
  // own edit — the old blanket "applying remote" flag swallowed it and left
  // the clients holding different data with nothing to reconcile them.
  const CASCADE_JSON = {
    clearInvisibleValues: "onHidden",
    elements: [
      { type: "text", name: "stage" },
      { type: "text", name: "details", visibleIf: "{stage} = 'open'" },
    ],
  };

  it("broadcasts a value the remote change cleared on this client", () => {
    const survey = new Model(CASCADE_JSON);
    const { socket, emit, receive } = makeMockSocket();
    attachSurveySync({ survey, socket, roomId: "r1" });
    survey.setValue("stage", "open");
    survey.setValue("details", "notes");
    emit.mockClear();

    // The peer closes the stage, which hides "details" here and clears it.
    receive({ roomId: "r1", name: "stage", value: "closed" });

    expect(survey.getValue("details")).toBeUndefined();
    expect(emit).toHaveBeenCalledWith("value-changed", {
      roomId: "r1",
      name: "details",
      value: undefined,
    });
  });

  it("still suppresses the echo of the value being applied", () => {
    const survey = new Model(CASCADE_JSON);
    const { socket, emit, receive } = makeMockSocket();
    attachSurveySync({ survey, socket, roomId: "r1" });

    receive({ roomId: "r1", name: "stage", value: "open" });

    expect(survey.getValue("stage")).toBe("open");
    expect(emit).not.toHaveBeenCalledWith("value-changed", {
      roomId: "r1",
      name: "stage",
      value: "open",
    });
  });
});
