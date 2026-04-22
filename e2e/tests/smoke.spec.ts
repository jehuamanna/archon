import { expect, test } from "@playwright/test";

test.describe("web smoke", () => {
  test("app shell mounts", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("archon-app-root")).toBeVisible({ timeout: 60_000 });
  });
});
