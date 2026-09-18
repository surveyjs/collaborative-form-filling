import { test, expect, type Page, type BrowserContext } from "@playwright/test";

async function joinRoom(context: BrowserContext, name: string, room: string): Promise<Page> {
  const page = await context.newPage();
  // With ?room= in the URL the join form hides the Room field and joins the
  // preset room, so only the name needs filling.
  await page.goto(`/?room=${room}`);
  await page.getByTestId("name-input").fill(name);
  await page.getByTestId("join-button").click();
  // Wait until the survey has rendered (room-state received).
  await expect(page.locator(".sv-collab-bar")).toContainText(`Room: ${room}`);
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
  await expect(pageB.locator(".collab-presence-badge")).toHaveText("Alice");

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
  await expect(pageC.locator(".collab-presence-badge")).toHaveText("Alice");

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
  await expect(pageB.locator(".collab-presence-badge")).toBeHidden();

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

  // The name badge is deliberately suppressed for a question outside the visible
  // part of the scroller (IDecoration.clip), so B has to be looking at the matrix
  // for it to be drawn. The form is the scroller now that the clients set
  // fitToContainer, which is what makes that clip a real viewport rather than the
  // full height of the content.
  await pageB.locator('[data-name="members"]').scrollIntoViewIfNeeded();
  await expect(pageB.locator(".collab-presence-badge")).toHaveText("Alice");

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
  const chip = pageB.locator(".sv-collab-bar").locator('.sv-collab-bar__avatar[title="Alice"]');
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
  const chip = pageB.locator(".sv-collab-bar").locator('.sv-collab-bar__avatar[title="Alice"]');
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
  const chip = pageB.locator(".sv-collab-bar").locator('.sv-collab-bar__avatar[title="Alice"]');
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
    await expect(pageB.locator(".collab-presence-cursor")).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 15_000 });
  await expect(pageB.locator(".collab-presence-cursor-name")).toHaveText("Alice");

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
    await expect(pageB.locator(".collab-presence-cursor")).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 15_000 });
  await expect(pageB.locator(".collab-presence-cursor-name")).toHaveText("Alice");

  await ctxA.close();
  await ctxB.close();
});

// One participant is one colour, measured in a real browser.
//
// The ring, the name badge, the cursor and the avatar in the strip are painted by
// three different mechanisms - an inline custom property, a fixed overlay outside
// the themed root, and a CSS slot class. Twice they drifted apart and the same
// person showed up in two colours at once, so this pins all of them to one source:
// the theme's user-colour slot, which is the only colour the relay's slot NUMBER
// ever resolves through.

