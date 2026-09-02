/**
 * playwright-tests/pages/dashboard.page.ts
 *
 * Page Object Model for OrangeHRM Dashboard
 * Encapsulates selectors and interactions after successful login.
 */

import { Page, expect } from "@playwright/test";

export class DashboardPage {
  readonly page: Page;

  // ── Selectors ────────────────────────────────────────────────────────

  readonly pageHeader = ".oxd-topbar-header-breadcrumb";
  readonly userMenuButton = ".oxd-userdropdown-name";
  readonly logoutOption = 'a:has-text("Logout")';

  constructor(page: Page) {
    this.page = page;
  }

  // ── Assertions ───────────────────────────────────────────────────────

  /**
   * Assert that the dashboard is displayed after login.
   */
  async assertDashboardDisplayed(): Promise<void> {
    await expect(this.page).toHaveURL(/dashboard/i);
    await expect(this.page.locator(this.pageHeader)).toBeVisible();
  }

  /**
   * Assert that the user is logged in (page header visible).
   */
  async assertUserLoggedIn(): Promise<void> {
    // Check that we're on the dashboard and the header is visible
    await expect(this.page.locator(this.pageHeader)).toBeVisible();
  }

  /**
   * Get the current page URL.
   */
  async getCurrentUrl(): Promise<string> {
    return this.page.url();
  }

  // ── Actions ──────────────────────────────────────────────────────────

  /**
   * Click the user menu dropdown.
   */
  async clickUserMenu(): Promise<void> {
    await this.page.click(this.userMenuButton);
  }

  /**
   * Logout from the application.
   */
  async logout(): Promise<void> {
    await this.clickUserMenu();
    await this.page.click(this.logoutOption);
    await this.page.waitForNavigation({ url: /auth\/login/i });
  }
}
