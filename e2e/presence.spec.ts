import { test, expect, type Page, type BrowserContext } from "@playwright/test";

async function joinRoom(context: BrowserContext, name: string, room: string): Promise<Page> {
  const page = await context.newPage();
  // With ?room= in the URL the join form hides the Room field and joins the
  // preset room, so only the name needs filling.
  await page.goto(`/?room=${room}`);
  await page.getByTestId("name-input").fill(name);
  await page.getByTestId("join-button").click();
  // Wait until the survey has rendered (room-state received).
  await expect(page.getByTestId("room-id")).toHaveText(room);
  await expect(page.getByText("Project name")).toBeVisible();
  return page;
}

/** The remote-focus ring stamped on a question root by presenceSync.ts. */
function focusRing(page: Page, questionName: string) {
  return page.locator(`[data-name="${questionName}"][data-collab-focus="on"]`);
}

test("focusing a question highlights it for other participants", async ({ browser }) => {
  const ROOM = "e2e-presence-focus";
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoom(ctxA, "Alice", ROOM);
  const pageB = await joinRoom(ctxB, "Bob", ROOM);

  // A focuses the text question -> B sees the ring and A's name badge.
  await pageA.getByLabel("Project name").click();
  await expect(focusRing(pageB, "projectName")).toBeVisible();
  await expect(pageB.locator(".collab-focus-badge")).toHaveText("Alice");

  // A types and blurs (which also commits the value -> value-changed).
  // The highlight must disappear on B and must NOT be resurrected by the
  // simultaneous value-changed event.
  await pageA.getByLabel("Project name").fill("Apollo");
  await pageA.getByText("Project Overview").click(); // click empty area to blur
  await expect(focusRing(pageB, "projectName")).toHaveCount(0);
  await expect(pageB.getByLabel("Project name")).toHaveValue("Apollo");

  await ctxA.close();
  await ctxB.close();
});

test("a late joiner sees the stored focus of active participants", async ({ browser }) => {
  const ROOM = "e2e-presence-late";
  const ctxA = await browser.newContext();
  const pageA = await joinRoom(ctxA, "Alice", ROOM);

  await pageA.getByLabel("Project name").click();

  // C joins after A already focused -> the highlight is seeded from room-state.
  const ctxC = await browser.newContext();
  const pageC = await joinRoom(ctxC, "Carol", ROOM);
  await expect(focusRing(pageC, "projectName")).toBeVisible();
  await expect(pageC.locator(".collab-focus-badge")).toHaveText("Alice");

  await ctxA.close();
  await ctxC.close();
});

test("a leaving participant's highlight is removed", async ({ browser }) => {
  const ROOM = "e2e-presence-leave";
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoom(ctxA, "Alice", ROOM);
  const pageB = await joinRoom(ctxB, "Bob", ROOM);

  await pageA.getByLabel("Project name").click();
  await expect(focusRing(pageB, "projectName")).toBeVisible();

  await ctxA.close();
  await expect(focusRing(pageB, "projectName")).toHaveCount(0);
  await expect(pageB.locator(".collab-focus-badge")).toBeHidden();

  await ctxB.close();
});

test("focusing a matrix cell highlights the whole matrix question", async ({ browser }) => {
  const ROOM = "e2e-presence-matrix";
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoom(ctxA, "Alice", ROOM);
  const pageB = await joinRoom(ctxB, "Bob", ROOM);

  // Page navigation is local to each client; move both to the Team page,
  // where the `members` matrixdynamic lives.
  for (const page of [pageA, pageB]) {
    await page.locator(".sd-navigation__next-btn").click();
    await expect(page.locator('[data-name="members"]')).toBeVisible();
  }

  // A focuses a cell input; the ring on B must target the top-level matrix
  // question (cell question names are not globally unique).
  await pageA.locator('[data-name="members"] input').first().click();
  await expect(focusRing(pageB, "members")).toBeVisible();
  await expect(pageB.locator(".collab-focus-badge")).toHaveText("Alice");

  await ctxA.close();
  await ctxB.close();
});

test("clicking a participant's chip follows them to their focused question", async ({ browser }) => {
  const ROOM = "e2e-presence-follow";
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoom(ctxA, "Alice", ROOM);
  const pageB = await joinRoom(ctxB, "Bob", ROOM);

  // A moves to the Team page and focuses a cell of the `members` matrix.
  await pageA.locator(".sd-navigation__next-btn").click();
  await expect(pageA.locator('[data-name="members"]')).toBeVisible();
  await pageA.locator('[data-name="members"] input').first().click();

  // B (still on page 1) clicks Alice's chip and lands on her question. The
  // click is retried: A's focus broadcast may not have reached B yet, and the
  // jump is idempotent.
  const chip = pageB.getByTestId("participants").getByTitle("Alice");
  await expect(chip).toBeVisible();
  await expect(async () => {
    await chip.click();
    await expect(pageB.locator('[data-name="members"]')).toBeInViewport({ timeout: 1_500 });
  }).toPass({ timeout: 15_000 });

  await ctxA.close();
  await ctxB.close();
});

