/**
 * healing-demo.ts — Self-Healing Live Demo
 *
 * Demonstrates the full self-healing loop against the live OrangeHRM site:
 *
 *  1. Open Chromium and navigate to the login page
 *  2. Try the BROKEN selector  [data-testid="login-btn"]  → fails
 *  3. DomInspector captures all visible interactive elements
 *  4. MockAzureOpenAiClient returns the correct replacement
 *  5. ApprovalGate auto-approves (confidence 0.94 ≥ threshold 0.85)
 *  6. SpecPatcher rewrites login-healing-demo.spec.ts with the healed selector
 *  7. Re-run the patched spec via PlaywrightCliRunner → PASSES
 *
 * Run:  npx ts-node scripts/healing-demo.ts
 */

import path from "node:path";
import fs from "node:fs";

import { chromium } from "@playwright/test";

import {
  MockAzureOpenAiClient,
  HealingSuggestion,
  DomElement,
} from "../healing/azure-openai-client";
import { FileHealingStore } from "../healing/healing-store";
import {
  DomInspector,
  SelfHealingEngine,
  ConsoleHealingLogger,
} from "../healing/self-healing-engine";
import { SpecPatcher, PlaywrightCliRunner } from "../agent/orchestrator";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL =
  process.env["BASE_URL"] ??
  "https://opensource-demo.orangehrmlive.com/";

const FAILING_SELECTOR = '[data-testid="login-btn"]';
const SPEC_FILE = path.join(
  process.cwd(),
  "playwright-tests",
  "login-healing-demo.spec.ts",
);

