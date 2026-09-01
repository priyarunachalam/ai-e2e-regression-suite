/**
 * Self-Healing Engine for Playwright
 *
 * Architecture:
 *
 *  ┌─────────────────────────────────────────────────────────────────┐
 *  │  Playwright test calls healingLocator / healingClick / healingFill
 *  └──────────────────────────────┬──────────────────────────────────┘
 *                                 │ selector not found → TimeoutError
 *                                 ▼
 *  ┌──────────────────────────────────────────────────────────────────┐
 *  │  Step 1 — DomInspector.extractInteractiveElements(page)          │
 *  │  Collects all visible interactive elements with their attributes  │
 *  └──────────────────────────────┬───────────────────────────────────┘
 *                                 │ DomElement[]
 *                                 ▼
 *  ┌──────────────────────────────────────────────────────────────────┐
 *  │  Step 2 — SelfHealingEngine.heal()                               │
 *  │  • Cache check: store.getApproved(failedSelector)                │
 *  │  • If miss → AzureOpenAiHealingClient.suggestReplacement()       │
 *  │  • HealingStore.propose(context, suggestion)                     │
 *  └──────────────────────────────┬───────────────────────────────────┘
 *                                 │ HealingProposal
 *                                 ▼
 *  ┌──────────────────────────────────────────────────────────────────┐
 *  │  Step 3 — ApprovalGate.evaluate(proposal)                        │
 *  │  • AUTO_APPROVE=true  → approve immediately                      │
 *  │  • confidence ≥ threshold → auto-approve                         │
 *  │  • Otherwise → log pending proposal, return { healed: false }    │
 *  └──────────────────────────────┬───────────────────────────────────┘
 *                                 │ approved
 *                                 ▼
 *  ┌──────────────────────────────────────────────────────────────────┐
 *  │  Step 4 — Retry original action with candidateSelector           │
 *  │  • On success → return { healed: true, retriedSuccessfully: true }│
 *  │  • On failure → return { healed: true, retriedSuccessfully: false }│
 *  └──────────────────────────────────────────────────────────────────┘
 */

import type { Page, Locator } from "@playwright/test";
import { test as base } from "@playwright/test";

import {
  AzureOpenAiConfig,
  AzureOpenAiClient,
  AzureOpenAiHealingClient,
  DomElement,
  HealingContext,
} from "./azure-openai-client";
import { FileHealingStore, HealingProposal, HealingStore } from "./healing-store";

// ---------------------------------------------------------------------------
// Healing result
// ---------------------------------------------------------------------------

export interface HealingResult {
  healed: boolean;
  originalSelector: string;
  appliedSelector: string | null;
  proposalId: string | null;
  approvalStatus: "approved" | "rejected" | "pending" | "cache-hit";
  retriedSuccessfully: boolean;
}

// ---------------------------------------------------------------------------
// Engine options
// ---------------------------------------------------------------------------

export interface SelfHealingEngineOptions {
  /**
   * Auto-approve if the Azure OpenAI confidence score meets or exceeds this
   * threshold.  Default: 0.85
   */
  autoApproveThreshold?: number;
  /**
   * Override AUTO_APPROVE env var check.  When true all suggestions are
   * approved without requiring a confidence check.
   */
  forceAutoApprove?: boolean;
  /** Retry timeout in ms for the healed action. Default: 5_000 */
  retryTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// DOM Inspector
// ---------------------------------------------------------------------------

/**
 * Extracts all visible interactive elements from the live page.
 * Runs in the browser context via `page.evaluate()`.
 */
export class DomInspector {
  async extractInteractiveElements(page: Page): Promise<DomElement[]> {
    return page.evaluate((): Array<{
      tag: string;
      text: string;
      selector: string;
      attributes: Record<string, string>;
    }> => {
      const INTERACTIVE_TAGS = [
        "a", "button", "input", "select", "textarea",
        "[role='button']", "[role='link']", "[role='checkbox']",
        "[role='textbox']", "[data-testid]", "[id]",
      ];

      const elements = document.querySelectorAll<HTMLElement>(
        INTERACTIVE_TAGS.join(","),
      );

      return Array.from(elements)
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .slice(0, 60) // cap to avoid huge prompts
        .map((el) => {
          // Build a concise selector for this element
          const attrs: Record<string, string> = {};
          for (const attr of Array.from(el.attributes)) {
            if (
              ["data-testid", "id", "name", "type", "role",
               "aria-label", "placeholder", "class", "href"].includes(attr.name)
            ) {
              attrs[attr.name] = attr.value.slice(0, 80);
            }
          }

          let selector = el.tagName.toLowerCase();
          if (attrs["data-testid"]) {
            selector = `[data-testid="${attrs["data-testid"]}"]`;
          } else if (attrs["id"]) {
            selector = `#${attrs["id"]}`;
          } else if (attrs["name"]) {
            selector = `${selector}[name="${attrs["name"]}"]`;
          } else if (attrs["aria-label"]) {
            selector = `[aria-label="${attrs["aria-label"]}"]`;
          }

          return {
            tag: el.tagName.toLowerCase(),
            text: (el.textContent ?? "").trim().slice(0, 60),
            selector,
            attributes: attrs,
          };
        });
    });
  }
}

// ---------------------------------------------------------------------------
// Approval gate
// ---------------------------------------------------------------------------

class ApprovalGate {
  private readonly threshold: number;
  private readonly forceAutoApprove: boolean;

