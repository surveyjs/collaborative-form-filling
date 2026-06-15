import { describe, expect, it, vi } from "vitest";
import { Model } from "survey-core";
import { attachSurveySync, type SyncSocket } from "./sync";
import type { ValueChangedPayload } from "../../shared/events";

const SURVEY_JSON = {
  elements: [
    { type: "text", name: "projectName" },
    { type: "text", name: "owner" },
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
