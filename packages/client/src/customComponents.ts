import { ComponentCollection } from "survey-core";

/**
 * Custom SurveyJS components used by the default schema (see
 * packages/server/src/defaultSurvey.ts). Registration is a side effect of
 * importing this module — it must run before any Model is constructed, so the
 * client imports it from CollaborativeSurvey before building a survey.
 */

// Composite: a single "contact person" unit — name + email + phone.
ComponentCollection.Instance.add({
  name: "contactinfo",
  title: "Contact person",
  elementsJSON: [
    { type: "text", name: "fullName", title: "Full name", isRequired: true },
    {
      type: "text",
      name: "email",
      title: "Email",
      inputType: "email",
      validators: [{ type: "email" }],
    },
    { type: "text", name: "phone", title: "Phone", inputType: "tel" },
  ],
});

// Composite: a three-point effort estimate (optimistic / likely / pessimistic).
ComponentCollection.Instance.add({
  name: "effortestimate",
  title: "Effort estimate (days)",
  elementsJSON: [
    {
      type: "text",
      name: "optimistic",
      title: "Optimistic",
      inputType: "number",
      min: 0,
      startWithNewLine: false,
    },
    {
      type: "text",
      name: "likely",
      title: "Likely",
      inputType: "number",
      min: 0,
      startWithNewLine: false,
    },
    {
      type: "text",
      name: "pessimistic",
      title: "Pessimistic",
      inputType: "number",
      min: 0,
      startWithNewLine: false,
    },
  ],
});
