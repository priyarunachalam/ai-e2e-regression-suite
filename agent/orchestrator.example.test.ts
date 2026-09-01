import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JiraMcpAgent } from "./jira-mcp-agent";
import {
  GeneratedTestResult,
  PlaywrightMcpCache,
  PlaywrightMcpClient,
  PlaywrightMcpGeneratorService,
} from "./playwright-mcp-generator";
import {
  BufferTransport,
  OrchestratorLogger,
} from "./orchestrator-logger";
import {
  HealingBrowserSession,
  OrchestrationResult,
  ParsedTestResult,
  PlaywrightRunResult,
  RegressionOrchestrator,
  SpecPatcher,
  TestRunner,
} from "./orchestrator";
import {
  MockAzureOpenAiClient,
  HealingSuggestion,
} from "../healing/azure-openai-client";
import { InMemoryHealingStore } from "../healing/healing-store";
import { DomInspector, SelfHealingEngine } from "../healing/self-healing-engine";
import { JiraWriterService, MockJiraHttpClient } from "../jira/jira-writer";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const ISSUE_KEY = "ECOM-LOGIN-001";
const BASE_URL = "https://opensource-demo.orangehrmlive.com/";

const storyRepository = {
  getStoryByKey(key: string) {
    if (key !== ISSUE_KEY) return undefined;
    return {
      storyId: ISSUE_KEY,
      key: ISSUE_KEY,
      summary: "Customer can log in with valid credentials",
      description: "As a shopper, I want to log in.",
      acceptanceCriteria: [
        "Given a registered customer, when valid email and password are submitted, then the customer is signed in.",
        "Given incorrect credentials, when the customer signs in, then an error is shown.",
      ],
      comments: [],
    };
  },
  getSummary: (k: string) => storyRepository.getStoryByKey(k)?.summary,
  getDescription: (k: string) => storyRepository.getStoryByKey(k)?.description,
  getAcceptanceCriteria: (k: string) =>
    storyRepository.getStoryByKey(k)?.acceptanceCriteria ?? [],
  getComments: (k: string) => storyRepository.getStoryByKey(k)?.comments ?? [],
};

function silentLogger(): OrchestratorLogger {
  return new OrchestratorLogger([], { minLevel: "error" });
}

/** Stub Playwright MCP client — returns a fixed testCode in snapshot payload */
function makeMcpClient(): PlaywrightMcpClient {
  return {
    navigate: async () => undefined,
    snapshot: async () =>
      ({
        content: "stub",
        url: BASE_URL,
        title: "OrangeHRM",
        testCode:
          "test('login succeeds', async ({ page }) => { await page.goto('/'); });",
      } as unknown as Awaited<ReturnType<PlaywrightMcpClient["snapshot"]>>),
    fill: async () => undefined,
    click: async () => undefined,
    close: async () => undefined,
  };
}

/** Stub cache — always misses */
const noopCache: PlaywrightMcpCache = {
  get: () => null,
  set: () => undefined,
  invalidateStory: () => undefined,
};

/** Builds a deterministic PlaywrightRunResult */
function makeRunResult(
  tests: Partial<ParsedTestResult>[],
): PlaywrightRunResult {
  const testResults: ParsedTestResult[] = tests.map((t) => ({
    title: t.title ?? "test",
    specFile: "playwright-tests/ecom-login-001.spec.ts",
    status: t.status ?? "passed",
    durationMs: t.durationMs ?? 1000,
    errorMessage: t.errorMessage,
    errorStack: t.errorStack,
    browser: "chromium",
    workerIndex: 0,
  }));

  return {
    passed: testResults.filter((t) => t.status === "passed").length,
    failed: testResults.filter((t) => t.status === "failed").length,
    skipped: testResults.filter((t) => t.status === "skipped").length,
    totalDurationMs: testResults.reduce((s, t) => s + t.durationMs, 0),
    testResults,
    rawOutput: "",
  };
}

/** Stub page for healing browser session */
function makeStubPage() {
  return {
    url: () => BASE_URL,
    title: async () => "OrangeHRM",
    locator: () => ({ click: async () => undefined, fill: async () => undefined }),
    evaluate: async <T>(fn: () => T) => fn(),
    goto: async () => null,
  } as unknown as import("@playwright/test").Page;
}