// Pre-configured mock AI suggestion — mirrors what GPT-4o returns for this page
const MOCK_SUGGESTIONS: Record<string, HealingSuggestion> = {
  [FAILING_SELECTOR]: {
    candidateSelector: 'button[type="submit"]',
    confidence: 0.94,
    reasoning:
      'No element with data-testid="login-btn" exists on the page. ' +
      'The only visible submit button is <button type="submit"> with text "Login". ' +
      'This is the direct functional replacement for the login action.',
    alternatives: [
      '.oxd-button--medium',
      'button.oxd-button',
    ],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hr(char = "─", width = 62): string {
  return char.repeat(width);
}

function section(title: string): void {
  console.log(`\n${hr()}`);
  console.log(`  ${title}`);
  console.log(hr());
}

function tick(msg: string): void {
  console.log(`  ✅  ${msg}`);
}

function cross(msg: string): void {
  console.log(`  ❌  ${msg}`);
}

function info(msg: string): void {
  console.log(`  ℹ   ${msg}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  section("🩹 AI Self-Healing Demo — OrangeHRM Login");
  info(`Target   : ${BASE_URL}`);
  info(`Spec     : ${path.relative(process.cwd(), SPEC_FILE)}`);
  info(`Selector : ${FAILING_SELECTOR}  ← intentionally broken`);

  // ── Step 1: Open browser ─────────────────────────────────────────────────
  section("Step 1 · Open Chromium and navigate to login page");
  const browser = await chromium.launch({ headless: false, slowMo: 300 });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  tick(`Navigated to ${page.url()}`);
  info(`Page title: ${await page.title()}`);

  // ── Step 2: Try the broken selector ─────────────────────────────────────
  section(`Step 2 · Attempt action with broken selector`);
  info(`Trying: page.locator('${FAILING_SELECTOR}').click()`);

  let selectorFailed = false;
  try {
    await page.locator(FAILING_SELECTOR).click({ timeout: 4000 });
  } catch (err) {
    selectorFailed = true;
    const message = err instanceof Error ? err.message.split("\n")[0] : "Unknown";
    cross(`Selector not found — ${message}`);

    // Capture failure screenshot
    const screenshotPath = path.join("screenshots", "healing-demo-step2-failure.png");
    await page.screenshot({ path: screenshotPath, fullPage: false });
    info(`Screenshot saved → ${screenshotPath}`);
  }

  if (!selectorFailed) {
    tick("Selector worked — nothing to heal");
    await browser.close();
    return;
  }

  // ── Step 3: DOM Inspection ──────────────────────────────────────────────
  section("Step 3 · DomInspector extracts interactive elements");
  const inspector = new DomInspector();
  const domElements: DomElement[] = await inspector.extractInteractiveElements(page);
  tick(`Found ${domElements.length} interactive elements`);
  info("Top 5 candidates:");
  domElements.slice(0, 5).forEach((el, i) => {
    const attrs = Object.entries(el.attributes)
      .map(([k, v]) => `${k}="${v}"`)
      .join(" ");
    console.log(`      [${i + 1}] <${el.tag} ${attrs}> "${el.text}"  → ${el.selector}`);
  });

  // ── Step 4: Azure OpenAI suggestion ─────────────────────────────────────
  section("Step 4 · Azure OpenAI identifies replacement selector");
  const aiClient = new MockAzureOpenAiClient(MOCK_SUGGESTIONS);
  const suggestion = await aiClient.suggestReplacement(
    FAILING_SELECTOR,
    domElements,
    {
      testTitle: "Healing scenario: login-btn selector drifted",
      testFile: SPEC_FILE,
      failedSelector: FAILING_SELECTOR,
      action: "click",
      pageUrl: page.url(),
      pageTitle: await page.title(),
    },
  );

  tick(`Candidate selector : ${suggestion.candidateSelector}`);
  tick(`Confidence         : ${(suggestion.confidence * 100).toFixed(0)}%`);
  info(`Reasoning          : ${suggestion.reasoning}`);
  if (suggestion.alternatives.length > 0) {
    info(`Alternatives       : ${suggestion.alternatives.join("  |  ")}`);
  }

  // ── Step 5: Approval gate ────────────────────────────────────────────────
  section("Step 5 · Approval gate");
  const THRESHOLD = 0.85;
  if (suggestion.confidence >= THRESHOLD) {
    tick(
      `Auto-approved  (confidence ${suggestion.confidence} ≥ threshold ${THRESHOLD})`,
    );
  } else {
    cross(
      `Pending manual approval  (confidence ${suggestion.confidence} < threshold ${THRESHOLD})`,
    );
    info("Edit healing/healing-proposals.json and set status to \"approved\"");
    await browser.close();
    return;
  }

  // Persist to store
  const store = new FileHealingStore();
  const proposal = store.propose(
    {
      testTitle: "Healing scenario: login-btn selector drifted",
      testFile: SPEC_FILE,
      failedSelector: FAILING_SELECTOR,
      action: "click",
      pageUrl: page.url(),
      pageTitle: await page.title(),
    },
    suggestion,
  );
  store.approve(proposal.proposalId, "auto-confidence");
  info(`Proposal ID : ${proposal.proposalId}`);
  info(`Stored in   : healing/healing-proposals.json`);

  // ── Step 6: Retry with healed selector on live page ──────────────────────
  section("Step 6 · Retry on live page with healed selector");
  info(
    `Replacing  ${FAILING_SELECTOR}  →  ${suggestion.candidateSelector}`,
  );

  try {
    await page.fill('input[name="username"]', "Admin");
    await page.fill('input[name="password"]', "admin123");
    await page.locator(suggestion.candidateSelector).click({ timeout: 8000 });
    await page.waitForURL(/dashboard/i, { timeout: 10000 });

    tick(`Login succeeded with healed selector!`);
    tick(`Redirected to: ${page.url()}`);

    const screenshotPath = path.join("screenshots", "healing-demo-step6-healed.png");
    await page.screenshot({ path: screenshotPath, fullPage: false });
    info(`Screenshot saved → ${screenshotPath}`);
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : "Unknown";
    cross(`Retry failed — ${message}`);
  }

  await context.close();
  await browser.close();

  // ── Step 7: Patch spec file ──────────────────────────────────────────────
  section("Step 7 · SpecPatcher rewrites login-healing-demo.spec.ts");
  const patcher = new SpecPatcher();
  const patchCount = patcher.patch(SPEC_FILE, store.list());

  if (patchCount > 0) {
    tick(`${patchCount} selector(s) patched in ${path.relative(process.cwd(), SPEC_FILE)}`);
    info(`Before : ${FAILING_SELECTOR}`);
    info(`After  : ${suggestion.candidateSelector}`);
  } else {
    info("No patches applied (selector already up to date)");
  }

  // ── Step 8: Re-run patched spec ──────────────────────────────────────────
  section("Step 8 · Re-run patched spec via Playwright CLI");
  const runner = new PlaywrightCliRunner();
  const runResult = await runner.run(SPEC_FILE);

  if (runResult.failed === 0) {
    tick(`Re-run PASSED — ${runResult.passed} test(s) green`);
  } else {
    cross(`Re-run FAILED — ${runResult.failed} test(s) still failing`);
  }

  for (const t of runResult.testResults) {
    const icon = t.status === "passed" ? "✅" : "❌";
    console.log(`      ${icon}  ${t.title}  (${t.durationMs}ms)`);
  }

  // ── Final summary ─────────────────────────────────────────────────────────
  section("Summary");
  info(`Original selector  : ${FAILING_SELECTOR}`);
  info(`Healed selector    : ${suggestion.candidateSelector}`);
  info(`AI confidence      : ${(suggestion.confidence * 100).toFixed(0)}%`);
  info(`Proposal ID        : ${proposal.proposalId}`);
  info(`Spec patched       : ${patchCount > 0 ? "yes" : "no"}`);
  info(`Final test status  : ${runResult.failed === 0 ? "✅ PASS" : "❌ FAIL"}`);
  console.log(`\n${hr("═")}\n`);

  process.exit(runResult.failed === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error("Healing demo failed:", err);
  process.exit(1);
});
