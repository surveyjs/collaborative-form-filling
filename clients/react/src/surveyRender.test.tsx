import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { ComponentCollection, Model } from "survey-core";
import { Survey } from "survey-react-ui";
import { CollaborationPlugin } from "survey-core/collaboration";

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
  const sent: Array<any> = [];
  // No transport to fake: the plugin emits events and takes messages, so the test
  // plays the relay itself.
  const plugin = options.sync
    ? new CollaborationPlugin(survey, { presence: false, bar: false })
    : null;
  plugin?.onEvent.add((_s, o) => sent.push(o.message));
  const view = render(<Survey model={survey} />);
  const input = (name: string) =>
    view.container.querySelector<HTMLInputElement>(`[data-name="${name}"] input`)!;
  // act(): applying a peer message happens outside React, so the re-render it
  // schedules is batched. Flushing it here is what the browser does on the next
  // tick - and flushing is exactly when the input gets overwritten.
  const receive = (name: string, value: unknown) =>
    act(() => plugin?.apply({ type: "value", key: name, value }));
  const detach = () => plugin?.dispose();
  return { survey, sent, receive, detach, input, container: view.container };
}

afterEach(() => cleanup());

describe("a peer's answer while someone is typing", () => {
  it("does not erase the in-progress text, and keeps focus and caret", () => {
    const { survey, receive, input, detach } = renderRoom();

    typeInto(input("projectName"), "Apollo");

    // Mimics the report: a peer rattling through checkbox toggles. Each one
    // repaints the whole survey on this client.
    receive("stack", ["React"]);
    receive("stack", ["React", "Docker"]);
    receive("stack", ["Docker"]);

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
    receive("owner", "Bob");

    expect(input("projectName")).toHaveValue("Apollo");
    detach();
  });

  it("rescues an inputType the library excludes from onTyping", () => {
    const { receive, input, detach } = renderRoom();

    // survey-core's QuestionText.isTextValue() covers only text/number/password
    // and date types, so "email" can never be kept in step by textUpdateMode.
    // Note: jsdom throws on selectionStart for this input type.
    typeInto(input("contactEmail"), "ann@example.com");
    receive("stack", ["React"]);

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
    receive("stack", ["React"]);
    expect(cell).toHaveValue("Ann");

    const nested = container.querySelector<HTMLInputElement>(
      '[data-name="lead"] [data-name="fullName"] input',
    )!;
    typeInto(nested, "Bob");
    receive("stack", ["Docker"]);
    expect(nested).toHaveValue("Bob");

    detach();
  });

  it("broadcasts the rescued text instead of stranding it in the model", () => {
    const { sent, receive, input, detach } = renderRoom();

    typeInto(input("projectName"), "Apollo");
    expect(sent).toHaveLength(0); // still uncommitted, as SurveyJS wants

    receive("stack", ["React"]);

    // Without this the value would never reach the server: blur would no
    // longer change anything, so onValueChanged would never fire for it.
    expect(sent).toContainEqual({ type: "value", key: "projectName", value: "Apollo" });

    detach();
  });
});

/**
 * The participants strip is contributed to the "header" layout container. This is
 * the consumer-side check that the choice actually holds through a real render of
 * survey-react-ui, which is where the previous container ("contentTop") failed:
 * contentTop renders inside .sd-body and only while a page is showing.
 *
 * CSS is not loaded here, so this asserts the half that is structure - document
 * order and survival - while the e2e suite asserts the painted geometry.
 */
describe("the collaboration bar in a real render", () => {
  function renderWithBar() {
    // A title of its own: the advanced header renders nothing when it has no content,
    // and an absent header would make the ordering check below vacuous.
    const survey = new Model({ ...ROOM_JSON, title: "Room form" });
    const plugin = new CollaborationPlugin(survey, { presence: false });
    const view = render(<Survey model={survey} />);
    return { survey, plugin, container: view.container };
  }

  it("renders before the survey's own header, not inside the form body", () => {
    const { plugin, container } = renderWithBar();

    const bar = container.querySelector(".sv-collab-bar")!;
    expect(bar).toBeTruthy();
    // Outside .sd-body: that element's padding-top is what used to push the strip
    // down, and its wrapper div is what made position:sticky inert.
    expect(bar.closest(".sd-body")).toBeNull();
    expect(bar.parentElement?.className).toContain("sd-container-modern");

    // headerView defaults to "advanced", so the survey title is a layout element in
    // the same container; the strip's index is what puts it first.
    const header = container.querySelector(".sv-header")!;
    expect(header).toBeTruthy();
    expect(bar.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();

    plugin.dispose();
  });

  it("is still there once the form is completed", () => {
    const { survey, plugin, container } = renderWithBar();
    expect(container.querySelector(".sv-collab-bar")).toBeTruthy();

    act(() => {
      survey.doComplete();
    });

    // People are still in the room after someone finishes, so the strip has to
    // outlive the pages. In contentTop it did not: that container is rendered only
    // while isShowingPage is true.
    expect(container.querySelector(".sv-collab-bar")).toBeTruthy();

    plugin.dispose();
  });
});
