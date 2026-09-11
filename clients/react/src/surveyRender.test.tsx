import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { ComponentCollection, Model } from "survey-core";
import { Survey } from "survey-react-ui";
import { attachSurveySync, type SyncSocket } from "../../../shared/sync";
import type { ValueChangedPayload } from "../../../shared/events";

/**
 * Renders a real <Survey> to cover the half of the bug that lives in the view
 * layer: SurveyJS keeps a text input uncommitted until blur, and
 * survey-react-ui rewrites that input from the model on every re-render. A
 * peer's answer triggers such a re-render, so without the commit in
 * attachSurveySync the typed characters are gone (see "characterizes" below).
 *
 * The schema is written for this test rather than taken from the server
 * default: room schemas are arbitrary, so the cases here are the shapes that
 * are hard to reach - a nested composite, a matrix cell, and an inputType the
 * library treats differently.
 */

// Own component name so this file never collides with the app registration.
const COMPOSITE = "rendertestcontact";
ComponentCollection.Instance.add({
  name: COMPOSITE,
  elementsJSON: [{ type: "text", name: "fullName", title: "Full name" }],
});
afterAll(() => ComponentCollection.Instance.remove(COMPOSITE));

/**
 * Multi-page on purpose. On a trivial single-page model the survey emits only
 * one property change (lazy `triggers` init) and the re-render that destroys
 * the text does not reliably happen - the test would pass either way.
 */
const ROOM_JSON = {
  pages: [
    {
      name: "overview",
      elements: [
        { type: "text", name: "projectName", title: "Project name" },
        { type: "text", name: "contactEmail", title: "Email", inputType: "email" },
        { type: "checkbox", name: "stack", title: "Stack", choices: ["React", "Docker"] },
        {
          type: "matrixdynamic",
          name: "members",
          title: "Members",
          rowCount: 1,
          columns: [{ name: "member", cellType: "text" }],
        },
        { type: COMPOSITE, name: "lead", title: "Lead" },
      ],
    },
    {
      name: "team",
      elements: [{ type: "text", name: "owner", title: "Owner" }],
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

  return { socket, emit, receive };
}

/**
 * Types without ever leaving the field - the state the bug needs. Dispatching
 * the native "input" event is what React binds onChange to, and under the
 * default textUpdateMode ("onBlur") survey-core deliberately does NOT copy it
 * into the model, so the characters live only in the DOM.
 */
function typeInto(input: HTMLInputElement, text: string): void {
  input.focus();
  for (let i = 1; i <= text.length; i++) {
    act(() => {
      input.value = text.slice(0, i);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
}

function renderRoom(options: { sync: boolean } = { sync: true }) {
  const survey = new Model(ROOM_JSON);
  const { socket, emit, receive: deliver } = makeMockSocket();
  const detach = options.sync
    ? attachSurveySync({ survey, socket, roomId: "r1" })
    : () => {};
  const view = render(<Survey model={survey} />);
  const input = (name: string) =>
    view.container.querySelector<HTMLInputElement>(`[data-name="${name}"] input`)!;
  // act(): a socket handler is outside React, so the re-render it schedules
  // is batched. Flushing it here is what the browser does on the next tick -
  // and flushing is exactly when the input gets overwritten.
  const receive = (payload: ValueChangedPayload) => act(() => deliver(payload));
  return { survey, emit, receive, detach, input, container: view.container };
}

afterEach(() => cleanup());

describe("a peer's answer while someone is typing", () => {
  it("does not erase the in-progress text, and keeps focus and caret", () => {
    const { survey, receive, input, detach } = renderRoom();

    typeInto(input("projectName"), "Apollo");

    // Mimics the report: a peer rattling through checkbox toggles. Each one
    // repaints the whole survey on this client.
    receive({ roomId: "r1", name: "stack", value: ["React"] });
    receive({ roomId: "r1", name: "stack", value: ["React", "Docker"] });
    receive({ roomId: "r1", name: "stack", value: ["Docker"] });

    expect(input("projectName")).toHaveValue("Apollo");
    expect(input("projectName")).toHaveFocus();
    expect(input("projectName").selectionStart).toBe("Apollo".length);
    // The peer's answer still landed - the text is rescued, not prioritised.
    expect(survey.getValue("stack")).toEqual(["Docker"]);

    detach();
  });

  it("characterizes the underlying view-layer bug (no sync attached)", () => {
    const { survey, input } = renderRoom({ sync: false });

    typeInto(input("projectName"), "Apollo");
    // Exactly what onRemoteChange does, minus the commit that rescues the text.
    act(() => survey.setValue("stack", ["React"]));

    // survey-react-ui's SurveyQuestionUncontrolledElement.updateDomElement
    // wrote the (empty) model value back over the focused input.
    expect(input("projectName")).toHaveValue("");
  });

  it("survives an answer to a question on another page", () => {
    const { receive, input, detach } = renderRoom();

    typeInto(input("projectName"), "Apollo");
    receive({ roomId: "r1", name: "owner", value: "Bob" });

    expect(input("projectName")).toHaveValue("Apollo");
    detach();
  });

  it("rescues an inputType the library excludes from onTyping", () => {
    const { receive, input, detach } = renderRoom();

    // survey-core's QuestionText.isTextValue() covers only text/number/password
    // and date types, so "email" can never be kept in step by textUpdateMode.
    // Note: jsdom throws on selectionStart for this input type.
    typeInto(input("contactEmail"), "ann@example.com");
    receive({ roomId: "r1", name: "stack", value: ["React"] });

    expect(input("contactEmail")).toHaveValue("ann@example.com");
    expect(input("contactEmail")).toHaveFocus();
    detach();
  });

  it("rescues a matrix cell and a composite's inner field", () => {
    const { receive, container, detach } = renderRoom();

    const cell = container.querySelector<HTMLInputElement>(
      '[data-name="members"] table input',
    )!;
    typeInto(cell, "Ann");
    receive({ roomId: "r1", name: "stack", value: ["React"] });
    expect(cell).toHaveValue("Ann");

    const nested = container.querySelector<HTMLInputElement>(
      '[data-name="lead"] [data-name="fullName"] input',
    )!;
    typeInto(nested, "Bob");
    receive({ roomId: "r1", name: "stack", value: ["Docker"] });
    expect(nested).toHaveValue("Bob");

    detach();
  });

  it("broadcasts the rescued text instead of stranding it in the model", () => {
    const { emit, receive, input, detach } = renderRoom();

    typeInto(input("projectName"), "Apollo");
    expect(emit).not.toHaveBeenCalled(); // still uncommitted, as SurveyJS wants

    receive({ roomId: "r1", name: "stack", value: ["React"] });

    // Without this the value would never reach the server: blur would no
    // longer change anything, so onValueChanged would never fire for it.
    expect(emit).toHaveBeenCalledWith("value-changed", {
      roomId: "r1",
      name: "projectName",
      value: "Apollo",
    });

    detach();
  });
});
