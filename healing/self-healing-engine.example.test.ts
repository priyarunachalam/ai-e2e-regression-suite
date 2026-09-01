/**
 * Unit tests for the self-healing engine.
 *
 * All tests use:
 *  - MockAzureOpenAiClient   (no real Azure OpenAI calls)
 *  - InMemoryHealingStore    (no disk I/O)
 *  - Stub Page / DomInspector (no real browser)
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DomElement,
  HealingContext,
  MockAzureOpenAiClient,
  HealingSuggestion,
} from "./azure-openai-client";
import { InMemoryHealingStore } from "./healing-store";
import {
  ConsoleHealingLogger,
  DomInspector,
  HealingLogger,
  SelfHealingEngine,
  SelfHealingEngineOptions,
} from "./self-healing-engine";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The scenario: login-btn was renamed to signin-btn */
const FAILED_SELECTOR = '[data-testid="login-btn"]';
const HEALED_SELECTOR = '[data-testid="signin-btn"]';

const DOM_ELEMENTS: DomElement[] = [
  {
    tag: "button",
    text: "Sign In",
    selector: '[data-testid="signin-btn"]',
    attributes: { "data-testid": "signin-btn", type: "submit" },
  },
  {
    tag: "input",
    text: "",
    selector: 'input[name="username"]',
    attributes: { name: "username", type: "text", placeholder: "Username" },
  },
  {
    tag: "input",
    text: "",
    selector: 'input[name="password"]',
    attributes: { name: "password", type: "password", placeholder: "Password" },
  },
];

const BASE_CONTEXT: HealingContext = {
  testTitle: "Verify login flow succeeds with valid credentials",
  testFile: "playwright-tests/login.spec.ts",
  failedSelector: FAILED_SELECTOR,
  selectorType: "data-testid",
  action: "click",
  pageUrl: "https://opensource-demo.orangehrmlive.com/web/index.php/auth/login",
  pageTitle: "OrangeHRM",
};

/** AI suggestion map: login-btn → signin-btn with high confidence */
const MOCK_SUGGESTIONS: Record<string, HealingSuggestion> = {
  [FAILED_SELECTOR]: {
    candidateSelector: HEALED_SELECTOR,
    confidence: 0.94,
    reasoning:
      'The element with data-testid="login-btn" is no longer present. ' +
      'A button with data-testid="signin-btn" and text "Sign In" is visible and ' +
      "is the most likely replacement.",
    alternatives: ['button[type="submit"]', '[aria-label="Sign In"]'],
  },
};

