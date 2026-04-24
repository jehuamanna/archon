import { expect, test } from "@playwright/test";

/**
 * End-to-end coverage for the Admin Spaces CRUD flow (Plans-Phase-2).
 *
 * The e2e harness in this repo currently does not have an authenticated-admin
 * + seeded-space fixture. The tests below are written against the real
 * `data-testid` attributes the SpaceSettingsPanel + sidebar expose, but are
 * marked `test.fixme` until the harness can boot the app, log in as an org
 * admin, and seed a normal space. Once that infra lands (follow-up in the
 * Phase-2 summary), delete the `test.fixme` calls to turn the tests on.
 *
 * Selectors pinned here:
 *   - `[data-testid="space-row-<id>"]`        sidebar row for a space
 *   - `[data-testid="sidebar-show-hidden-toggle"]`  sidebar visibility toggle
 *   - `[data-testid="space-settings-panel"]`  the panel root
 *   - `[data-testid="space-name"]`            read-only name span
 *   - `[data-testid="space-rename-button"]`   enters rename mode
 *   - `[data-testid="space-name-input"]`      inline rename input
 *   - `[data-testid="space-name-save"]`       explicit save button
 *   - `[data-testid="space-hide-toggle"]`     hide/unhide
 *   - `[data-testid="space-delete-button"]`   delete (opens confirm dialog)
 *   - `[data-testid="space-hidden-badge"]`    "(hidden)" badge in the header
 *   - `[data-testid="space-settings-error"]`  inline error surface
 */

test.describe("admin spaces CRUD", () => {
  test.fixme(
    "selecting a space opens the settings panel",
    async ({ page }) => {
      await page.goto("/admin");
      await page.getByTestId(/^space-row-/).first().click();
      await expect(page.getByTestId("space-settings-panel")).toBeVisible();
    },
  );

  test.fixme("rename commits on Save", async ({ page }) => {
    await page.goto("/admin");
    const row = page.getByTestId(/^space-row-/).first();
    await row.click();
    await page.getByTestId("space-rename-button").click();
    await page.getByTestId("space-name-input").fill("Engineering-2");
    await page.getByTestId("space-name-save").click();
    await expect(page.getByTestId("space-name")).toHaveText("Engineering-2");
  });

  test.fixme("hide toggle dims the sidebar entry", async ({ page }) => {
    await page.goto("/admin");
    const row = page.getByTestId(/^space-row-/).first();
    const rowId = await row.getAttribute("data-testid");
    await row.click();
    await page.getByTestId("space-hide-toggle").click();
    await expect(page.getByTestId("space-hidden-badge")).toBeVisible();
    if (rowId) {
      await expect(page.getByTestId(rowId)).toHaveAttribute(
        "data-hidden",
        "true",
      );
    }
  });

  test.fixme(
    'Hide hidden sidebar toggle filters hidden rows from the view',
    async ({ page }) => {
      await page.goto("/admin");
      const row = page.getByTestId(/^space-row-/).first();
      await row.click();
      await page.getByTestId("space-hide-toggle").click();
      const rowId = await row.getAttribute("data-testid");
      await page.getByTestId("sidebar-show-hidden-toggle").click();
      if (rowId) {
        await expect(page.getByTestId(rowId)).toHaveCount(0);
      }
    },
  );

  test.fixme(
    "delete confirms via dialog and removes the space",
    async ({ page }) => {
      await page.goto("/admin");
      const row = page.getByTestId(/^space-row-/).first();
      const rowId = await row.getAttribute("data-testid");
      await row.click();
      await page.getByTestId("space-delete-button").click();
      await page.getByRole("button", { name: "Delete forever" }).click();
      if (rowId) {
        await expect(page.getByTestId(rowId)).toHaveCount(0);
      }
      await expect(page.getByTestId("space-settings-panel")).toHaveCount(0);
    },
  );

  test.fixme(
    "server error (e.g. name_conflict) renders inline, state unchanged",
    async ({ page }) => {
      await page.goto("/admin");
      const row = page.getByTestId(/^space-row-/).first();
      await row.click();
      await page.getByTestId("space-rename-button").click();
      await page.getByTestId("space-name-input").fill("ClashingName");
      await page.getByTestId("space-name-save").click();
      await expect(page.getByTestId("space-settings-error")).toBeVisible();
      await expect(page.getByTestId("space-settings-error")).toContainText(
        /already exists|name_conflict/i,
      );
    },
  );

  test.fixme(
    "SpaceSwitcher: admin renames a space from the dropdown",
    async ({ page }) => {
      await page.goto("/");
      // Open the top-bar space switcher.
      await page.getByTitle("Switch space").click();
      const adminRow = page.getByTestId(/^space-switcher-row-/).first();
      const rowTestId = await adminRow.getAttribute("data-testid");
      const spaceId = rowTestId?.replace("space-switcher-row-", "") ?? "";
      await page.getByTestId(`space-switcher-more-${spaceId}`).click();
      await page.getByTestId(`space-switcher-rename-${spaceId}`).click();
      await page.getByTestId("space-switcher-rename-input").fill("Renamed-1");
      await page.getByTestId("space-switcher-rename-input").press("Enter");
      await expect(adminRow).toContainText("Renamed-1");
    },
  );

  test.fixme(
    "SpaceSwitcher: admin deletes a space from the dropdown (confirm dialog)",
    async ({ page }) => {
      await page.goto("/");
      await page.getByTitle("Switch space").click();
      const adminRow = page.getByTestId(/^space-switcher-row-/).first();
      const rowTestId = await adminRow.getAttribute("data-testid");
      const spaceId = rowTestId?.replace("space-switcher-row-", "") ?? "";
      await page.getByTestId(`space-switcher-more-${spaceId}`).click();
      await page.getByTestId(`space-switcher-delete-${spaceId}`).click();
      await page.getByRole("button", { name: "Delete forever" }).click();
      await expect(
        page.getByTestId(`space-switcher-row-${spaceId}`),
      ).toHaveCount(0);
    },
  );
});
