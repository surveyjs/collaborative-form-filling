import { test, expect, type Page, type BrowserContext } from "@playwright/test";

/**
 * Cross-framework smoke: the lobby's framework picker routes to the right
 * client app (/react/, /js/, /vue/, /angular/), and every client wires the
 * same collaboration stack (answer sync + participants bar) against a React
 * peer in the same room.
 */

/** Joins a room through the lobby, picking a framework card first. */
async function joinVia(
  context: BrowserContext,
  name: string,
  room: string,
  frameworkLabel: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/?room=${room}`);
  await page
    .locator("[data-name='framework']")
    .getByText(frameworkLabel, { exact: true })
    .click();
  await page.getByTestId("name-input").fill(name);
  await page.getByTestId("join-button").click();
  await expect(page.getByTestId("room-id")).toHaveText(room);
  await expect(page.getByText("Project name")).toBeVisible();
  return page;
}

test("the lobby offers all four framework cards", async ({ page }) => {
  await page.goto("/");
  const picker = page.locator("[data-name='framework']");
  for (const label of ["React", "JS", "Vue", "Angular"]) {
    await expect(picker.getByText(label, { exact: true })).toBeVisible();
  }
});

for (const fw of [
  { label: "React", prefix: "react" },
  { label: "JS", prefix: "js" },
  { label: "Vue", prefix: "vue" },
  { label: "Angular", prefix: "angular" },
]) {
  test(`${fw.label} client joins via the lobby and co-edits with a React peer`, async ({ browser }) => {
    const ROOM = `e2e-fw-${fw.prefix}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();

    // A (React) creates the room; B joins with the framework under test.
    const pageA = await joinVia(ctxA, "Alice", ROOM, "React");
    const pageB = await joinVia(ctxB, "Bob", ROOM, fw.label);

    // The lobby routed B to the framework's mount point.
    expect(new URL(pageB.url()).pathname).toBe(`/${fw.prefix}/`);

    // Each side's bar lists exactly the OTHER participant (self is hidden).
    await expect(pageA.getByTestId("participants").getByRole("listitem")).toHaveCount(1);
    await expect(pageB.getByTestId("participants").getByRole("listitem")).toHaveCount(1);
    await expect(
      pageB.getByTestId("participants").getByRole("listitem").filter({ hasText: "Alice" }),
    ).toHaveCount(1);

    // B edits -> A sees it; A edits -> B sees it.
    const textB = pageB.getByLabel("Project name");
    await textB.fill("Apollo");
    await textB.blur();
    await expect(pageA.getByLabel("Project name")).toHaveValue("Apollo");

    // Click the label text: SurveyJS hides the native radio input behind an
    // SVG decorator that intercepts pointer events.
    await pageA.getByText("Prototype", { exact: true }).click();
    await expect(pageB.getByRole("radio", { name: "Prototype" })).toBeChecked();

    // B leaving empties A's roster of others.
    await ctxB.close();
    await expect(pageA.getByTestId("participants").getByRole("listitem")).toHaveCount(0);
    await ctxA.close();
  });
}
