import { test, expect, type Page, type BrowserContext } from "@playwright/test";

/**
 * A multi-page custom schema with generic names/choices (q1, c1, …) so the test
 * reads as a pure schema-plumbing check. No `title` fields — SurveyJS renders
 * the question `name` as the visible label, so the names are exactly the strings
 * the selectors below target.
 */
const CUSTOM_SCHEMA = {
  showQuestionNumbers: "on",
  pages: [
    {
      name: "p1",
      elements: [
        { type: "text", name: "q1" },
        { type: "radiogroup", name: "q2", choices: ["c1", "c2", "c3"] },
        { type: "checkbox", name: "q3", choices: ["c1", "c2"] },
      ],
    },
    {
      name: "p2",
      elements: [
        { type: "rating", name: "q4", rateMax: 5 },
        { type: "comment", name: "q5" },
      ],
    },
  ],
};

/**
 * Joins a room, optionally pasting a custom SurveyJS schema. Waits on the first
 * custom question label (`q1`) rather than the default survey's "Project name".
 */
async function joinRoomWithSchema(
  context: BrowserContext,
  name: string,
  room: string,
  schema?: object,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/?room=${room}`);
  await page.getByTestId("name-input").fill(name);
  await page.getByTestId("room-input").fill(room);
  if (schema) {
    await page.getByTestId("survey-json-input").fill(JSON.stringify(schema));
  }
  await page.getByTestId("join-button").click();
  // room-id confirms we left the join form and entered the room; survey-specific
  // assertions in each test wait (auto-retry) for the model to render.
  await expect(page.getByTestId("room-id")).toHaveText(room);
  return page;
}

/** Advance the SurveyJS pager by one page. */
async function nextPage(page: Page): Promise<void> {
  await page.locator(".sd-navigation__next-btn").click();
}

test("custom schema renders for the creator", async ({ browser }) => {
  const ROOM = "e2e-custom";
  const ctx = await browser.newContext();
  const page = await joinRoomWithSchema(ctx, "Alice", ROOM, CUSTOM_SCHEMA);

  // First-page custom questions render (target the widgets by their name-derived
  // accessible labels — the title text alone also matches a hidden <legend>), and
  // the default survey does not.
  await expect(page.getByRole("textbox", { name: "q1" })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "q2" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "c1" })).toBeVisible();
  await expect(page.getByText("Project name")).toHaveCount(0);

  // Paging from the custom schema works: page 2 shows the rating (q4) and the
  // comment textarea (q5).
  await nextPage(page);
  await expect(page.locator(".sd-rating__item-text").first()).toBeVisible();
  await expect(page.getByRole("textbox", { name: "q5" })).toBeVisible();

  await ctx.close();
});

test("custom schema co-edits and propagates to a second joiner", async ({ browser }) => {
  const ROOM = "e2e-custom-sync";
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();

  // A creates the room with the custom schema; B joins it with no schema.
  const pageA = await joinRoomWithSchema(ctxA, "Alice", ROOM, CUSTOM_SCHEMA);
  const pageB = await joinRoomWithSchema(ctxB, "Bob", ROOM);

  // B received the custom schema (honored only on room creation).
  await expect(pageB.getByText("q1", { exact: true })).toBeVisible();

  // A edits the text question -> B sees it.
  const textA = pageA.getByLabel("q1");
  await textA.fill("hello");
  await textA.blur(); // SurveyJS text updates on blur by default
  await expect(pageB.getByLabel("q1")).toHaveValue("hello");

  // A selects a radiogroup option -> B sees it checked.
  await pageA.getByText("c2", { exact: true }).first().click();
  await expect(pageB.getByRole("radio", { name: "c2" })).toBeChecked();

  // A toggles a checkbox option -> B sees it checked. The text "c1" appears in
  // both q2 (radio) and q3 (checkbox), so scope to the q3 question container.
  // Click the label text: SurveyJS hides the native input behind an SVG
  // decorator that intercepts pointer events.
  await pageA.locator('[data-name="q3"]').getByText("c1", { exact: true }).click();
  await expect(pageB.getByRole("checkbox", { name: "c1" })).toBeChecked();

  // The rating (q4) lives on page 2 — advance both participants there.
  await nextPage(pageA);
  await nextPage(pageB);

  // A picks a rating -> B sees it selected. Click the item's text span; the
  // role="radio" wrapper delegates pointer events to it.
  await pageA.locator(".sd-rating__item-text", { hasText: /^4$/ }).click();
  await expect(pageB.getByRole("radio", { name: "4", exact: true })).toBeChecked();

  await ctxA.close();
  await ctxB.close();
});

test("the join form rejects malformed survey JSON", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/?room=e2e-badjson");
  await page.getByTestId("name-input").fill("Alice");
  await page.getByTestId("room-input").fill("e2e-badjson");
  await page.getByTestId("survey-json-input").fill("{ not json");
  await page.getByTestId("join-button").click();

  // Validation blocks completion: an inline error shows and we never join.
  await expect(page.getByText(/Invalid JSON/)).toBeVisible();
  await expect(page.getByTestId("room-id")).toHaveCount(0);

  await ctx.close();
});

test("an emptied room is reclaimed and the next creator's schema applies", async ({ browser }) => {
  const ROOM = "e2e-reclaim";

  // Alice creates the room with schema X (questions q1…), then leaves. As the
  // last participant, her departure prunes the room server-side.
  const ctxA = await browser.newContext();
  const pageA = await joinRoomWithSchema(ctxA, "Alice", ROOM, CUSTOM_SCHEMA);
  await expect(pageA.getByRole("textbox", { name: "q1" })).toBeVisible();
  await ctxA.close();

  // Let the server process the disconnect/prune before re-creating the room.
  // No UI signal exists for the prune, so this short settle is intentional.
  await new Promise((r) => setTimeout(r, 750));

  // Bob re-creates the same room id with a different schema Y (a single `z1`).
  const SCHEMA_Y = { pages: [{ name: "p1", elements: [{ type: "text", name: "z1" }] }] };
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto(`/?room=${ROOM}`);
  await pageB.getByTestId("name-input").fill("Bob");
  await pageB.getByTestId("room-input").fill(ROOM);
  await pageB.getByTestId("survey-json-input").fill(JSON.stringify(SCHEMA_Y));
  await pageB.getByTestId("join-button").click();

  // Bob gets schema Y — proving the room was reclaimed and re-created.
  await expect(pageB.getByRole("textbox", { name: "z1" })).toBeVisible();
  await expect(pageB.getByRole("textbox", { name: "q1" })).toHaveCount(0);

  await ctxB.close();
});

test("an expression question recomputes from synced answers on every client", async ({ browser }) => {
  const ROOM = "e2e-expression";
  // `sum` is derived from {a} + {b}; it is never edited directly — each client
  // recomputes it locally once the inputs sync over.
  const SCHEMA = {
    pages: [{
      name: "p1",
      elements: [
        { type: "text", name: "a", inputType: "number" },
        { type: "text", name: "b", inputType: "number" },
        { type: "expression", name: "sum", expression: "{a} + {b}" },
      ],
    }],
  };

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoomWithSchema(ctxA, "Alice", ROOM, SCHEMA);
  const pageB = await joinRoomWithSchema(ctxB, "Bob", ROOM);

  // Alice fills the two inputs; the expression resolves to 5 on her side.
  const aA = pageA.getByLabel("a", { exact: true });
  await aA.fill("2");
  await aA.blur();
  const bA = pageA.getByLabel("b", { exact: true });
  await bA.fill("3");
  await bA.blur();
  await expect(pageA.locator('[data-name="sum"]')).toContainText("5");

  // Bob receives a and b over the wire and recomputes the same expression.
  await expect(pageB.getByLabel("a", { exact: true })).toHaveValue("2");
  await expect(pageB.getByLabel("b", { exact: true })).toHaveValue("3");
  await expect(pageB.locator('[data-name="sum"]')).toContainText("5");

  await ctxA.close();
  await ctxB.close();
});

test("a visibleIf-gated question appears on every client when its condition is met", async ({ browser }) => {
  const ROOM = "e2e-visibleif";
  const SCHEMA = {
    pages: [{
      name: "p1",
      elements: [
        { type: "radiogroup", name: "hasPet", choices: ["yes", "no"] },
        { type: "text", name: "petName", visibleIf: "{hasPet} = 'yes'" },
      ],
    }],
  };

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoomWithSchema(ctxA, "Alice", ROOM, SCHEMA);
  const pageB = await joinRoomWithSchema(ctxB, "Bob", ROOM);

  // Gated question is hidden for everyone until the condition holds.
  await expect(pageA.getByRole("textbox", { name: "petName" })).toBeHidden();
  await expect(pageB.getByRole("textbox", { name: "petName" })).toBeHidden();

  // Alice selects "yes" -> the dependent question becomes visible on both
  // clients (Bob recomputes visibility from the synced {hasPet}).
  await pageA.getByText("yes", { exact: true }).click();
  await expect(pageA.getByRole("textbox", { name: "petName" })).toBeVisible();
  await expect(pageB.getByRole("textbox", { name: "petName" })).toBeVisible();

  // And the now-visible question still co-edits normally.
  const petA = pageA.getByLabel("petName", { exact: true });
  await petA.fill("Rex");
  await petA.blur();
  await expect(pageB.getByLabel("petName", { exact: true })).toHaveValue("Rex");

  await ctxA.close();
  await ctxB.close();
});