test("every place a participant is drawn resolves the same colour", async ({ browser }) => {
  const ROOM = "colour-probe";
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ctxC = await browser.newContext();
  const pageA = await joinRoom(ctxA, "Alice", ROOM);
  const pageB = await joinRoom(ctxB, "Bob", ROOM);
  const pageC = await joinRoom(ctxC, "Carol", ROOM);

  // Alice focuses a question and moves her mouse, so Bob's page has to draw her
  // ring, her name badge, her cursor and her avatar all at once.
  await pageA.getByLabel("Project name").click();
  const box = await pageA.getByLabel("Project name").boundingBox();
  for (let i = 0; i < 6; i++) {
    await pageA.mouse.move((box?.x ?? 100) + i * 12, (box?.y ?? 100) + i * 6);
    await pageA.waitForTimeout(60);
  }

  await expect(pageB.locator(".collab-presence-badge", { hasText: "Alice" })).toBeVisible();
  await expect(pageB.locator(".collab-presence-cursor").first()).toBeVisible();

  const measured = await pageB.evaluate(() => {
    const cs = (el: Element | null, prop: string) =>
      el ? getComputedStyle(el).getPropertyValue(prop).trim() : null;
    const ring = document.querySelector("[data-collab-focus=\"on\"]") as HTMLElement | null;
    // Several peers each own a badge/cursor set; pick the ones drawn for Alice.
    const named = (sel: string) => Array.from(document.querySelectorAll(sel))
      .filter((el) => (el.textContent || "").trim() === "Alice")[0] ?? null;
    const badge = named(".collab-presence-badge");
    const cursorName = named(".collab-presence-cursor-name");
    const cursor = cursorName?.parentElement?.querySelector(".collab-presence-cursor path")
      ?? document.querySelector(".collab-presence-cursor path");
    const avatars = Array.from(document.querySelectorAll(".sv-collab-bar__avatar"));
    return {
      ringVar: ring ? ring.style.getPropertyValue("--collab-peer-color") : null,
      ringShadow: cs(ring, "box-shadow"),
      badgeBg: cs(badge, "background-color"),
      badgeFg: cs(badge, "color"),
      cursorFill: cursor?.getAttribute("fill") ?? null,
      cursorNameBg: cs(cursorName, "background-color"),
      cursorNameFg: cs(cursorName, "color"),
      avatars: avatars.map((a) => ({
        title: a.getAttribute("title"),
        bg: getComputedStyle(a).backgroundColor,
        fg: getComputedStyle(a).color,
        cls: (a.className.match(/--color-\d+/) || [null])[0],
      })),
    };
  });

  const hexToRgb = (h: string) => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h.trim());
    return m ? `rgb(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)})` : h;
  };

  const alice = measured.avatars.filter((a) => a.title === "Alice")[0];
  expect(alice, "Alice has an avatar on Bob's page").toBeTruthy();

  // Every surface that draws Alice agrees, and none of them is the reserved
  // "unknown user" slot 0.
  expect(hexToRgb(measured.ringVar as string)).toBe(alice.bg);
  expect(measured.badgeBg).toBe(alice.bg);
  expect(hexToRgb(measured.cursorFill as string)).toBe(alice.bg);
  expect(measured.cursorNameBg).toBe(alice.bg);
  expect(measured.badgeFg).toBe(alice.fg);
  expect(alice.cls).not.toBe("--color-0");

  // Carol is a different participant, so a different colour.
  const carol = measured.avatars.filter((a) => a.title === "Carol")[0];
  expect(carol).toBeTruthy();
  expect(carol.bg).not.toBe(alice.bg);
  expect(carol.cls).not.toBe("--color-0");

  await ctxA.close();
  await ctxB.close();
  await ctxC.close();
});

// Where the strip sits, measured rather than assumed.
//
// It used to be contributed to the `contentTop` container, which renders inside
// .sd-body: that put it below the form title, inset by .sd-body's 40px padding-top,
// and made its position:sticky inert, because contentTop wraps its content in a div
// exactly the strip's own height and a sticky element cannot leave its parent's box.
test("the collaboration bar is the top strip of the form and stays pinned", async ({ browser }) => {
  const ROOM = "e2e-bar-position";
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await joinRoom(ctxA, "Alice", ROOM);
  await joinRoom(ctxB, "Bob", ROOM);

  // Short viewport so the form definitely overflows and there is something to scroll.
  await pageA.setViewportSize({ width: 1024, height: 420 });
  await expect(pageA.locator('.sv-collab-bar__avatar[title="Bob"]')).toHaveCount(1);

  const bar = pageA.locator(".sv-collab-bar");
  // headerView defaults to "advanced", so the title block is .sv-header; the basic
  // title is covered too in case a schema ever turns headerView off.
  const title = pageA.locator(".sv-header, .sd-title.sd-container-modern__title").first();
  const root = pageA.locator(".sd-root-modern");

  const barBox = (await bar.boundingBox())!;
  const titleBox = (await title.boundingBox())!;
  const rootBox = (await root.boundingBox())!;

  // Above the title, not below it.
  expect(barBox.y + barBox.height).toBeLessThanOrEqual(titleBox.y + 1);
  // Flush with the top of the form: no padding inherited from a parent.
  expect(Math.abs(barBox.y - rootBox.y)).toBeLessThan(2);
  // Full width of the form, so it reads as a strip rather than as form content.
  expect(barBox.width).toBeGreaterThan(rootBox.width - 2);

  // Sticky: scroll the form well past the strip's natural position and it is still
  // pinned to the top, with the participants still on it.
  //
  // The wheel goes over the form rather than window.scrollTo, because the clients set
  // fitToContainer - the form is the scroller, which is what makes sticky mean
  // anything at all (survey-core wraps its content in .sv-scroll__scroller, and a
  // sticky element binds to that wrapper whether or not the page is what moves).
  await pageA.mouse.move(512, 300);
  await pageA.mouse.wheel(0, 2000);
  await pageA.waitForTimeout(400);

  const pinned = (await bar.boundingBox())!;
  // Pinned AT the top, not merely above it: a plain `y < 2` also passes for a strip
  // that scrolled away to y = -1011, which is exactly how this went unnoticed.
  expect(pinned.y).toBeGreaterThan(rootBox.y - 2);
  expect(pinned.y).toBeLessThan(rootBox.y + 2);
  await expect(bar).toBeInViewport();
  await expect(pageA.locator('.sv-collab-bar__avatar[title="Bob"]')).toHaveCount(1);
  // The form really did scroll, otherwise the assertions above prove nothing.
  const scrolled = await pageA.evaluate(
    () => (document.querySelector(".sv-scroll__scroller") as HTMLElement).scrollTop);
  expect(scrolled).toBeGreaterThan(100);

  await ctxA.close();
  await ctxB.close();
});

