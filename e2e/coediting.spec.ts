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
  await expect(page.locator(".sv-collab-bar")).toContainText(`Room: ${room}`);
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
  await expect(pageA.locator(".sv-collab-bar__avatar")).toHaveCount(1);

  // A edits the text question -> B sees it.
  const textA = pageA.getByLabel("Project name");
  await textA.fill("Apollo");
  // SurveyJS commits a text input on blur; a peer answer flushes it too (see
  // the typing-clobber tests at the end of this file).
  await textA.blur();
  await expect(pageB.getByLabel("Project name")).toHaveValue("Apollo");

  // B selects a radiogroup option -> A sees it checked.
  await pageB.getByText("Prototype", { exact: true }).click();
  await expect(
    pageA.getByRole("radio", { name: "Prototype" }),
  ).toBeChecked();

  // Presence: when B leaves, A's roster of others empties.
  await ctxB.close();
  await expect(pageA.locator(".sv-collab-bar__avatar")).toHaveCount(0);

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
  await expect(pageA.locator(".sv-collab-bar__avatar")).toHaveCount(2);

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
  await expect(pageA.locator(".sv-collab-bar")).toContainText(`Room: ${ROOM}`);
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

  // The bar is the library's action bar now: one avatar button per OTHER
  // participant, its initials as the label and the full name on the title.
  const avatarsA = pageA.locator(".sv-collab-bar__avatar");
  await expect(avatarsA).toHaveCount(1);
  await expect(pageA.locator('.sv-collab-bar__avatar[title="Bob"]')).toHaveCount(1);
  await expect(pageA.locator('.sv-collab-bar__avatar[title="Alice"]')).toHaveCount(0);

  const avatarsB = pageB.locator(".sv-collab-bar__avatar");
  await expect(avatarsB).toHaveCount(1);
  await expect(pageB.locator('.sv-collab-bar__avatar[title="Alice"]')).toHaveCount(1);
  await expect(pageB.locator('.sv-collab-bar__avatar[title="Bob"]')).toHaveCount(0);

  // Distinct participants get distinct colours. The colour is a theme slot class
  // rather than an inline hex, so compare the resolved background.
  const swatch = (locator: ReturnType<Page["locator"]>) =>
    locator.first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await swatch(avatarsA)).not.toBe(await swatch(avatarsB));

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

/**
 * Schema for the typing-clobber tests. The checkbox deliberately sits on a
 * SECOND page: the reported symptom was a peer answering somewhere the typist
 * could not even see. No `title` fields, so the question `name` is the label.
 */
const TYPING_SCHEMA = {
  pages: [
    {
      name: "p1",
      elements: [
        { type: "text", name: "notes" },
        { type: "text", name: "email", inputType: "email" },
      ],
    },
    { name: "p2", elements: [{ type: "checkbox", name: "picks", choices: ["c1", "c2"] }] },
  ],
};

/**
 * Joins a room, pasting the schema only when creating it: the lobby hides the
 * schema field once the typed room already exists.
 */
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
  return page;
}

test("a peer's answers do not erase text being typed on another page", async ({ browser }) => {
  const ROOM = "e2e-typing-clobber";
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoomWithSchema(ctxA, "Alice", ROOM, TYPING_SCHEMA);
  const pageB = await joinRoomWithSchema(ctxB, "Bob", ROOM);
  await expect(pageA.getByLabel("notes")).toBeVisible();

  // Bob moves to the page Alice cannot see, then rattles through a checkbox.
  await nextPage(pageB);
  await expect(pageB.getByText("c1", { exact: true })).toBeVisible();

  // Alice types and NEVER leaves the field: SurveyJS keeps those characters in
  // the DOM only, which is exactly what Bob's answers used to wipe out.
  const notesA = pageA.getByLabel("notes");
  await notesA.click();
  // Driven at once: the two contexts are independent, and what the report
  // describes is a peer answering BETWEEN keystrokes. It is that packet - not
  // one arriving after the word is finished - that repaints the survey
  // mid-word. Alice types for longer than Bob needs for his clicks, so several
  // of his answers are guaranteed to land while she is still going.
  await Promise.all([
    notesA.pressSequentially("Apollo mission", { delay: 100 }),
    (async () => {
      for (let i = 0; i < 6; i++) {
        await pageB.getByText(i % 2 === 0 ? "c1" : "c2", { exact: true }).click();
      }
    })(),
  ]);

  await expect(notesA).toHaveValue("Apollo mission");
  await expect(notesA).toBeFocused();
  // The caret survived too, so she can simply carry on.
  await notesA.pressSequentially("-2", { delay: 30 });
  await expect(notesA).toHaveValue("Apollo mission-2");

  // The tail is still uncommitted, as SurveyJS intends - one more answer from
  // Bob flushes it, and it reaches him without Alice ever blurring.
  await pageB.getByText("c1", { exact: true }).click();
  await pageB.locator(".sd-navigation__prev-btn").click();
  await expect(pageB.getByLabel("notes")).toHaveValue("Apollo mission-2");

  await ctxA.close();
  await ctxB.close();
});

test("the rescue is not limited to plain text inputs", async ({ browser }) => {
  const ROOM = "e2e-typing-email";
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoomWithSchema(ctxA, "Alice", ROOM, TYPING_SCHEMA);
  const pageB = await joinRoomWithSchema(ctxB, "Bob", ROOM);
  await expect(pageA.getByLabel("email")).toBeVisible();
  await nextPage(pageB);

  // inputType "email" is outside survey-core's own onTyping support
  // (QuestionText.isTextValue covers text/number/password and dates only), so
  // this is the case a textUpdateMode change could never have covered.
  const emailA = pageA.getByLabel("email");
  await emailA.click();
  await Promise.all([
    emailA.pressSequentially("ann@example.com", { delay: 100 }),
    (async () => {
      for (let i = 0; i < 4; i++) {
        await pageB.getByText(i % 2 === 0 ? "c1" : "c2", { exact: true }).click();
      }
    })(),
  ]);

  await expect(emailA).toHaveValue("ann@example.com");
  await expect(emailA).toBeFocused();

  await ctxA.close();
  await ctxB.close();
});

test("a reconnected participant keeps syncing and stays on their page", async ({ browser }) => {
  const ROOM = "e2e-reconnect";
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoomWithSchema(ctxA, "Alice", ROOM, TYPING_SCHEMA);
  const pageB = await joinRoomWithSchema(ctxB, "Bob", ROOM);
  await expect(pageA.getByLabel("notes")).toBeVisible();

  // Alice walks to the second page, then loses the network briefly. A reconnect
  // hands her a new socket id, and the server tracks room membership per
  // socket — without re-joining she would be in no room at all from here on.
  await nextPage(pageA);
  await expect(pageA.getByText("c1", { exact: true })).toBeVisible();
  await ctxA.setOffline(true);
  await ctxA.setOffline(false);

  // She is still where she was, not thrown back to the first page.
  await expect(pageA.getByText("c1", { exact: true })).toBeVisible();

  // Sync works again in both directions.
  await pageA.getByText("c1", { exact: true }).click();
  await nextPage(pageB);
  await expect(pageB.getByRole("checkbox", { name: "c1" })).toBeChecked();

  await pageB.getByText("c2", { exact: true }).click();
  await expect(pageA.getByRole("checkbox", { name: "c2" })).toBeChecked();

  await ctxA.close();
  await ctxB.close();
});
