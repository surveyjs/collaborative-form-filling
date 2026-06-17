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

test("a late participant sees answers that were already filled in", async ({ browser }) => {
  const ROOM = "e2e-late-join";
  const ctxA = await browser.newContext();
  const pageA = await joinRoom(ctxA, "Alice", ROOM);

  // Alice fills part of the form before anyone else joins.
  const textA = pageA.getByLabel("Project name");
  await textA.fill("Apollo");
  await textA.blur(); // SurveyJS text updates (and persists) on blur
  await pageA.getByText("Prototype", { exact: true }).click();
  // Confirm Alice's own value landed before Bob joins (the radio click and blur
  // are what push the values to the server's room state).
  await expect(pageA.getByRole("radio", { name: "Prototype" })).toBeChecked();

  // Bob joins the room afterwards and should immediately see Alice's answers,
  // hydrated from the persisted room state (room-state.data on join).
  const ctxB = await browser.newContext();
  const pageB = await joinRoom(ctxB, "Bob", ROOM);
  await expect(pageB.getByLabel("Project name")).toHaveValue("Apollo");
  await expect(pageB.getByRole("radio", { name: "Prototype" })).toBeChecked();

  await ctxA.close();
  await ctxB.close();
});

test("an edit fans out to all participants in a three-person room", async ({ browser }) => {
  const ROOM = "e2e-trio";
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ctxC = await browser.newContext();
  const pageA = await joinRoom(ctxA, "Alice", ROOM);
  const pageB = await joinRoom(ctxB, "Bob", ROOM);
  const pageC = await joinRoom(ctxC, "Carol", ROOM);

  // Presence: Alice eventually sees all three participants.
  await expect(pageA.getByTestId("participants").getByRole("listitem")).toHaveCount(3);

  // A single edit by Alice fans out to both Bob and Carol.
  const textA = pageA.getByLabel("Project name");
  await textA.fill("Apollo");
  await textA.blur();
  await expect(pageB.getByLabel("Project name")).toHaveValue("Apollo");
  await expect(pageC.getByLabel("Project name")).toHaveValue("Apollo");

  await ctxA.close();
  await ctxB.close();
  await ctxC.close();
});

test("edits are isolated to their own room", async ({ browser }) => {
  // Two clients share iso-1; one observer sits in iso-2.
  const ctxA = await browser.newContext();
  const ctxA2 = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoom(ctxA, "Alice", "iso-1");
  const pageA2 = await joinRoom(ctxA2, "Amy", "iso-1");
  const pageB = await joinRoom(ctxB, "Bob", "iso-2");

  const textA = pageA.getByLabel("Project name");
  await textA.fill("Apollo");
  await textA.blur();

  // Same-room client receives it (proves the broadcast actually fired)...
  await expect(pageA2.getByLabel("Project name")).toHaveValue("Apollo");
  // ...but the other room never sees it.
  await expect(pageB.getByLabel("Project name")).toHaveValue("");

  await ctxA.close();
  await ctxA2.close();
  await ctxB.close();
});

test("reloading rejoins the room and restores previous answers", async ({ browser }) => {
  const ROOM = "e2e-reload";
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoom(ctxA, "Alice", ROOM);
  // Bob stays connected so the room isn't pruned while Alice reconnects.
  await joinRoom(ctxB, "Bob", ROOM);

  const textA = pageA.getByLabel("Project name");
  await textA.fill("Apollo");
  await textA.blur();
  await pageA.getByText("Prototype", { exact: true }).click();
  await expect(pageA.getByRole("radio", { name: "Prototype" })).toBeChecked();

  // Reload drops Alice back to the join form (room prefilled from ?room=).
  await pageA.reload();
  await pageA.getByTestId("name-input").fill("Alice");
  await pageA.getByTestId("join-button").click();

  // Her answers are restored from the persisted room state.
  await expect(pageA.getByTestId("room-id")).toHaveText(ROOM);
  await expect(pageA.getByLabel("Project name")).toHaveValue("Apollo");
  await expect(pageA.getByRole("radio", { name: "Prototype" })).toBeChecked();

  await ctxA.close();
  await ctxB.close();
});

test("presence marks the current user and assigns distinct colors", async ({ browser }) => {
  const ROOM = "e2e-presence";
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoom(ctxA, "Alice", ROOM);
  const pageB = await joinRoom(ctxB, "Bob", ROOM);

  const listA = pageA.getByTestId("participants");
  await expect(listA.getByRole("listitem")).toHaveCount(2);
  // Each client sees itself tagged "(you)" and the other plain.
  await expect(listA.getByRole("listitem").filter({ hasText: "Alice (you)" })).toHaveCount(1);
  await expect(listA.getByRole("listitem").filter({ hasText: "Bob" })).toHaveCount(1);
  await expect(listA.getByText("Bob (you)")).toHaveCount(0);

  const listB = pageB.getByTestId("participants");
  await expect(listB.getByRole("listitem").filter({ hasText: "Bob (you)" })).toHaveCount(1);
  await expect(listB.getByText("Alice (you)")).toHaveCount(0);

  // The two presence dots get different palette colors. The first <span> in
  // each listitem is the color swatch (Presence.tsx).
  const swatch = (i: number) =>
    listA.getByRole("listitem").nth(i).locator("span").first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await swatch(0)).not.toBe(await swatch(1));

  await ctxA.close();
  await ctxB.close();
});

test("last write wins when two participants edit the same question", async ({ browser }) => {
  const ROOM = "e2e-lww";
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoom(ctxA, "Alice", ROOM);
  const pageB = await joinRoom(ctxB, "Bob", ROOM);

  // Alice writes first; Bob sees it.
  const textA = pageA.getByLabel("Project name");
  await textA.fill("First");
  await textA.blur();
  await expect(pageB.getByLabel("Project name")).toHaveValue("First");

  // Bob overwrites the same question; both converge on the later value.
  const textB = pageB.getByLabel("Project name");
  await textB.fill("Second");
  await textB.blur();
  await expect(pageA.getByLabel("Project name")).toHaveValue("Second");
  await expect(pageB.getByLabel("Project name")).toHaveValue("Second");

  await ctxA.close();
  await ctxB.close();
});