function makeHealingBrowser(page = makeStubPage()): HealingBrowserSession {
  return {
    openPage: async () => page,
    close: async () => undefined,
  };
}

function makeHealingEngine(
  suggestions: Record<string, HealingSuggestion> = {},
  store = new InMemoryHealingStore(),
  forceAutoApprove = true,
) {
  const stubInspector = new DomInspector();
  stubInspector.extractInteractiveElements = async () => [];

  return new SelfHealingEngine(
    new MockAzureOpenAiClient(suggestions),
    store,
    stubInspector,
    { info: () => undefined, warn: () => undefined, error: () => undefined },
    { forceAutoApprove },
  );
}

/** Factory for a fully-stubbed orchestrator */
function makeOrchestrator(options: {
  initialRun?: PlaywrightRunResult;
  rerun?: PlaywrightRunResult;
  healingSuggestions?: Record<string, HealingSuggestion>;
  store?: InMemoryHealingStore;
  transport?: BufferTransport;
}) {
  const {
    initialRun = makeRunResult([{ status: "passed" }, { status: "passed" }]),
    rerun = makeRunResult([{ status: "passed" }, { status: "passed" }]),
    healingSuggestions = {},
    store = new InMemoryHealingStore(),
    transport = new BufferTransport(),
  } = options;

  let runCount = 0;
  const testRunner: TestRunner = {
    run: async () => (runCount++ === 0 ? initialRun : rerun),
  };

  const jiraAgent = new JiraMcpAgent(storyRepository, {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  });

  const generator = new PlaywrightMcpGeneratorService(
    makeMcpClient(),
    noopCache,
    { info: () => undefined, warn: () => undefined, error: () => undefined },
    { outputDir: os.tmpdir() },
  );

  const healingEngine = makeHealingEngine(healingSuggestions, store);
  const healingBrowser = makeHealingBrowser();
  const jiraWriter = new JiraWriterService(
    new MockJiraHttpClient(),
    { info: () => undefined, warn: () => undefined, error: () => undefined },
  );

  const logger = new OrchestratorLogger([transport]);

  const orchestrator = new RegressionOrchestrator(
    jiraAgent,
    generator,
    testRunner,
    healingEngine,
    healingBrowser,
    store,
    jiraWriter,
    logger,
  );

  return { orchestrator, transport, store };
}

// ---------------------------------------------------------------------------
// Happy path — all tests pass first time
// ---------------------------------------------------------------------------

test("orchestrator: happy path — all tests pass, status is 'passed'", async () => {
  const { orchestrator } = makeOrchestrator({
    initialRun: makeRunResult([
      { status: "passed", title: "Login succeeds" },
      { status: "passed", title: "Error shown for wrong password" },
    ]),
  });

  const result = await orchestrator.run({ issueKey: ISSUE_KEY });

  assert.equal(result.issueKey, ISSUE_KEY);
  assert.equal(result.storyFetched, true);
  assert.ok(result.testsGenerated > 0);
  assert.equal(result.initialRun?.failed, 0);
  assert.equal(result.healing.triggered, false);
  assert.equal(result.finalRun?.failed, 0);
  assert.equal(result.overallStatus, "passed");
  assert.equal(result.jiraUpdated, true);
});

// ---------------------------------------------------------------------------
// Healing triggered — failures healed and re-run passes
// ---------------------------------------------------------------------------