function silentLogger(): HealingLogger {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

function makeEngine(
  suggestions = MOCK_SUGGESTIONS,
  options: SelfHealingEngineOptions = { forceAutoApprove: true },
) {
  const stubDomInspector = new DomInspector();
  // Override extractInteractiveElements so no real page is needed
  stubDomInspector.extractInteractiveElements = async () => DOM_ELEMENTS;

  return {
    engine: new SelfHealingEngine(
      new MockAzureOpenAiClient(suggestions),
      new InMemoryHealingStore(),
      stubDomInspector,
      silentLogger(),
      options,
    ),
    store: new InMemoryHealingStore(),
  };
}

/** Minimal Page stub — records which selector was used in the retry */
function makePageStub(existingSelector = HEALED_SELECTOR) {
  const clickedSelectors: string[] = [];
  const page = {
    url: () => BASE_CONTEXT.pageUrl,
    title: async () => BASE_CONTEXT.pageTitle,
    locator: (selector: string) => ({
      click: async ({ timeout: _t }: { timeout?: number } = {}) => {
        clickedSelectors.push(selector);
        if (selector !== existingSelector) {
          throw new Error(`Element not found: ${selector}`);
        }
      },
      fill: async (_value: string, { timeout: _t }: { timeout?: number } = {}) => {
        clickedSelectors.push(selector);
        if (selector !== existingSelector) {
          throw new Error(`Element not found: ${selector}`);
        }
      },
    }),
    evaluate: async <T>(fn: () => T) => fn(),
  } as unknown as import("@playwright/test").Page;

  return { page, clickedSelectors };
}

// ---------------------------------------------------------------------------
// Step-by-step healing flow
// ---------------------------------------------------------------------------

test("heal() detects failure, inspects DOM, gets AI suggestion, auto-approves, retries", async () => {
  const aiClient = new MockAzureOpenAiClient(MOCK_SUGGESTIONS);
  const store = new InMemoryHealingStore();
  const stubInspector = new DomInspector();
  stubInspector.extractInteractiveElements = async () => DOM_ELEMENTS;

  const logs: Array<{ event: string; context?: Record<string, unknown> }> = [];
  const logger: HealingLogger = {
    info: (event, context) => logs.push({ event, context }),
    warn: (event, context) => logs.push({ event, context }),
    error: (event, context) => logs.push({ event, context }),
  };

  const engine = new SelfHealingEngine(aiClient, store, stubInspector, logger, {
    forceAutoApprove: true,
  });

  const { page } = makePageStub(HEALED_SELECTOR);

  const result = await engine.heal(page, BASE_CONTEXT, async (selector) => {
    if (selector !== HEALED_SELECTOR) throw new Error("not found");
  });

  // Step 1 — failure detected (heal was called)
  assert.ok(logs.some((l) => l.event === "healing.started"), "healing.started logged");

  // Step 2 — DOM inspected
  assert.ok(logs.some((l) => l.event === "healing.dom.inspected"), "DOM inspected");
  assert.ok(
    (logs.find((l) => l.event === "healing.dom.inspected")?.context?.elementCount as number) > 0,
    "DOM element count > 0",
  );

  // Step 3 — AI suggestion received
  assert.ok(
    logs.some((l) => l.event === "healing.ai.suggestion.received"),
    "AI suggestion logged",
  );
  const suggestionLog = logs.find((l) => l.event === "healing.ai.suggestion.received");
  assert.equal(
    suggestionLog?.context?.["candidateSelector"],
    HEALED_SELECTOR,
  );

  // Step 4 — proposal created + approved
  assert.ok(
    logs.some((l) => l.event === "healing.proposal.created"),
    "Proposal created",
  );
  assert.ok(
    logs.some((l) => l.event === "healing.approval.auto-env"),
    "Auto-approved via env",
  );

  // Step 5 — retry succeeded
  assert.ok(
    logs.some((l) => l.event === "healing.retry.succeeded"),
    "Retry succeeded",
  );

  // Final result
  assert.equal(result.healed, true);
  assert.equal(result.originalSelector, FAILED_SELECTOR);
  assert.equal(result.appliedSelector, HEALED_SELECTOR);
  assert.equal(result.approvalStatus, "approved");
  assert.equal(result.retriedSuccessfully, true);
  assert.ok(result.proposalId?.startsWith("heal-"), "proposalId has heal- prefix");
});

// ---------------------------------------------------------------------------
// Cache hit — approved selector reused without calling AI again
// ---------------------------------------------------------------------------

test("heal() returns cached approved selector without calling AI a second time", async () => {
  const aiClient = new MockAzureOpenAiClient(MOCK_SUGGESTIONS);
  const store = new InMemoryHealingStore();
  const stubInspector = new DomInspector();
  stubInspector.extractInteractiveElements = async () => DOM_ELEMENTS;

  const engine = new SelfHealingEngine(aiClient, store, stubInspector, silentLogger(), {
    forceAutoApprove: true,
  });

  const { page } = makePageStub(HEALED_SELECTOR);
  const retryAction = async (s: string) => {
    if (s !== HEALED_SELECTOR) throw new Error("not found");
  };

  // First call — triggers AI
  await engine.heal(page, BASE_CONTEXT, retryAction);
  const firstCallCount = aiClient.calls.length;

  // Second call — should use cache
  const cached = await engine.heal(page, BASE_CONTEXT, retryAction);

  assert.equal(aiClient.calls.length, firstCallCount, "AI not called again on second heal");
  assert.equal(cached.approvalStatus, "cache-hit");
  assert.equal(cached.retriedSuccessfully, true);
});

// ---------------------------------------------------------------------------
// Pending approval — low confidence blocks retry
// ---------------------------------------------------------------------------

test("heal() returns pending when confidence is below threshold and AUTO_APPROVE is off", async () => {
  const lowConfidenceSuggestions: Record<string, HealingSuggestion> = {
    [FAILED_SELECTOR]: {
      ...MOCK_SUGGESTIONS[FAILED_SELECTOR],
      confidence: 0.50, // below default 0.85 threshold
    },
  };

  const aiClient = new MockAzureOpenAiClient(lowConfidenceSuggestions);
  const store = new InMemoryHealingStore();
  const stubInspector = new DomInspector();
  stubInspector.extractInteractiveElements = async () => DOM_ELEMENTS;

  const engine = new SelfHealingEngine(
    aiClient,
    store,
    stubInspector,
    silentLogger(),
    { forceAutoApprove: false, autoApproveThreshold: 0.85 }, // explicit no-auto
  );

  const { page } = makePageStub(HEALED_SELECTOR);

  const result = await engine.heal(page, BASE_CONTEXT, async () => { /* never reached */ });

  assert.equal(result.healed, false);
  assert.equal(result.approvalStatus, "pending");
  assert.equal(result.retriedSuccessfully, false);
  assert.notEqual(result.proposalId, null, "Proposal should still be created");

  // Proposal status in store is pending
  const proposal = store.list().find((p) => p.proposalId === result.proposalId!);
  assert.equal(proposal?.status, "pending");
});

// ---------------------------------------------------------------------------
// Manual approval flow — pending → approve → re-heal uses cache
// ---------------------------------------------------------------------------

test("heal() succeeds after a pending proposal is manually approved", async () => {
  const lowConfidenceSuggestions: Record<string, HealingSuggestion> = {
    [FAILED_SELECTOR]: {
      ...MOCK_SUGGESTIONS[FAILED_SELECTOR],
      confidence: 0.40,
    },
  };

  const store = new InMemoryHealingStore();
  const stubInspector = new DomInspector();
  stubInspector.extractInteractiveElements = async () => DOM_ELEMENTS;
  const aiClient = new MockAzureOpenAiClient(lowConfidenceSuggestions);

  const engine = new SelfHealingEngine(
    aiClient, store, stubInspector, silentLogger(),
    { forceAutoApprove: false, autoApproveThreshold: 0.85 },
  );

  const { page } = makePageStub(HEALED_SELECTOR);
  const retryAction = async (s: string) => {
    if (s !== HEALED_SELECTOR) throw new Error("not found");
  };

  // First heal — pending
  const pending = await engine.heal(page, BASE_CONTEXT, retryAction);
  assert.equal(pending.approvalStatus, "pending");

  // Simulate manual approval
  store.approve(pending.proposalId!, "manual");

  // Second heal — cache hit now (approved)
  const healed = await engine.heal(page, BASE_CONTEXT, retryAction);
  assert.equal(healed.approvalStatus, "cache-hit");
  assert.equal(healed.retriedSuccessfully, true);
});

// ---------------------------------------------------------------------------
// AI failure — graceful degradation
// ---------------------------------------------------------------------------

test("heal() returns healed:false when Azure OpenAI call throws", async () => {
  const faultyClient = {
    suggestReplacement: async () => {
      throw new Error("HTTP 429 Too Many Requests");
    },
  };

  const store = new InMemoryHealingStore();
  const stubInspector = new DomInspector();
  stubInspector.extractInteractiveElements = async () => DOM_ELEMENTS;

  const errors: string[] = [];
  const logger: HealingLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: (event) => errors.push(event),
  };

  const engine = new SelfHealingEngine(faultyClient, store, stubInspector, logger, {
    forceAutoApprove: true,
  });

  const { page } = makePageStub(HEALED_SELECTOR);
  const result = await engine.heal(page, BASE_CONTEXT, async () => { /* not reached */ });

  assert.equal(result.healed, false);
  assert.equal(result.approvalStatus, "rejected");
  assert.ok(errors.includes("healing.ai.failed"), "AI failure logged");
  assert.equal(store.list().length, 0, "No proposal created on AI failure");
});

