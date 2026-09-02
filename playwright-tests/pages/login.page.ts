/**
 * playwright-tests/pages/login.page.ts
 *
 * Page Object Model for OrangeHRM Login Page
 * Encapsulates selectors and interactions for the login form.
 */

import { Page, expect } from "@playwright/test";

export class LoginPage {
  readonly page: Page;
  readonly baseUrl: string;

  // ── Selectors ────────────────────────────────────────────────────────

  readonly usernameInput = 'input[name="username"]';
  readonly passwordInput = 'input[name="password"]';
  readonly loginButton = 'button[type="submit"]';
  readonly errorAlert = ".oxd-alert-content-text";
  readonly forgotPasswordLink = 'a:has-text("Forgot your password?")';

  constructor(page: Page, baseUrl = "https://opensource-demo.orangehrmlive.com/") {
    this.page = page;
    this.baseUrl = baseUrl;
  }

  // ── Navigation ───────────────────────────────────────────────────────

  /**
   * Navigate to the login page.
   */
  async goto(): Promise<void> {
    await this.page.goto(`${this.baseUrl}web/index.php/auth/login`, {
      waitUntil: "domcontentloaded",
    });
  }

  // ── Form Interactions ────────────────────────────────────────────────

  /**
   * Fill the username field.
   */
  async fillUsername(username: string): Promise<void> {
    await this.page.fill(this.usernameInput, username);
  }

  /**
   * Fill the password field.
   */
  async fillPassword(password: string): Promise<void> {
    await this.page.fill(this.passwordInput, password);
  }

  /**
   * Click the login button.
   */
  async clickLoginButton(): Promise<void> {
    await this.page.click(this.loginButton);
  }

  /**
   * Login with provided credentials.
   * Combines fillUsername, fillPassword, and clickLoginButton.
   */
  async login(username: string, password: string): Promise<void> {
    await this.fillUsername(username);
    await this.fillPassword(password);
    await this.clickLoginButton();
  }

  // ── Assertions ───────────────────────────────────────────────────────

  /**
   * Assert that the login page is displayed.
   */
  async assertLoginPageDisplayed(): Promise<void> {
    await expect(this.page).toHaveTitle(/Login|OrangeHRM/i);
    await expect(this.page.locator(this.usernameInput)).toBeVisible();
    await expect(this.page.locator(this.passwordInput)).toBeVisible();
    await expect(this.page.locator(this.loginButton)).toBeVisible();
  }

  /**
   * Assert that an error message is displayed.
   */
  async assertErrorDisplayed(expectedMessage?: string): Promise<void> {
    const errorLocator = this.page.locator(this.errorAlert);
    await expect(errorLocator).toBeVisible();
    if (expectedMessage) {
      await expect(errorLocator).toContainText(expectedMessage);
    }
  }

  /**
   * Assert that a specific error message is shown.
   */
  async assertErrorMessage(message: string): Promise<void> {
    await expect(this.page.locator(this.errorAlert)).toContainText(message);
  }

  /**
   * Get the current error message text.
   */
  async getErrorMessage(): Promise<string | null> {
    const errorLocator = this.page.locator(this.errorAlert);
    const isVisible = await errorLocator.isVisible().catch(() => false);
    if (!isVisible) return null;
    return errorLocator.textContent();
  }
}