  constructor(options: SelfHealingEngineOptions) {
    this.threshold = options.autoApproveThreshold ?? 0.85;
    this.forceAutoApprove =
      options.forceAutoApprove ??
      process.env["AUTO_APPROVE"] === "true";
  }

  evaluate(
    proposal: HealingProposal,
    store: HealingStore,
    logger: HealingLogger,
  ): "approved" | "pending" {
    const { confidence } = proposal.suggestion;

    if (this.forceAutoApprove) {
      store.approve(proposal.proposalId, "auto-env");
      logger.info("healing.approval.auto-env", {
        proposalId: proposal.proposalId,
        candidateSelector: proposal.suggestion.candidateSelector,
      });
      return "approved";
    }

    if (confidence >= this.threshold) {
      store.approve(proposal.proposalId, "auto-confidence");
      logger.info("healing.approval.auto-confidence", {
        proposalId: proposal.proposalId,
        candidateSelector: proposal.suggestion.candidateSelector,
        confidence,
        threshold: this.threshold,
      });
      return "approved";
    }

    logger.warn("healing.approval.pending", {
      proposalId: proposal.proposalId,
      candidateSelector: proposal.suggestion.candidateSelector,
      confidence,
      threshold: this.threshold,
      message: `Confidence ${confidence.toFixed(2)} is below threshold ${this.threshold}. ` +
        `Approve manually by editing healing/healing-proposals.json ` +
        `and setting status to "approved" for proposalId "${proposal.proposalId}".`,
    });
    return "pending";
  }
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface HealingLogger {
  info(event: string, context?: Record<string, unknown>): void;
  warn(event: string, context?: Record<string, unknown>): void;
  error(event: string, context?: Record<string, unknown>): void;
}

export class ConsoleHealingLogger implements HealingLogger {
  info(event: string, context: Record<string, unknown> = {}): void {
    console.log(JSON.stringify({ level: "info", event, ...context }));
  }
  warn(event: string, context: Record<string, unknown> = {}): void {
    console.warn(JSON.stringify({ level: "warn", event, ...context }));
  }
  error(event: string, context: Record<string, unknown> = {}): void {
    console.error(JSON.stringify({ level: "error", event, ...context }));
  }
}

// ---------------------------------------------------------------------------
// Core engine
// ---------------------------------------------------------------------------

export class SelfHealingEngine {
  private readonly approvalGate: ApprovalGate;
  private readonly retryTimeoutMs: number;

  constructor(
    private readonly aiClient: AzureOpenAiHealingClient,
    private readonly store: HealingStore = new FileHealingStore(),
    private readonly domInspector: DomInspector = new DomInspector(),
    private readonly logger: HealingLogger = new ConsoleHealingLogger(),
    private readonly options: SelfHealingEngineOptions = {},
  ) {
    this.approvalGate = new ApprovalGate(options);
    this.retryTimeoutMs = options.retryTimeoutMs ?? 5_000;
  }

