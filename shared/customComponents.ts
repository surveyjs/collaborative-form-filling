import { ComponentCollection, Serializer } from "survey-core";

/**
 * Custom SurveyJS components used by the default schema (see
 * server/src/defaultSurvey.ts). Registration is a side effect of
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

// Composite: the shipping-address example under test. It is the interesting shape
// for collaboration - a nested `defaultValue`, an `enableIf` on `{composite.*}`,
// and an `onValueChanged` that writes one nested field from another.
ComponentCollection.Instance.add({
  name: "shippingaddress",
  title: "Shipping Address",
  defaultQuestionTitle: "Shipping Address",
  elementsJSON: [
    {
      type: "comment",
      name: "businessAddress",
      title: "Business Address",
      isRequired: true,
    },
    {
      type: "boolean",
      name: "shippingSameAsBusiness",
      title: "Shipping address same as business address",
      defaultValue: true,
    },
    {
      type: "comment",
      name: "shippingAddress",
      title: "Shipping Address",
      // Use the `composite` prefix to access a question nested in the composite question
      enableIf: "{composite.shippingSameAsBusiness} <> true",
      isRequired: true,
    },
  ],
  onInit() {
    // Hide title-related settings from the Property Grid
    Serializer.addProperty("shippingaddress", {
      name: "titleLocation",
      visible: false,
      default: "hidden",
    });
    Serializer.addProperty("shippingaddress", { name: "title", visible: false });
    Serializer.addProperty("shippingaddress", { name: "description", visible: false });
  },
  onValueChanged(question, propertyName) {
    const businessAddress = question.contentPanel.getQuestionByName("businessAddress");
    const shippingAddress = question.contentPanel.getQuestionByName("shippingAddress");
    const shippingSameAsBusiness = question.contentPanel.getQuestionByName("shippingSameAsBusiness");
    if (propertyName === "businessAddress") {
      // If "Shipping address same as business address" is selected
      if (shippingSameAsBusiness.value == true) {
        // Copy the Business Address value to Shipping Address
        shippingAddress.value = businessAddress.value;
      }
    }
    if (propertyName === "shippingSameAsBusiness") {
      // If selected, copy the Business Address to Shipping Address; otherwise clear it
      shippingAddress.value = shippingSameAsBusiness.value == true ? businessAddress.value : "";
    }
  },
});