// The avatars overlap into one group, measured rather than assumed.
//
// Run against React AND Angular because those are the two shapes of action-bar markup
// the library emits: Angular puts a hidden <sv-ng-action> host between items, which
// breaks `+`, `:first-child` and `:nth-child` — silently, and only there. Vue and
// js-ui repeat the React shape. The pull-back is therefore driven by a class the model
// puts on every avatar but the first, and this is what proves it arrived.
for (const fw of [{ label: "React", prefix: "react" }, { label: "Angular", prefix: "angular" }]) {
  test(`participant avatars overlap into a stack (${fw.label})`, async ({ browser }) => {
    const ROOM = `e2e-stack-${fw.prefix}`;
    const contexts = [];
    // Four in the room, so the viewer sees three peers - two steps to compare, which
    // is what catches a rule that reached one renderer but not the other.
    for (const name of ["Alice", "Bob", "Cara"]) {
      const ctx = await browser.newContext();
      contexts.push(ctx);
      await joinRoom(ctx, name, ROOM);
    }
    const ctx = await browser.newContext();
    contexts.push(ctx);
    const page = await ctx.newPage();
    await page.goto(`/?room=${ROOM}`);
    await page.locator("[data-name='framework']").getByText(fw.label, { exact: true }).click();
    await page.getByTestId("name-input").fill("Cara");
    await page.getByTestId("join-button").click();
    await expect(page.locator(".sv-collab-bar__avatar")).toHaveCount(3);

    const boxes = await page.locator(".sv-collab-bar__avatar").evaluateAll(
      (els) => els.map((el) => el.getBoundingClientRect())
        .map((r) => ({ left: r.left, right: r.right, top: r.top, width: r.width }))
        .sort((a, b) => a.left - b.left));

    // Overlapping: each avatar starts before the one before it ends.
    expect(boxes[1].left).toBeLessThan(boxes[0].right);
    expect(boxes[2].left).toBeLessThan(boxes[1].right);
    // On one line.
    expect(Math.abs(boxes[1].top - boxes[0].top)).toBeLessThan(1);
    expect(Math.abs(boxes[2].top - boxes[0].top)).toBeLessThan(1);

    // A real bite out of the circle, but never so deep that it eats the initials -
    // which is the whole reason the overlap is smaller than the avatar's own padding.
    const overlap = boxes[0].right - boxes[1].left;
    expect(overlap).toBeGreaterThanOrEqual(2);
    expect(overlap).toBeLessThan(boxes[0].width / 2);

    // Both steps identical: an uneven step would mean the pull-back landed on some
    // avatars and not others, which is exactly how a renderer-specific selector fails.
    const steps = [boxes[1].left - boxes[0].left, boxes[2].left - boxes[1].left];
    expect(Math.abs(steps[0] - steps[1])).toBeLessThan(1);

    // The initials are 12px, not the 16px .sd-action__title declares on itself. Setting
    // a font-size on the button does nothing here - the text is in a nested span with
    // its own declaration - so this measures the one thing that actually decides it.
    const initialsFontSize = await page.locator(".sv-collab-bar__avatar .sd-action__title")
      .first().evaluate((el) => getComputedStyle(el).fontSize);
    expect(initialsFontSize).toBe("12px");

    // The Invite button is NOT pulled into the stack: only avatars carry the modifier.
    const invite = (await page.locator(".sv-collab-bar")
      .getByRole("button", { name: "Invite" }).first().boundingBox())!;
    expect(invite.x).toBeGreaterThan(boxes[2].right);

    for (const c of contexts) await c.close();
  });
}
