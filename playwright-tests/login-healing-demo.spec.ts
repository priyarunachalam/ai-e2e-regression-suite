/**
 * login-healing-demo.spec.ts
 *
 * Intentionally uses the WRONG selector  button[type="submit"]
 * to simulate a real-world selector-drift failure.
 *
 * Step 1 — run this file → 1 test FAILS (selector not found)
 * Step 2 — healing engine patches it to  button[type="submit"]
 * Step 3 — re-run → PASSES
 */

import { test, expect } from "@playwright/test";
import path from "node:path";

const BASE_URL =
  process.env["BASE_URL"] ?? "https://opensource-demo.orangehrmlive.com/";

test.describe("ECOM-LOGIN-001 · Self-Healing Demo", () => {
  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status !== "passed") {
      await page.screenshot({
        path: path.join(
          "screenshots",
          `${testInfo.title.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9-]/g, "")}-FAILED.png`,
        ),
        fullPage: true,
      });
    }
  });

  /**
   * BROKEN TEST — button[type="submit"] does not exist on OrangeHRM.
   * The real submit button is  button[type="submit"].
   * The self-healing engine will detect this and suggest the correct selector.
   */
  test("Healing scenario: login-btn selector drifted to button[type=submit]", async ({
    page,
  }) => {
    await page.goto(BASE_URL);

    await page.fill('input[name="username"]', "Admin");
    await page.fill('input[name="password"]', "admin123");

    // ← THIS SELECTOR IS INTENTIONALLY WRONG to trigger healing
    await page.locator('button[type="submit"]').click({ timeout: 5000 });

    await expect(page).toHaveURL(/dashboard/i);
  });
});