  /**
   * Attempts to heal a failed selector interaction.
   *
   * @param page        - Live Playwright page (must still be open)
   * @param context     - Metadata about the failing test step
   * @param retryAction - Callback that takes the replacement selector and
   *                      performs the original action; returns true on success
   */
  async heal(
    page: Page,
    context: HealingContext,
    retryAction: (selector: string) => Promise<void>,
  ): Promise<HealingResult> {
    const { failedSelector } = context;

    this.logger.info("healing.started", {
      failedSelector,
      testTitle: context.testTitle,
      pageUrl: context.pageUrl,
    });

    // Step 0: Check approved cache -------------------------------------------
    const cached = this.store.getApproved(failedSelector);
    if (cached) {
      this.logger.info("healing.cache-hit", {
        proposalId: cached.proposalId,
        candidateSelector: cached.suggestion.candidateSelector,
      });
      const retried = await this.retry(
        cached.suggestion.candidateSelector,
        retryAction,
      );
      return {
        healed: true,
        originalSelector: failedSelector,
        appliedSelector: cached.suggestion.candidateSelector,
        proposalId: cached.proposalId,
        approvalStatus: "cache-hit",
        retriedSuccessfully: retried,
      };
    }

    // Step 1: Inspect DOM ------------------------------------------------------
    this.logger.info("healing.dom.inspecting", { pageUrl: context.pageUrl });
    let domElements: DomElement[];
    try {
      domElements = await this.domInspector.extractInteractiveElements(page);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      this.logger.error("healing.dom.inspect.failed", { reason: message });
      domElements = [];
    }
    this.logger.info("healing.dom.inspected", { elementCount: domElements.length });

    // Step 2: Ask Azure OpenAI -------------------------------------------------
    this.logger.info("healing.ai.requesting", { failedSelector });
    let suggestion;
    try {
      suggestion = await this.aiClient.suggestReplacement(
        failedSelector,
        domElements,
        context,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      this.logger.error("healing.ai.failed", { failedSelector, reason: message });
      return {
        healed: false,
        originalSelector: failedSelector,
        appliedSelector: null,
        proposalId: null,
        approvalStatus: "rejected",
        retriedSuccessfully: false,
      };
    }

    this.logger.info("healing.ai.suggestion.received", {
      failedSelector,
      candidateSelector: suggestion.candidateSelector,
      confidence: suggestion.confidence,
      reasoning: suggestion.reasoning,
      alternatives: suggestion.alternatives,
    });

    // Step 3: Persist proposal -------------------------------------------------
    const proposal = this.store.propose(context, suggestion);
    this.logger.info("healing.proposal.created", {
      proposalId: proposal.proposalId,
      candidateSelector: suggestion.candidateSelector,
      confidence: suggestion.confidence,
    });

    // Step 4: Approval gate ----------------------------------------------------
    const approvalStatus = this.approvalGate.evaluate(proposal, this.store, this.logger);

    if (approvalStatus === "pending") {
      return {
        healed: false,
        originalSelector: failedSelector,
        appliedSelector: null,
        proposalId: proposal.proposalId,
        approvalStatus: "pending",
        retriedSuccessfully: false,
      };
    }

    // Step 5: Retry with approved selector ------------------------------------
    this.logger.info("healing.retry.started", {
      originalSelector: failedSelector,
      appliedSelector: suggestion.candidateSelector,
    });

    const retried = await this.retry(suggestion.candidateSelector, retryAction);

    this.logger.info(
      retried ? "healing.retry.succeeded" : "healing.retry.failed",
      {
        originalSelector: failedSelector,
        appliedSelector: suggestion.candidateSelector,
      },
    );

    return {
      healed: true,
      originalSelector: failedSelector,
      appliedSelector: suggestion.candidateSelector,
      proposalId: proposal.proposalId,
      approvalStatus: "approved",
      retriedSuccessfully: retried,
    };
  }

  private async retry(
    selector: string,
    action: (selector: string) => Promise<void>,
  ): Promise<boolean> {
    try {
      await action(selector);
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Self-healing helper wrappers
// ---------------------------------------------------------------------------

/**
 * A locator wrapper that triggers self-healing when the selector times out.
 * Use instead of `page.locator()` in tests where healing is desired.
 */
export async function healingClick(
  page: Page,
  selector: string,
  context: Omit<HealingContext, "failedSelector" | "action" | "pageUrl" | "pageTitle">,
  engine: SelfHealingEngine,
  timeout = 10_000,
): Promise<HealingResult | null> {
  try {
    await page.locator(selector).click({ timeout });
    return null; // no healing needed
  } catch {
    const url = page.url();
    const title = await page.title();
    return engine.heal(
      page,
      {
        ...context,
        failedSelector: selector,
        action: "click",
        pageUrl: url,
        pageTitle: title,
        selectorType: inferSelectorType(selector),
      },
      async (candidate) => {
        await page.locator(candidate).click({ timeout });
      },
    );
  }
}

export async function healingFill(
  page: Page,
  selector: string,
  value: string,
  context: Omit<HealingContext, "failedSelector" | "action" | "pageUrl" | "pageTitle">,
  engine: SelfHealingEngine,
  timeout = 10_000,
): Promise<HealingResult | null> {
  try {
    await page.locator(selector).fill(value, { timeout });
    return null;
  } catch {
    const url = page.url();
    const title = await page.title();
    return engine.heal(
      page,
      {
        ...context,
        failedSelector: selector,
        action: "fill",
        pageUrl: url,
        pageTitle: title,
        selectorType: inferSelectorType(selector),
      },
      async (candidate) => {
        await page.locator(candidate).fill(value, { timeout });
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Playwright test fixture factory
// ---------------------------------------------------------------------------

export interface HealingFixtures {
  /** Pre-wired SelfHealingEngine available inside every test. */
  healingEngine: SelfHealingEngine;
  /**
   * Convenience wrapper: calls healingClick / healingFill with the engine
   * already bound and `testTitle` / `testFile` inferred from `testInfo`.
   */
  selfHeal: {
    click(page: Page, selector: string, timeout?: number): Promise<HealingResult | null>;
    fill(page: Page, selector: string, value: string, timeout?: number): Promise<HealingResult | null>;
  };
}

/**
 * Creates a Playwright `test` object extended with `healingEngine` and
 * `selfHeal` fixtures.
 *
 * @example
 * ```ts
 * // fixtures.ts
 * import { createHealingTest } from '../healing/self-healing-engine';
 * import { MockAzureOpenAiClient } from '../healing/azure-openai-client';
 * import { InMemoryHealingStore } from '../healing/healing-store';
 *
 * export const test = createHealingTest({
 *   aiClient: new MockAzureOpenAiClient({ ... }),
 *   store: new InMemoryHealingStore(),
 *   options: { forceAutoApprove: true },
 * });
 * ```
 */
export function createHealingTest(config: {
  aiClient: AzureOpenAiHealingClient;
  store?: HealingStore;
  domInspector?: DomInspector;
  logger?: HealingLogger;
  options?: SelfHealingEngineOptions;
}) {
  const engine = new SelfHealingEngine(
    config.aiClient,
    config.store ?? new FileHealingStore(),
    config.domInspector ?? new DomInspector(),
    config.logger ?? new ConsoleHealingLogger(),
    config.options,
  );

  return base.extend<HealingFixtures>({
    healingEngine: async ({}, use) => {
      await use(engine);
    },

    selfHeal: async ({ healingEngine }, use, testInfo) => {
      const ctx = {
        testTitle: testInfo.title,
        testFile: testInfo.file,
      };
      await use({
        click: (page, selector, timeout) =>
          healingClick(page, selector, ctx, healingEngine, timeout),
        fill: (page, selector, value, timeout) =>
          healingFill(page, selector, value, ctx, healingEngine, timeout),
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Factory convenience — builds a production engine from env vars
// ---------------------------------------------------------------------------

export function createProductionEngine(
  options: SelfHealingEngineOptions = {},
): SelfHealingEngine {
  const config: AzureOpenAiConfig = {
    endpoint: process.env["AZURE_OPENAI_ENDPOINT"] ?? "",
    apiKey: process.env["AZURE_OPENAI_API_KEY"] ?? "",
    deploymentName: process.env["AZURE_OPENAI_DEPLOYMENT"] ?? "gpt-4o",
    apiVersion: process.env["AZURE_OPENAI_API_VERSION"] ?? "2024-02-15-preview",
  };

  return new SelfHealingEngine(
    new AzureOpenAiClient(config),
    new FileHealingStore(),
    new DomInspector(),
    new ConsoleHealingLogger(),
    options,
  );
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function inferSelectorType(selector: string): HealingContext["selectorType"] {
  if (selector.includes("data-testid")) return "data-testid";
  if (selector.startsWith("#")) return "id";
  if (selector.startsWith("//") || selector.startsWith("xpath=")) return "xpath";
  if (selector.startsWith("text=")) return "text";
  if (selector.startsWith("role=")) return "role";
  if (/^\[/.test(selector) || /^[a-z]/.test(selector)) return "css";
  return "other";
}