test("clicking the chip of a peer without focus switches to their page", async ({ browser }) => {
  const ROOM = "e2e-presence-follow-page";
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoom(ctxA, "Alice", ROOM);
  const pageB = await joinRoom(ctxB, "Bob", ROOM);

  // A navigates to the Team page without focusing any question (the Next
  // button is not a question, so no focus is broadcast).
  await pageA.locator(".sd-navigation__next-btn").click();
  await expect(pageA.locator('[data-name="members"]')).toBeVisible();

  // B follows A's page (no focus, no scroll target — page switch only).
  const chip = pageB.getByTestId("participants").getByTitle("Alice");
  await expect(async () => {
    await chip.click();
    await expect(pageB.locator('[data-name="members"]')).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 15_000 });

  await ctxA.close();
  await ctxB.close();
});

test("following a peer works on a large lazy-rendering survey", async ({ browser }) => {
  const ROOM = "e2e-presence-follow-lazy";
  // 30 questions on page 2 — far beyond the lazy first batch, so the target
  // row has no DOM until forced to render by the follow jump.
  const LAZY_SCHEMA = {
    lazyRenderEnabled: true,
    pages: [
      { name: "p1", elements: [{ type: "text", name: "intro" }] },
      {
        name: "p2",
        elements: Array.from({ length: 30 }, (_, i) => ({
          type: "text",
          name: `q${i + 1}`,
        })),
      },
    ],
  };

  // A creates the room with the lazy schema (the lobby shows the schema field
  // only for rooms that don't exist yet, so A fills the form explicitly).
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await pageA.goto("/");
  await pageA.getByTestId("name-input").fill("Alice");
  await pageA.getByTestId("room-input").fill(ROOM);
  await pageA.getByTestId("survey-json-input").fill(JSON.stringify(LAZY_SCHEMA));
  await pageA.getByTestId("join-button").click();
  await expect(pageA.locator('[data-name="intro"]')).toBeVisible();

  // B joins manually too: joinRoom() waits for the default survey's label.
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto(`/?room=${ROOM}`);
  await pageB.getByTestId("name-input").fill("Bob");
  await pageB.getByTestId("join-button").click();
  await expect(pageB.locator('[data-name="intro"]')).toBeVisible();

  // A goes to page 2 and scrolls until the lazily rendered q30 appears,
  // then focuses it.
  await pageA.locator(".sd-navigation__next-btn").click();
  await expect(pageA.locator('[data-name="q1"]')).toBeVisible();
  await pageA.mouse.move(400, 300);
  await expect(async () => {
    await pageA.mouse.wheel(0, 3_000);
    await expect(pageA.locator('[data-name="q30"] input')).toBeVisible({ timeout: 300 });
  }).toPass({ timeout: 15_000 });
  await pageA.locator('[data-name="q30"] input').click();

  // B follows: the jump must switch the page, force-render q30's row and
  // scroll it into view.
  const chip = pageB.getByTestId("participants").getByTitle("Alice");
  await expect(chip).toBeVisible();
  await expect(async () => {
    await chip.click();
    await expect(pageB.locator('[data-name="q30"]')).toBeInViewport({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });

  await ctxA.close();
  await ctxB.close();
});

test("mouse movement shows a labeled cursor for other participants", async ({ browser }) => {
  const ROOM = "e2e-presence-cursor";
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoom(ctxA, "Alice", ROOM);
  const pageB = await joinRoom(ctxB, "Bob", ROOM);

  // Keep moving the mouse (distinct positions — identical ones are deduped)
  // until B renders the cursor: cursor packets are volatile and may be dropped
  // while B's socket is still upgrading right after joining; in real usage the
  // next move self-heals, so the test mirrors that. Existence + label only —
  // no position accuracy.
  const box = (await pageA.locator('[data-name="projectName"]').boundingBox())!;
  let step = 0;
  await expect(async () => {
    step += 1;
    await pageA.mouse.move(box.x + 20 + step * 5, box.y + box.height / 2);
    await expect(pageB.locator(".collab-cursor")).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 15_000 });
  await expect(pageB.locator(".collab-cursor-name")).toHaveText("Alice");

  await ctxA.close();
  await ctxB.close();
});

test("the cursor stays visible outside question blocks (nearest-question anchor)", async ({
  browser,
}) => {
  const ROOM = "e2e-presence-cursor-outside";
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoom(ctxA, "Alice", ROOM);
  const pageB = await joinRoom(ctxB, "Bob", ROOM);

  // A moves the mouse near the top-left of the window — over the app chrome,
  // far from any question. The cursor anchors to the nearest question and
  // must still render on B. Retried like the in-question cursor test above
  // (volatile packets may be dropped right after joining).
  let step = 0;
  await expect(async () => {
    step += 1;
    await pageA.mouse.move(10 + step * 3, 10);
    await expect(pageB.locator(".collab-cursor")).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 15_000 });
  await expect(pageB.locator(".collab-cursor-name")).toHaveText("Alice");

  await ctxA.close();
  await ctxB.close();
});