test("orchestrator: healing triggered when tests fail, re-run passes → status 'healed'", async () => {
  const failedSelector = '[data-testid="login-btn"]';
  const healedSelector = '[data-testid="signin-btn"]';

  const initialRun = makeRunResult([
    {
      status: "failed",
      title: "Login succeeds",
      errorMessage: `locator.click: Timeout exceeded.\nwaiting for locator('${failedSelector}')`,
    },
    { status: "passed", title: "Error shown" },
  ]);

  const rerun = makeRunResult([
    { status: "passed", title: "Login succeeds" },
    { status: "passed", title: "Error shown" },
  ]);

  const { orchestrator, transport } = makeOrchestrator({
    initialRun,
    rerun,
    healingSuggestions: {
      [failedSelector]: {
        candidateSelector: healedSelector,
        confidence: 0.95,
        reasoning: "data-testid renamed from login-btn to signin-btn",
        alternatives: [],
      },
    },
  });

  const result = await orchestrator.run({ issueKey: ISSUE_KEY });

  assert.equal(result.overallStatus, "healed");
  assert.equal(result.healing.triggered, true);
  assert.ok(result.healing.proposalsCreated > 0);
  assert.ok(result.healing.proposalsApproved > 0);
  assert.equal(result.finalRun?.failed, 0);

  // Log trail must include all 7 steps
  const steps = [
    "jira.read",
    "test.generate",
    "test.execute",
    "result.capture",
    "healing.trigger",
    "test.rerun",
    "jira.update",
  ] as const;

  for (const step of steps) {
    assert.ok(
      transport.filterByStep(step).length > 0,
      `No log entries found for step "${step}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// Healing pending — low confidence, re-run still fails
// ---------------------------------------------------------------------------

test("orchestrator: healing pending (low confidence) → status remains 'failed'", async () => {
  const failedSelector = '[data-testid="login-btn"]';

  const initialRun = makeRunResult([
    {
      status: "failed",
      title: "Login succeeds",
      errorMessage: `waiting for locator('${failedSelector}')`,
    },
  ]);

  // No re-run passes because healing was only pending (confidence 0.3 < 0.85 threshold)
  const store = new InMemoryHealingStore();
  const stubInspector = new DomInspector();
  stubInspector.extractInteractiveElements = async () => [];

  const lowConfidenceEngine = new SelfHealingEngine(
    new MockAzureOpenAiClient({
      [failedSelector]: {
        candidateSelector: '[data-testid="signin-btn"]',
        confidence: 0.30,
        reasoning: "low confidence stub",
        alternatives: [],
      },
    }),
    store,
    stubInspector,
    { info: () => undefined, warn: () => undefined, error: () => undefined },
    { forceAutoApprove: false, autoApproveThreshold: 0.85 },
  );

  const transport = new BufferTransport();
  const logger = new OrchestratorLogger([transport]);

  const jiraAgent = new JiraMcpAgent(storyRepository, {
    info: () => undefined, warn: () => undefined, error: () => undefined,
  });
  const generator = new PlaywrightMcpGeneratorService(
    makeMcpClient(), noopCache,
    { info: () => undefined, warn: () => undefined, error: () => undefined },
    { outputDir: os.tmpdir() },
  );
  const jiraWriter = new JiraWriterService(
    new MockJiraHttpClient(),
    { info: () => undefined, warn: () => undefined, error: () => undefined },
  );

  const orchestrator = new RegressionOrchestrator(
    jiraAgent, generator,
    { run: async () => initialRun },
    lowConfidenceEngine, makeHealingBrowser(),
    store, jiraWriter, logger,
  );

  const result = await orchestrator.run({ issueKey: ISSUE_KEY });

  assert.equal(result.overallStatus, "failed");
  assert.equal(result.healing.triggered, true);
  assert.equal(result.healing.proposalsApproved, 0);
  // finalRun should still show failures (no re-run occurred)
  assert.equal(result.finalRun?.failed, 1);
});

// ---------------------------------------------------------------------------
// Jira write results verified
// ---------------------------------------------------------------------------

test("orchestrator: JiraWriteResult entries contain correct issueKey and status", async () => {
  const jiraClient = new MockJiraHttpClient();
  const jiraWriter = new JiraWriterService(
    jiraClient,
    { info: () => undefined, warn: () => undefined, error: () => undefined },
  );

  const transport = new BufferTransport();
  const logger = new OrchestratorLogger([transport]);
  const jiraAgent = new JiraMcpAgent(storyRepository, {
    info: () => undefined, warn: () => undefined, error: () => undefined,
  });
  const generator = new PlaywrightMcpGeneratorService(
    makeMcpClient(), noopCache,
    { info: () => undefined, warn: () => undefined, error: () => undefined },
    { outputDir: os.tmpdir() },
  );

  const store = new InMemoryHealingStore();
  const runResult = makeRunResult([
    { status: "passed", title: "Login succeeds" },
    { status: "failed",  title: "Error shown", errorMessage: "Assertion failed" },
  ]);

  const orchestrator = new RegressionOrchestrator(
    jiraAgent, generator,
    { run: async () => runResult },
    makeHealingEngine({}, store), makeHealingBrowser(),
    store, jiraWriter, logger,
  );

  const result = await orchestrator.run({ issueKey: ISSUE_KEY });

  assert.ok(result.jiraWriteResults.length > 0, "Jira writes occurred");
  for (const wr of result.jiraWriteResults) {
    assert.equal(wr.issueKey, ISSUE_KEY);
    assert.ok(wr.commentId.length > 0);
  }

  const commentCalls = jiraClient.calls.filter((c) => c.method === "postComment");
  assert.equal(commentCalls.length, 2, "One comment per test result");
});

// ---------------------------------------------------------------------------
// OrchestratorLogger — step timing
// ---------------------------------------------------------------------------

test("OrchestratorLogger: enterStep/exitStep logs started/completed with durationMs", () => {
  const buffer = new BufferTransport();
  const logger = new OrchestratorLogger([buffer]);

  logger.enterStep("jira.read");
  logger.exitStep();

  const started = buffer.filterByEvent("jira.read.started");
  const completed = buffer.filterByEvent("jira.read.completed");

  assert.equal(started.length, 1);
  assert.equal(completed.length, 1);
  assert.ok(
    typeof completed[0].durationMs === "number",
    "durationMs should be a number",
  );
  assert.ok(completed[0].durationMs! >= 0);
});

test("OrchestratorLogger: minLevel filters out debug entries", () => {
  const buffer = new BufferTransport();
  const logger = new OrchestratorLogger([buffer], { minLevel: "info" });

  logger.debug("debug.event");
  logger.info("info.event");
  logger.warn("warn.event");

  assert.equal(buffer.filterByEvent("debug.event").length, 0);
  assert.equal(buffer.filterByEvent("info.event").length, 1);
  assert.equal(buffer.filterByEvent("warn.event").length, 1);
});

test("OrchestratorLogger: pipelineId is consistent across all entries", () => {
  const buffer = new BufferTransport();
  const logger = new OrchestratorLogger([buffer], { pipelineId: "pl-test-001" });

  logger.info("event.a");
  logger.warn("event.b");

  for (const entry of buffer.entries) {
    assert.equal(entry.pipelineId, "pl-test-001");
  }
});

// ---------------------------------------------------------------------------
// SpecPatcher
// ---------------------------------------------------------------------------

test("SpecPatcher.patch replaces failed selector with approved candidate in spec file", () => {
  const fs = require("node:fs") as typeof import("fs");
  const tmpFile = path.join(os.tmpdir(), `patch-test-${Date.now()}.ts`);

  const original = `
import { test, expect } from '@playwright/test';
test('login', async ({ page }) => {
  await page.locator('[data-testid="login-btn"]').click();
  await page.fill('[data-testid="login-btn"]', 'value');
});
`.trimStart();

  fs.writeFileSync(tmpFile, original, "utf8");

  const store = new InMemoryHealingStore();
  const proposal = store.propose(
    {
      testTitle: "login",
      testFile: tmpFile,
      failedSelector: '[data-testid="login-btn"]',
      action: "click",
      pageUrl: BASE_URL,
      pageTitle: "OrangeHRM",
    },
    {
      candidateSelector: '[data-testid="signin-btn"]',
      confidence: 0.95,
      reasoning: "renamed",
      alternatives: [],
    },
  );
  store.approve(proposal.proposalId, "manual");

  const patcher = new SpecPatcher();
  const count = patcher.patch(tmpFile, store.list());

  assert.equal(count, 1);

  const patched = fs.readFileSync(tmpFile, "utf8");
  assert.ok(patched.includes('[data-testid="signin-btn"]'), "Healed selector present");
  assert.ok(!patched.includes('[data-testid="login-btn"]'), "Failed selector removed");

  fs.rmSync(tmpFile, { force: true });
});