// ---------------------------------------------------------------------------
// Retry fails even with approved selector
// ---------------------------------------------------------------------------

test("heal() returns retriedSuccessfully:false when approved selector also fails", async () => {
  const aiClient = new MockAzureOpenAiClient(MOCK_SUGGESTIONS);
  const store = new InMemoryHealingStore();
  const stubInspector = new DomInspector();
  stubInspector.extractInteractiveElements = async () => DOM_ELEMENTS;

  const engine = new SelfHealingEngine(aiClient, store, stubInspector, silentLogger(), {
    forceAutoApprove: true,
  });

  const { page } = makePageStub(HEALED_SELECTOR);
  // retryAction always fails, even for the healed selector
  const result = await engine.heal(page, BASE_CONTEXT, async () => {
    throw new Error("still broken");
  });

  assert.equal(result.healed, true, "healed:true because approval was granted");
  assert.equal(result.retriedSuccessfully, false, "retry itself failed");
  assert.equal(result.appliedSelector, HEALED_SELECTOR);
});

// ---------------------------------------------------------------------------
// InMemoryHealingStore — isolation
// ---------------------------------------------------------------------------

test("InMemoryHealingStore.getApproved returns most recent approved entry", () => {
  const store = new InMemoryHealingStore();

  const ctx: HealingContext = { ...BASE_CONTEXT };
  const suggestion: HealingSuggestion = {
    candidateSelector: HEALED_SELECTOR,
    confidence: 0.9,
    reasoning: "test",
    alternatives: [],
  };

  const p1 = store.propose(ctx, suggestion);
  const p2 = store.propose(ctx, { ...suggestion, candidateSelector: '[data-testid="alt-btn"]' });

  store.approve(p1.proposalId, "manual");
  store.approve(p2.proposalId, "manual");

  const approved = store.getApproved(FAILED_SELECTOR);
  // Should return p2 (more recent)
  assert.equal(approved?.proposalId, p2.proposalId);
});

test("InMemoryHealingStore.reject prevents entry from being returned by getApproved", () => {
  const store = new InMemoryHealingStore();
  const proposal = store.propose(BASE_CONTEXT, MOCK_SUGGESTIONS[FAILED_SELECTOR]);
  store.reject(proposal.proposalId, "manual");

  assert.equal(store.getApproved(FAILED_SELECTOR), undefined);
});
