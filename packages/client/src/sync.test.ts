import { describe, expect, it, vi } from "vitest";
import { Model, type QuestionMatrixDynamicModel } from "survey-core";
import { attachSurveySync, type SyncSocket } from "./sync";
import type { ValueChangedPayload } from "../../shared/events";

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
