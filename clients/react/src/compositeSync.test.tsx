import { afterAll, afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { ComponentCollection, Model } from "survey-core";
import { Survey } from "survey-react-ui";
import { CollaborationPlugin } from "survey-core/collaboration";

/**
 * Diagnostic: collaboration on COMPOSITE questions in a real render.
 *
 * A composite's whole value travels under ONE key - the composite's own name -
 * so anything that writes a nested field writes the same key a peer's value
 * arrives under. That interaction only exists once there is a DOM, focus and a
 * re-render, which is why it lives here rather than in the plugin's own tests.
 */

const SHIPPING = "compositesynctest";
ComponentCollection.Instance.add({
  name: SHIPPING,
  elementsJSON: [
    { type: "text", name: "businessAddress", title: "Business Address" },
    { type: "boolean", name: "shippingSameAsBusiness", title: "Same as business", defaultValue: true },
    {
      type: "text", name: "shippingAddress", title: "Shipping Address",
      enableIf: "{composite.shippingSameAsBusiness} <> true",
    },
  ],
  onValueChanged(question: any, propertyName: string) {
    const businessAddress = question.contentPanel.getQuestionByName("businessAddress");
    const shippingAddress = question.contentPanel.getQuestionByName("shippingAddress");
    const shippingSameAsBusiness = question.contentPanel.getQuestionByName("shippingSameAsBusiness");
    if (propertyName === "businessAddress" && shippingSameAsBusiness.value == true) {
      shippingAddress.value = businessAddress.value;
    }
    if (propertyName === "shippingSameAsBusiness") {
      shippingAddress.value = shippingSameAsBusiness.value == true ? businessAddress.value : "";
    }
  },
} as any);
afterAll(() => ComponentCollection.Instance.remove(SHIPPING));

const ROOM_JSON = {
  pages: [
    {
      name: "overview",
      elements: [
        { type: "text", name: "projectName", title: "Project name" },
        { type: "checkbox", name: "stack", title: "Stack", choices: ["React", "Docker"] },
        { type: SHIPPING, name: "shipping", title: "Shipping" },
      ],
    },
    { name: "team", elements: [{ type: "text", name: "owner", title: "Owner" }] },
  ],
};

function typeInto(input: HTMLInputElement, text: string): void {
  input.focus();
  for (let i = 1; i <= text.length; i++) {
    act(() => {
      input.value = text.slice(0, i);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
}

function renderRoom() {
  const survey = new Model(ROOM_JSON);
  const sent: Array<any> = [];
  const plugin = new CollaborationPlugin(survey, { presence: false, bar: false });
  plugin.onEvent.add((_s, o) => sent.push(o.message));
  const view = render(<Survey model={survey} />);
  const nested = (field: string) =>
    view.container.querySelector<HTMLInputElement>(`[data-name="shipping"] [data-name="${field}"] input`)!;
  const receive = (name: string, value: unknown) =>
    act(() => plugin.apply({ type: "value", key: name, value }));
  const applyInit = (valuesMap: Record<string, unknown>) =>
    act(() => plugin.apply({ type: "init", values: valuesMap } as any));
  return {
    survey, sent, receive, applyInit, nested,
    values: () => sent.filter((m) => m.type === "value"),
    detach: () => plugin.dispose(),
    container: view.container,
  };
}

afterEach(() => cleanup());

describe("typing inside a composite while a peer edits", () => {
  it("keeps in-progress text when the peer answers a DIFFERENT question", () => {
    const { nested, receive, detach } = renderRoom();

    typeInto(nested("businessAddress"), "1 Main St");
    receive("stack", ["React"]);

    expect(nested("businessAddress")).toHaveValue("1 Main St");
    expect(nested("businessAddress")).toHaveFocus();
    detach();
  });

  it("keeps in-progress text when the peer edits the SAME composite", () => {
    const { survey, nested, receive, detach } = renderRoom();

    typeInto(nested("businessAddress"), "1 Main St");
    // The peer toggled the checkbox inside the same composite. Its object travels under
    // the composite's key and carries no trace of the characters that live only in this
    // client's DOM, so applying it used to wipe them.
    receive("shipping", { shippingSameAsBusiness: false });

    expect(nested("businessAddress")).toHaveValue("1 Main St");
    expect(nested("businessAddress")).toHaveFocus();
    // The peer's own field still lands: the caret's field is kept, not prioritised.
    expect(survey.getValue("shipping")).toEqual({
      businessAddress: "1 Main St",
      shippingSameAsBusiness: false,
    });
    detach();
  });

  it("broadcasts the merged composite, so the peers do not keep a stale object", () => {
    const { nested, receive, values, detach } = renderRoom();

    typeInto(nested("businessAddress"), "1 Main St");
    receive("shipping", { shippingSameAsBusiness: false });

    // Whatever the peers saw last must carry BOTH halves - otherwise the rescue would
    // only move the divergence to the other side.
    const last = values()[values().length - 1].value;
    expect(last.businessAddress).toBe("1 Main St");
    expect(last.shippingSameAsBusiness).toBe(false);
    detach();
  });

});

describe("nested defaultValue in a rendered composite", () => {
  it("a rendered composite does not re-emit its nested default after init", () => {
    const { survey, applyInit, values, detach } = renderRoom();

    applyInit({ shipping: { businessAddress: "9 Oak Rd" } });
    act(() => { survey.currentPageNo = 1; });
    act(() => { survey.currentPageNo = 0; });

    expect(values()).toHaveLength(0);
    detach();
  });
});
