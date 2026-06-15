import { test, expect, type Page, type BrowserContext } from "@playwright/test";

async function joinRoom(context: BrowserContext, name: string, room: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/?room=${room}`);
  await page.getByTestId("name-input").fill(name);
  await page.getByTestId("room-input").fill(room);
  await page.getByTestId("join-button").click();
  // Wait until the survey has rendered (room-state received).
  await expect(page.getByTestId("room-id")).toHaveText(room);
  await expect(page.getByText("Project name")).toBeVisible();
  return page;
}

/** Advance the SurveyJS pager by one page. */
async function nextPage(page: Page): Promise<void> {
  await page.locator(".sd-navigation__next-btn").click();
}

test("two participants co-edit one survey response in real time", async ({ browser }) => {
  const ROOM = "e2e-room";
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoom(ctxA, "Alice", ROOM);
  const pageB = await joinRoom(ctxB, "Bob", ROOM);

  // Presence: A should eventually see two participants.
  await expect(pageA.getByTestId("participants").getByRole("listitem")).toHaveCount(2);

  // A edits the text question -> B sees it.
  const textA = pageA.getByLabel("Project name");
  await textA.fill("Apollo");
  await textA.blur(); // SurveyJS text updates on blur by default
  await expect(pageB.getByLabel("Project name")).toHaveValue("Apollo");

  // B selects a radiogroup option -> A sees it checked.
  await pageB.getByText("Prototype", { exact: true }).click();
  await expect(
    pageA.getByRole("radio", { name: "Prototype" }),
  ).toBeChecked();

  // Presence: when B leaves, A drops back to a single participant.
  await ctxB.close();
  await expect(pageA.getByTestId("participants").getByRole("listitem")).toHaveCount(1);

  await ctxA.close();
});

test("co-edit checkbox and rating on the overview page", async ({ browser }) => {
  const ROOM = "e2e-overview";
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoom(ctxA, "Alice", ROOM);
  const pageB = await joinRoom(ctxB, "Bob", ROOM);

  // A toggles a checkbox option -> B sees it checked. Click the label text:
  // SurveyJS hides the native input behind an SVG decorator that intercepts
  // pointer events, so .check() on the role lands on the wrong element.
  await pageA.getByText("TypeScript", { exact: true }).click();
  await expect(pageB.getByRole("checkbox", { name: "TypeScript" })).toBeChecked();

  // B picks a rating -> A sees it selected. Click the item's text span; the
  // role="radio" wrapper delegates pointer events to it.
  await pageB.locator(".sd-rating__item-text", { hasText: /^4$/ }).click();
  await expect(pageA.getByRole("radio", { name: "4", exact: true })).toBeChecked();

  await ctxA.close();
  await ctxB.close();
});

test("co-edit the custom contactinfo component on the team page", async ({ browser }) => {
  const ROOM = "e2e-contact";
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoom(ctxA, "Alice", ROOM);
  const pageB = await joinRoom(ctxB, "Bob", ROOM);

  // Both navigate to the "Team" page where the custom component lives.
  await nextPage(pageA);
  await nextPage(pageB);
  await expect(pageA.getByText("Project lead")).toBeVisible();

  // A fills the composite component's email field -> B sees the value.
  const emailA = pageA.getByLabel("Email");
  await emailA.fill("lead@example.com");
  await emailA.blur();
  await expect(pageB.getByLabel("Email")).toHaveValue("lead@example.com");

  await ctxA.close();
  await ctxB.close();
});

test("co-edit a matrixdynamic row on the team page", async ({ browser }) => {
  const ROOM = "e2e-matrix";
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoom(ctxA, "Alice", ROOM);
  const pageB = await joinRoom(ctxB, "Bob", ROOM);

  await nextPage(pageA);
  await nextPage(pageB);
  await expect(pageA.getByText("Team members")).toBeVisible();

  // A fills the first row's "Member" cell -> B sees it. The matrixdynamic
  // syncs the whole rows array on each cell edit (last-write-wins per question).
  const cellA = pageA.getByRole("table").getByRole("textbox").first();
  await cellA.fill("Alice");
  await cellA.blur();

  const cellB = pageB.getByRole("table").getByRole("textbox").first();
  await expect(cellB).toHaveValue("Alice");

  await ctxA.close();
  await ctxB.close();
});
