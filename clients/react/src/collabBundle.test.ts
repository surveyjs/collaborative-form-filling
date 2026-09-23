import { describe, expect, it } from "vitest";
import { ComponentCollection, Model, Serializer, settings } from "survey-core";
import { CollaborationPlugin } from "survey-core/collaboration";

/**
 * The singleton canary.
 *
 * `survey-core/collaboration` is built with `survey-core` marked external precisely so
 * the two halves share one module closure - one Serializer, one settings object, one
 * Base identity. If that ever breaks (an inlined copy, a stale link, a bundler that
 * resolves the two through different real paths) the plugin quietly decorates a survey
 * nobody is rendering, with no error anywhere. The e2e suite would eventually catch it;
 * this catches it in milliseconds.
 */
describe("survey-core/collaboration shares one survey-core", () => {
  it("the plugin drives the same model instance the app created", () => {
    const survey = new Model({ elements: [{ type: "text", name: "q1" }] });
    const collab = new CollaborationPlugin(survey);
    expect(collab.survey).toBe(survey);

    const sent: Array<any> = [];
    collab.onEvent.add((_sender, o) => sent.push(o.message));
    survey.setValue("q1", "typed");
    // A second survey-core copy would leave this silent: the plugin's event wiring
    // would be attached to a different SurveyModel class than the one that fired.
    expect(sent).toEqual([{ type: "value", key: "q1", value: "typed" }]);
  });

  it("the shared singletons are reachable from both halves", () => {
    // These are module-level singletons in survey-core. Their mere presence here, in a
    // bundle that also loaded the collaboration entry, is what a duplicated copy breaks.
    expect(Serializer).toBeDefined();
    expect(settings).toBeDefined();
    expect(ComponentCollection.Instance).toBeDefined();
    expect(Serializer.findClass("survey")).toBeTruthy();
  });

  it("a custom component registered by the app is visible to the plugin's model", () => {
    ComponentCollection.Instance.add({
      name: "collabcanary",
      questionJSON: { type: "text" },
    });
    const survey = new Model({ elements: [{ type: "collabcanary", name: "c1" }] });
    const collab = new CollaborationPlugin(survey);
    const sent: Array<any> = [];
    collab.onEvent.add((_sender, o) => sent.push(o.message));
    survey.setValue("c1", "x");
    expect(survey.getQuestionByName("c1")).toBeTruthy();
    expect(sent).toHaveLength(1);
  });
});
