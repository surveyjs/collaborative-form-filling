import { test, expect, type Page, type BrowserContext } from "@playwright/test";

async function joinRoom(context: BrowserContext, name: string, room: string): Promise<Page> {
  const page = await context.newPage();
  // No ?room= in the URL: with a preset room the join form hides the Room
  // field, so fill both inputs explicitly.
  await page.goto("/");
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

  // Presence: A eventually sees the OTHER participant (self is not shown).
  await expect(pageA.getByTestId("participants").getByRole("listitem")).toHaveCount(1);

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

  // Presence: when B leaves, A's roster of others empties.
  await ctxB.close();
  await expect(pageA.getByTestId("participants").getByRole("listitem")).toHaveCount(0);

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

test("clearing a matrixdynamic dropdown cell keeps the row for other participants", async ({ browser }) => {
  const ROOM = "e2e-matrix-clear";
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoom(ctxA, "Alice", ROOM);
  const pageB = await joinRoom(ctxB, "Bob", ROOM);

  await nextPage(pageA);
  await nextPage(pageB);
  await expect(pageB.getByText("Team members")).toBeVisible();

  // B picks a Role in the only row (first dropdown column) -> A sees it.
  // Click the dropdown container: an overlay wrapper intercepts pointer
  // events aimed at the inner combobox input. Scroll the table into view
  // first: focusing the combobox auto-scrolls the survey's inner scroller,
  // and survey-core hides an open dropdown popup on any scroller scroll.
  await pageB.getByRole("table").scrollIntoViewIfNeeded();
  await pageB.getByRole("table").locator(".sd-dropdown").first().click();
  await pageB.getByRole("option", { name: "Developer" }).click();
  await expect(pageA.getByRole("table")).toContainText("Developer");

  // B clears the cell via the dropdown's "x" button. survey-core collapses the
  // now-empty rows array; without outgoing normalization A received [] and the
  // whole row vanished (rowCount -> 0).
  await pageB.getByRole("table").locator(".sd-editor-clean-button").first().click();

  // A's cell empties but the row survives: the Name text cell is still there.
  await expect(pageA.getByRole("table")).not.toContainText("Developer");
  await expect(pageA.getByRole("table").getByRole("textbox").first()).toBeVisible();
  // B keeps their row too, and the cleared state converges on both sides.
  await expect(pageB.getByRole("table").getByRole("textbox").first()).toBeVisible();

  await ctxA.close();
  await ctxB.close();
});

test("adding and removing an empty matrixdynamic row syncs to other participants", async ({ browser }) => {
  const ROOM = "e2e-matrix-add-row";
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoom(ctxA, "Alice", ROOM);
  const pageB = await joinRoom(ctxB, "Bob", ROOM);

  await nextPage(pageA);
  await nextPage(pageB);
  await expect(pageB.getByText("Team members")).toBeVisible();

  // Each matrix row has exactly one text cell (the Name column), so the
  // textbox count inside the table equals the row count.
  const rowsOf = (page: Page) => page.getByRole("table").getByRole("textbox");
  await expect(rowsOf(pageA)).toHaveCount(1);

  // A adds an empty row. No cell is filled, so no value is written — the sync
  // must ride onMatrixRowAdded, not onValueChanged.
  await pageA.getByText("Add team member", { exact: true }).click();
  await expect(rowsOf(pageA)).toHaveCount(2);
  await expect(rowsOf(pageB)).toHaveCount(2);

  // B removes the (still empty) extra row -> A drops back to one row.
  await pageB.getByRole("table").getByRole("button", { name: "Remove" }).last().click();
  await expect(rowsOf(pageB)).toHaveCount(1);
  await expect(rowsOf(pageA)).toHaveCount(1);

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
  await expect(pageA.getByTestId("participants").getByRole("listitem")).toHaveCount(2);

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

  // Reload auto-rejoins: the client reads room and name from the URL the
  // lobby navigated to (/react/?room=<id>&name=<n>), no form involved.
  await pageA.reload();

  // Her answers are restored from the persisted room state.
  await expect(pageA.getByTestId("room-id")).toHaveText(ROOM);
  await expect(pageA.getByLabel("Project name")).toHaveValue("Apollo");
  await expect(pageA.getByRole("radio", { name: "Prototype" })).toBeChecked();

  await ctxA.close();
  await ctxB.close();
});

test("the bar shows only the other participants with distinct colors", async ({ browser }) => {
  const ROOM = "e2e-presence";
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoom(ctxA, "Alice", ROOM);
  const pageB = await joinRoom(ctxB, "Bob", ROOM);

  // Each side lists exactly the OTHER participant — never itself.
  const listA = pageA.getByTestId("participants");
  await expect(listA.getByRole("listitem")).toHaveCount(1);
  await expect(listA.getByRole("listitem").filter({ hasText: "Bob" })).toHaveCount(1);
  await expect(listA.getByText("Alice")).toHaveCount(0);

  const listB = pageB.getByTestId("participants");
  await expect(listB.getByRole("listitem")).toHaveCount(1);
  await expect(listB.getByRole("listitem").filter({ hasText: "Alice" })).toHaveCount(1);
  await expect(listB.getByText("Bob")).toHaveCount(0);

  // The two participants get different palette colors. The first <span> in
  // a listitem is the avatar circle carrying the color.
  const swatchOf = (list: ReturnType<Page["getByTestId"]>) =>
    list.getByRole("listitem").first().locator("span").first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await swatchOf(listA)).not.toBe(await swatchOf(listB));

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
