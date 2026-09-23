import { test, expect, type Page, type BrowserContext } from "@playwright/test";

/**
 * Diagnostic: collaboration on a COMPOSITE question, whose whole value travels
 * under a single key. The component is registered in shared/customComponents.ts
 * (a composite cannot be introduced through the lobby, which only carries JSON).
 */

const SCHEMA = {
  pages: [
    {
      name: "p1",
      elements: [
        { type: "text", name: "projectName", title: "Project name" },
        { type: "shippingaddress", name: "shipping" },
      ],
    },
  ],
};

async function joinRoomWithSchema(
  context: BrowserContext,
  name: string,
  room: string,
  schema?: object,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/");
  await page.getByTestId("name-input").fill(name);
  await page.getByTestId("room-input").fill(room);
  if (schema) {
    await page.getByTestId("survey-json-input").fill(JSON.stringify(schema));
  }
  await page.getByTestId("join-button").click();
  await expect(page.locator(".sv-collab-bar")).toContainText(`Room: ${room}`);
  await expect(page.locator('[data-name="shipping"]')).toBeVisible();
  return page;
}

const business = (page: Page) =>
  page.locator('[data-name="shipping"] [data-name="businessAddress"] textarea');
const shipping = (page: Page) =>
  page.locator('[data-name="shipping"] [data-name="shippingAddress"] textarea');
const sameSwitch = (page: Page) =>
  page.locator('[data-name="shipping"] [data-name="shippingSameAsBusiness"] input[type="checkbox"]');
const sameLabel = (page: Page) =>
  page.locator('[data-name="shipping"] [data-name="shippingSameAsBusiness"] label.sd-boolean');

/** Commits a textarea the way SurveyJS expects (value lands on blur). */
async function fillAndBlur(locator: ReturnType<typeof business>, text: string): Promise<void> {
  await locator.fill(text);
  await locator.blur();
}

test("a nested default declared by the schema is lost on joining a room", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await joinRoomWithSchema(ctx, "Alice", "e2e-comp-default", SCHEMA);

  // The schema says defaultValue: true. The room's (empty) init replaces
  // survey.data wholesale, so the box arrives indeterminate instead.
  await expect(sameSwitch(page)).not.toBeChecked();
  await expect(shipping(page)).not.toHaveAttribute("readonly", "");

  await ctx.close();
});

test("a cascade inside a composite reaches the peer as one object", async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoomWithSchema(ctxA, "Alice", "e2e-comp-cascade", SCHEMA);
  const pageB = await joinRoomWithSchema(ctxB, "Bob", "e2e-comp-cascade");

  // A ticks the box, so the component's onValueChanged starts mirroring.
  await sameLabel(pageA).click();
  await expect(sameSwitch(pageB)).toBeChecked();

  // A types the business address -> the handler copies it into the shipping one,
  // and BOTH fields must arrive at B.
  await fillAndBlur(business(pageA), "1 Main St");
  await expect(business(pageB)).toHaveValue("1 Main St");
  await expect(shipping(pageB)).toHaveValue("1 Main St");

  // Unticking clears the mirrored field on both sides and unlocks it.
  await sameLabel(pageA).click();
  await expect(sameSwitch(pageB)).not.toBeChecked();
  await expect(shipping(pageB)).toHaveValue("");
  await expect(business(pageB)).toHaveValue("1 Main St");

  await ctxA.close();
  await ctxB.close();
});

test("enableIf on {composite.*} is recomputed on every client", async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoomWithSchema(ctxA, "Alice", "e2e-comp-enableif", SCHEMA);
  const pageB = await joinRoomWithSchema(ctxB, "Bob", "e2e-comp-enableif");

  // survey-core renders a locked question as readonly, not disabled.
  await expect(shipping(pageB)).not.toHaveAttribute("readonly", "");
  await sameLabel(pageA).click();                       // -> true, so the field locks
  await expect(shipping(pageB)).toHaveAttribute("readonly", "");
  await sameLabel(pageA).click();                       // -> false, so it unlocks
  await expect(shipping(pageB)).not.toHaveAttribute("readonly", "");

  await ctxA.close();
  await ctxB.close();
});

test("two participants editing different fields in turn keep both values", async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoomWithSchema(ctxA, "Alice", "e2e-comp-turns", SCHEMA);
  const pageB = await joinRoomWithSchema(ctxB, "Bob", "e2e-comp-turns");

  await fillAndBlur(business(pageA), "1 Main St");
  await expect(business(pageB)).toHaveValue("1 Main St");

  await fillAndBlur(shipping(pageB), "5 Pine Ave");
  await expect(shipping(pageA)).toHaveValue("5 Pine Ave");
  await expect(business(pageA)).toHaveValue("1 Main St");
  await expect(business(pageB)).toHaveValue("1 Main St");

  await ctxA.close();
  await ctxB.close();
});

test("a late joiner sees the composite as the room has it", async ({ browser }) => {
  const ctxA = await browser.newContext();
  const pageA = await joinRoomWithSchema(ctxA, "Alice", "e2e-comp-late", SCHEMA);
  await fillAndBlur(business(pageA), "1 Main St");
  await fillAndBlur(shipping(pageA), "5 Pine Ave");

  const ctxB = await browser.newContext();
  const pageB = await joinRoomWithSchema(ctxB, "Bob", "e2e-comp-late");

  await expect(business(pageB)).toHaveValue("1 Main St");
  await expect(shipping(pageB)).toHaveValue("5 Pine Ave");
  // And the joiner must not push its own state back over the author's.
  await expect(business(pageA)).toHaveValue("1 Main St");
  await expect(shipping(pageA)).toHaveValue("5 Pine Ave");

  await ctxA.close();
  await ctxB.close();
});

test("text typed in a composite survives a peer editing the same composite", async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoomWithSchema(ctxA, "Alice", "e2e-comp-clobber", SCHEMA);
  const pageB = await joinRoomWithSchema(ctxB, "Bob", "e2e-comp-clobber");

  // Alice types into one nested field and never leaves it: SurveyJS keeps those
  // characters in the DOM only.
  await business(pageA).click();
  await business(pageA).type("1 Main St", { delay: 30 });

  // Bob ticks the box in the SAME composite. His object does not carry Alice's
  // characters, and it arrives under the same key.
  await sameLabel(pageB).click();

  // Bob's toggle lands on Alice, and her half-typed text stays where she is typing it.
  await expect(sameSwitch(pageA)).toBeChecked();
  await expect(business(pageA)).toHaveValue("1 Main St");
  await expect(business(pageA)).toBeFocused();

  // And Bob ends up with the same composite - both halves, not just his own.
  await expect(business(pageB)).toHaveValue("1 Main St");
  await expect(sameSwitch(pageB)).toBeChecked();

  await ctxA.close();
  await ctxB.close();
});

test("focusing a nested field highlights the whole composite for the peer", async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoomWithSchema(ctxA, "Alice", "e2e-comp-focus", SCHEMA);
  const pageB = await joinRoomWithSchema(ctxB, "Bob", "e2e-comp-focus");

  await business(pageA).click();

  await expect(pageB.locator('[data-name="shipping"][data-collab-focus="on"]')).toBeVisible();
  await expect(
    pageB.locator('[data-name="shipping"] [data-name="businessAddress"][data-collab-focus="on"]'),
  ).toHaveCount(0);

  await ctxA.close();
  await ctxB.close();
});
