/**
 * Regression Orchestrator — end-to-end pipeline
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │                    SEQUENCE DIAGRAM                                     │
 * │                                                                         │
 * │  Orchestrator   JiraMcpAgent  Generator  TestRunner  HealingEngine  Jira │
 * │       │              │            │           │            │          │  │
 * │  run()│              │            │           │            │          │  │
 * │  ─────┤              │            │           │            │          │  │
 * │       │ processStory │            │           │            │          │  │
 * │       │─────────────►│            │           │            │          │  │
 * │       │◄─────────────┤            │           │            │          │  │
 * │       │  NormalizedStory          │           │            │          │  │
 * │  ─────┤              │            │           │            │          │  │
 * │       │      generateForStory()   │           │            │          │  │
 * │       │──────────────────────────►│           │            │          │  │
 * │       │◄──────────────────────────┤           │            │          │  │
 * │       │      GeneratedTestResult[]│           │            │          │  │
 * │  ─────┤              │            │           │            │          │  │
 * │       │                     run(specFile)     │            │          │  │
 * │       │────────────────────────────────────── ►│           │          │  │
 * │       │◄──────────────────────────────────────┤           │          │  │
 * │       │      PlaywrightRunResult  │           │            │          │  │
 * │  ─────┤              │            │           │            │          │  │
 * │       │ [if failures]│            │           │            │          │  │
 * │       │                                  heal(page, ctx)   │          │  │
 * │       │──────────────────────────────────────────────────►│          │  │
 * │       │◄──────────────────────────────────────────────────┤          │  │
 * │       │                                  HealingResult[]  │          │  │
 * │       │                                                               │  │
 * │       │ [if approved] patchSpec(specFile, proposals)       │          │  │
 * │       │────────────────────────────────────────────────── ──          │  │
 * │       │                     re-run(specFile)               │          │  │
 * │       │────────────────────────────────────────────────── ►│          │  │
 * │       │◄──────────────────────────────────────────────────┤          │  │
 * │       │                                                               │  │
 * │  ─────┤              │            │           │            │          │  │
 * │       │                                             writeBatch()      │  │
 * │       │──────────────────────────────────────────────────────────────►│  │
 * │       │◄──────────────────────────────────────────────────────────────┤  │
 * │       │                                             JiraWriteResult[]     │
 * │  ─────┤              │            │           │            │          │  │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { chromium } from "@playwright/test";

import { JiraClientError, JiraStory } from "../jira-client";
import {
  JiraMcpAgent,
  JiraMcpLogger,
  JiraStoryRepository,
  NormalizedJiraStory,
} from "./jira-mcp-agent";
import {
  GeneratedTestResult,
  PlaywrightMcpCache,
  PlaywrightMcpClient,
  PlaywrightMcpGeneratorService,
} from "./playwright-mcp-generator";
import {
  HealingContext,
  HealingSuggestion,
} from "../healing/azure-openai-client";
import {
  FileHealingStore,
  HealingProposal,
  HealingStore,
} from "../healing/healing-store";
import {
  HealingLogger,
  SelfHealingEngine,
  SelfHealingEngineOptions,
} from "../healing/self-healing-engine";
import {
  JiraWriterService,
  JiraHttpClient,
  MockJiraHttpClient,
  TestExecutionResult,
  JiraWriteResult,
} from "../jira/jira-writer";
import {
  BufferTransport,
  ConsoleTransport,
  LogTransport,
  OrchestratorLogger,
  OrchestratorStep,
} from "./orchestrator-logger";

// ---------------------------------------------------------------------------
// Playwright JSON reporter types (subset)
// ---------------------------------------------------------------------------

interface PwJsonResult {
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  duration: number;
  errors: Array<{ message?: string; stack?: string }>;
  attachments: Array<{ name: string; path?: string; contentType: string }>;
  workerIndex: number;
}

interface PwJsonSpec {
  title: string;
  file: string;
  ok: boolean;
  tests: Array<{
    projectName: string;
    results: PwJsonResult[];
  }>;
}

interface PwJsonSuite {
  title: string;
  file?: string;
  specs: PwJsonSpec[];
  suites?: PwJsonSuite[];
}

interface PwJsonReport {
  suites: PwJsonSuite[];
  stats: {
    duration: number;
    expected: number;
    unexpected: number;
    skipped: number;
    startTime: string;
  };
}

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export interface ParsedTestResult {
  title: string;
  specFile: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  errorMessage?: string;
  errorStack?: string;
  browser: string;
  workerIndex: number;
}

export interface PlaywrightRunResult {
  passed: number;
  failed: number;
  skipped: number;
  totalDurationMs: number;
  testResults: ParsedTestResult[];
  rawOutput: string;
}

export interface HealingRunSummary {
  triggered: boolean;
  failureCount: number;
  proposalsCreated: number;
  proposalsApproved: number;
  patchesApplied: number;
}

export interface OrchestrationResult {
  pipelineId: string;
  issueKey: string;
  storyFetched: boolean;
  testsGenerated: number;
  initialRun: PlaywrightRunResult | null;
  healing: HealingRunSummary;
  finalRun: PlaywrightRunResult | null;
  jiraUpdated: boolean;
  jiraWriteResults: JiraWriteResult[];
  overallStatus: "passed" | "failed" | "healed" | "error";
  startedAt: string;
  completedAt: string;
  totalDurationMs: number;
}

// ---------------------------------------------------------------------------
// Interfaces for injectable dependencies
// ---------------------------------------------------------------------------

export interface TestRunner {
  run(specFile: string): Promise<PlaywrightRunResult>;
}

export interface HealingBrowserSession {
  openPage(url: string): Promise<import("@playwright/test").Page>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// TestRunner — spawns Playwright CLI and parses JSON reporter output
// ---------------------------------------------------------------------------

export class PlaywrightCliRunner implements TestRunner {
  constructor(
    private readonly playwrightBin: string = path.join(
      process.cwd(),
      "node_modules",
      ".bin",
      "playwright",
    ),
  ) {}

  async run(specFile: string): Promise<PlaywrightRunResult> {
    const jsonOutputFile = path.join(
      process.cwd(),
      "playwright-tests",
      ".cache",
      `run-${Date.now()}.json`,
    );

    const dir = path.dirname(jsonOutputFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const result = spawnSync(
      this.playwrightBin,
      ["test", specFile, `--reporter=json`],
      {
        env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonOutputFile },
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    const rawOutput = (result.stdout ?? "") + (result.stderr ?? "");

    // Playwright writes JSON report to the file specified in env
    let report: PwJsonReport;
    if (fs.existsSync(jsonOutputFile)) {
      try {
        report = JSON.parse(fs.readFileSync(jsonOutputFile, "utf8")) as PwJsonReport;
        fs.rmSync(jsonOutputFile, { force: true });
      } catch {
        report = { suites: [], stats: { duration: 0, expected: 0, unexpected: 0, skipped: 0, startTime: "" } };
      }
    } else {
      // Fall back to parsing stdout directly
      try {
        const jsonMatch = /(\{[\s\S]*\})/.exec(result.stdout ?? "");
        report = jsonMatch
          ? (JSON.parse(jsonMatch[1]) as PwJsonReport)
          : { suites: [], stats: { duration: 0, expected: 0, unexpected: 0, skipped: 0, startTime: "" } };
      } catch {
        report = { suites: [], stats: { duration: 0, expected: 0, unexpected: 0, skipped: 0, startTime: "" } };
      }
    }

    const testResults = flattenSpecs(report.suites, specFile);

    return {
      passed: report.stats.expected,
      failed: report.stats.unexpected,
      skipped: report.stats.skipped,
      totalDurationMs: report.stats.duration,
      testResults,
      rawOutput,
    };
  }
}

// ---------------------------------------------------------------------------
// HealingBrowserSession — real Chromium session
// ---------------------------------------------------------------------------

export class ChromiumHealingSession implements HealingBrowserSession {
  private browser: import("@playwright/test").Browser | null = null;
  private context: import("@playwright/test").BrowserContext | null = null;

  async openPage(url: string): Promise<import("@playwright/test").Page> {
    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext();
    const page = await this.context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return page;
  }

  async close(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
  }
}

// ---------------------------------------------------------------------------
// SpecPatcher — applies approved healed selectors to .spec.ts files
// ---------------------------------------------------------------------------

export class SpecPatcher {
  /**
   * Replaces all occurrences of each approved proposal's `failedSelector`
   * with the `candidateSelector` in the given spec file.
   *
   * @returns number of patches applied
   */
  patch(specFile: string, proposals: HealingProposal[]): number {
    if (!fs.existsSync(specFile)) return 0;

    let source = fs.readFileSync(specFile, "utf8");
    let patchCount = 0;

    const approved = proposals.filter((p) => p.status === "approved");
    for (const proposal of approved) {
      const { failedSelector, candidateSelector } = {
        failedSelector: proposal.context.failedSelector,
        candidateSelector: proposal.suggestion.candidateSelector,
      };

      const escaped = escapeForRegex(failedSelector);
      const pattern = new RegExp(escaped, "g");
      const before = source;
      source = source.replace(pattern, candidateSelector);
      if (source !== before) patchCount++;
    }

    if (patchCount > 0) {
      fs.writeFileSync(specFile, source, "utf8");
    }

    return patchCount;
  }
}

// ---------------------------------------------------------------------------
// Orchestrator configuration
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
  issueKey: string;
  /** Base URL of the application under test. Defaults to BASE_URL env var. */
  baseUrl?: string;
  /** Number of times to attempt healing before giving up. Default: 1 */
  maxHealingAttempts?: number;
  /** Apply Jira issue transitions when writing results. Default: true */
  applyJiraTransitions?: boolean;
  /** Confidence threshold for auto-approving healing proposals. Default: 0.85 */
  healingConfidenceThreshold?: number;
  /** Force-approve all healing proposals regardless of confidence. Default: false */
  forceAutoApproveHealing?: boolean;
  /** Output directory for generated spec files. */
  specOutputDir?: string;
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export class RegressionOrchestrator {
  private readonly baseUrl: string;
  private readonly maxHealingAttempts: number;
  private readonly specOutputDir: string;
  private readonly healingOptions: SelfHealingEngineOptions;

  constructor(
    private readonly jiraAgent: JiraMcpAgent,
    private readonly generator: PlaywrightMcpGeneratorService,
    private readonly testRunner: TestRunner,
    private readonly healingEngine: SelfHealingEngine,
    private readonly healingBrowser: HealingBrowserSession,
    private readonly healingStore: HealingStore,
    private readonly jiraWriter: JiraWriterService,
    private readonly logger: OrchestratorLogger,
    private readonly specPatcher: SpecPatcher = new SpecPatcher(),
  ) {
    this.baseUrl =
      process.env["BASE_URL"] ??
      "https://opensource-demo.orangehrmlive.com/";
    this.maxHealingAttempts = 1;
    this.specOutputDir = path.join(process.cwd(), "playwright-tests");
    this.healingOptions = {};
  }

  // -------------------------------------------------------------------------
  // Entry point
  // -------------------------------------------------------------------------

  async run(config: OrchestratorConfig): Promise<OrchestrationResult> {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    const result: Partial<OrchestrationResult> = {
      pipelineId: this.logger.pipelineId,
      issueKey: config.issueKey,
      storyFetched: false,
      testsGenerated: 0,
      initialRun: null,
      healing: {
        triggered: false,
        failureCount: 0,
        proposalsCreated: 0,
        proposalsApproved: 0,
        patchesApplied: 0,
      },
      finalRun: null,
      jiraUpdated: false,
      jiraWriteResults: [],
      overallStatus: "error",
      startedAt,
      completedAt: startedAt,
      totalDurationMs: 0,
    };

    this.logger.info("orchestrator.run.started", { issueKey: config.issueKey });

    try {
      // ── Step 1: Read Jira story ──────────────────────────────────────────
      const normalizedStory = await this.step1_readJiraStory(config.issueKey);
      result.storyFetched = true;

      // ── Step 2: Generate Playwright tests ───────────────────────────────
      const generatedResults = await this.step2_generateTests(normalizedStory);
      result.testsGenerated = generatedResults.length;

      const specFile = path.join(
        this.specOutputDir,
        `${config.issueKey.toLowerCase().replace(/[^a-z0-9]/g, "-")}.spec.ts`,
      );

      // ── Step 3: Execute tests ────────────────────────────────────────────
      const initialRun = await this.step3_executeTests(specFile);
      result.initialRun = initialRun;

      // ── Step 4: Capture results ──────────────────────────────────────────
      const executionResults = this.step4_captureResults(
        config.issueKey,
        initialRun,
        specFile,
      );

      // ── Step 5: Self-heal if failures ────────────────────────────────────
      let finalRun = initialRun;
      const healingSummary: HealingRunSummary = {
        triggered: false,
        failureCount: initialRun.failed,
        proposalsCreated: 0,
        proposalsApproved: 0,
        patchesApplied: 0,
      };

      if (initialRun.failed > 0) {
        const healingOutcome = await this.step5_triggerHealing(
          initialRun,
          config,
        );
        healingSummary.triggered = true;
        healingSummary.proposalsCreated = healingOutcome.proposalsCreated;
        healingSummary.proposalsApproved = healingOutcome.proposalsApproved;

        if (healingOutcome.proposalsApproved > 0) {
          // ── Step 6: Patch spec + re-run ──────────────────────────────────
          const patchCount = this.specPatcher.patch(
            specFile,
            this.healingStore.list(),
          );
          healingSummary.patchesApplied = patchCount;

          const rerun = await this.step6_rerunTests(specFile);
          finalRun = rerun;

          // Update execution results with final run outcomes
          executionResults.forEach((r, i) => {
            const match = rerun.testResults[i];
            if (match) {
              r.status = match.status === "passed" ? "passed"
                : match.status === "failed" ? "failed"
                : "skipped";
            }
          });
        }
      }

      result.healing = healingSummary;
      result.finalRun = finalRun;

      // ── Step 7: Update Jira ──────────────────────────────────────────────
      const jiraResults = await this.step7_updateJira(executionResults);
      result.jiraUpdated = jiraResults.length > 0;
      result.jiraWriteResults = jiraResults;

      // Determine overall status
      if (finalRun.failed === 0) {
        result.overallStatus = healingSummary.triggered ? "healed" : "passed";
      } else {
        result.overallStatus = "failed";
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      this.logger.error("orchestrator.run.fatal", { reason: message });
      result.overallStatus = "error";
    }

    result.completedAt = new Date().toISOString();
    result.totalDurationMs = Date.now() - startMs;

    this.logger.info("orchestrator.run.completed", {
      overallStatus: result.overallStatus,
      totalDurationMs: result.totalDurationMs,
    });

    return result as OrchestrationResult;
  }

  // -------------------------------------------------------------------------
  // Step 1 — Read Jira story
  // -------------------------------------------------------------------------

  private async step1_readJiraStory(issueKey: string): Promise<NormalizedJiraStory> {
    this.logger.enterStep("jira.read");
    const story = this.jiraAgent.processStory(issueKey);
    this.logger.info("jira.read.story.fetched", {
      issueKey,
      summary: story.issue.summary,
      objectiveCount: story.testObjectives.length,
    });
    this.logger.exitStep();
    return story;
  }

  // -------------------------------------------------------------------------
  // Step 2 — Generate Playwright tests
  // -------------------------------------------------------------------------

  private async step2_generateTests(
    story: NormalizedJiraStory,
  ): Promise<GeneratedTestResult[]> {
    this.logger.enterStep("test.generate");
    const results = await this.generator.generateForStory(story);
    this.logger.info("test.generate.completed", {
      storyKey: story.issue.key,
      filesGenerated: results.length,
    });
    this.logger.exitStep();
    return results;
  }

  // -------------------------------------------------------------------------
  // Step 3 — Execute tests
  // -------------------------------------------------------------------------

  private async step3_executeTests(specFile: string): Promise<PlaywrightRunResult> {
    this.logger.enterStep("test.execute");
    this.logger.info("test.execute.runner.started", { specFile });
    const runResult = await this.testRunner.run(specFile);
    this.logger.info("test.execute.runner.finished", {
      passed: runResult.passed,
      failed: runResult.failed,
      skipped: runResult.skipped,
      durationMs: runResult.totalDurationMs,
    });
    this.logger.exitStep();
    return runResult;
  }

  // -------------------------------------------------------------------------
  // Step 4 — Capture results
  // -------------------------------------------------------------------------

  private step4_captureResults(
    issueKey: string,
    runResult: PlaywrightRunResult,
    specFile: string,
  ): TestExecutionResult[] {
    this.logger.enterStep("result.capture");

    const executedAt = new Date().toISOString();
    const results: TestExecutionResult[] = runResult.testResults.map((t) => ({
      issueKey,
      testTitle: t.title,
      status: t.status,
      durationMs: t.durationMs,
      executedAt,
      errorMessage: t.errorMessage,
      errorStack: t.errorStack,
      screenshots: t.status === "failed"
        ? [
            {
              name: `${sanitizeFileName(t.title)}-failure.png`,
              filePath: path.join(
                "screenshots",
                `${sanitizeFileName(t.title)}-failure.png`,
              ),
              mimeType: "image/png" as const,
            },
          ]
        : [],
      browser: t.browser,
      worker: t.workerIndex,
    }));

    this.logger.info("result.capture.captured", {
      total: results.length,
      passed: results.filter((r) => r.status === "passed").length,
      failed: results.filter((r) => r.status === "failed").length,
    });

    this.logger.exitStep();
    return results;
  }

  // -------------------------------------------------------------------------
  // Step 5 — Trigger self-healing
  // -------------------------------------------------------------------------

  private async step5_triggerHealing(
    runResult: PlaywrightRunResult,
    config: OrchestratorConfig,
  ): Promise<{ proposalsCreated: number; proposalsApproved: number }> {
    this.logger.enterStep("healing.trigger");

    const failures = runResult.testResults.filter((t) => t.status === "failed");
    this.logger.info("healing.trigger.failures.identified", {
      count: failures.length,
    });

    let proposalsCreated = 0;
    let proposalsApproved = 0;
    let page: import("@playwright/test").Page | null = null;

    try {
      page = await this.healingBrowser.openPage(
        config.baseUrl ?? this.baseUrl,
      );

      for (const failure of failures) {
        const failedSelectors = extractFailedSelectors(failure.errorMessage ?? "");

        for (const failedSelector of failedSelectors) {
          this.logger.info("healing.trigger.selector.healing", {
            testTitle: failure.title,
            failedSelector,
          });

          const context: HealingContext = {
            testTitle: failure.title,
            testFile: failure.specFile,
            failedSelector,
            action: "click",
            pageUrl: page.url(),
            pageTitle: await page.title(),
          };

          const healResult = await this.healingEngine.heal(
            page,
            context,
            async () => { /* dry-run: no retry action in healing phase */ },
          );

          proposalsCreated++;
          if (healResult.approvalStatus === "approved" || healResult.approvalStatus === "cache-hit") {
            proposalsApproved++;
            this.logger.info("healing.trigger.selector.healed", {
              failedSelector,
              appliedSelector: healResult.appliedSelector,
              confidence: healResult.proposalId,
            });
          } else {
            this.logger.warn("healing.trigger.selector.pending", {
              failedSelector,
              proposalId: healResult.proposalId,
            });
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      this.logger.error("healing.trigger.browser.error", { reason: message });
    } finally {
      await this.healingBrowser.close();
    }

    this.logger.info("healing.trigger.summary", { proposalsCreated, proposalsApproved });
    this.logger.exitStep();
    return { proposalsCreated, proposalsApproved };
  }

  // -------------------------------------------------------------------------
  // Step 6 — Re-run tests
  // -------------------------------------------------------------------------

  private async step6_rerunTests(specFile: string): Promise<PlaywrightRunResult> {
    this.logger.enterStep("test.rerun");
    this.logger.info("test.rerun.started", { specFile });
    const runResult = await this.testRunner.run(specFile);
    this.logger.info("test.rerun.completed", {
      passed: runResult.passed,
      failed: runResult.failed,
    });
    this.logger.exitStep();
    return runResult;
  }

  // -------------------------------------------------------------------------
  // Step 7 — Update Jira
  // -------------------------------------------------------------------------

  private async step7_updateJira(
    results: TestExecutionResult[],
  ): Promise<JiraWriteResult[]> {
    this.logger.enterStep("jira.update");
    const writeResults = await this.jiraWriter.writeBatch(results);
    this.logger.info("jira.update.completed", {
      written: writeResults.length,
      transitions: writeResults
        .map((r) => r.transitionApplied)
        .filter(Boolean),
    });
    this.logger.exitStep();
    return writeResults;
  }
}

// ---------------------------------------------------------------------------
// Factory — wires all production dependencies
// ---------------------------------------------------------------------------

export interface ProductionOrchestratorDeps {
  storyRepository: JiraStoryRepository;
  mcpClient: PlaywrightMcpClient;
  mcpCache?: PlaywrightMcpCache;
  healingAiClient: import("../healing/azure-openai-client").AzureOpenAiHealingClient;
  jiraHttpClient?: JiraHttpClient;
  logTransports?: LogTransport[];
  config?: Partial<OrchestratorConfig>;
}

export function createProductionOrchestrator(
  deps: ProductionOrchestratorDeps,
): { orchestrator: RegressionOrchestrator; logger: OrchestratorLogger } {
  const logger = new OrchestratorLogger(
    deps.logTransports ?? [new ConsoleTransport()],
  );

  const jiraAgentLogger: JiraMcpLogger = {
    info: (msg, ctx) => logger.info(msg, ctx),
    warn: (msg, ctx) => logger.warn(msg, ctx),
    error: (msg, ctx) => logger.error(msg, ctx),
  };

  const healingLogger: HealingLogger = {
    info: (event, ctx) => logger.info(event, ctx),
    warn: (event, ctx) => logger.warn(event, ctx),
    error: (event, ctx) => logger.error(event, ctx),
  };

  const healingStore = new FileHealingStore();
  const { DomInspector, SelfHealingEngine: Engine } = require("../healing/self-healing-engine") as {
    DomInspector: typeof import("../healing/self-healing-engine").DomInspector;
    SelfHealingEngine: typeof import("../healing/self-healing-engine").SelfHealingEngine;
  };

  const orchestrator = new RegressionOrchestrator(
    new JiraMcpAgent(deps.storyRepository, jiraAgentLogger),
    new PlaywrightMcpGeneratorService(deps.mcpClient, deps.mcpCache, jiraAgentLogger),
    new PlaywrightCliRunner(),
    new Engine(deps.healingAiClient, healingStore, new DomInspector(), healingLogger, {
      autoApproveThreshold: 0.85,
    }),
    new ChromiumHealingSession(),
    healingStore,
    new JiraWriterService(deps.jiraHttpClient ?? new MockJiraHttpClient(), jiraAgentLogger),
    logger,
  );

  return { orchestrator, logger };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function flattenSpecs(suites: PwJsonSuite[], specFile: string): ParsedTestResult[] {
  const results: ParsedTestResult[] = [];

  function walk(suite: PwJsonSuite): void {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const lastResult = t.results[t.results.length - 1];
        if (!lastResult) continue;

        const status: ParsedTestResult["status"] =
          lastResult.status === "passed" ? "passed"
          : lastResult.status === "skipped" ? "skipped"
          : "failed";

        const firstError = lastResult.errors[0];

        results.push({
          title: spec.title,
          specFile: spec.file || specFile,
          status,
          durationMs: lastResult.duration,
          errorMessage: firstError?.message,
          errorStack: firstError?.stack,
          browser: t.projectName || "chromium",
          workerIndex: lastResult.workerIndex,
        });
      }
    }
    for (const child of suite.suites ?? []) {
      walk(child);
    }
  }

  for (const suite of suites) {
    walk(suite);
  }

  return results;
}

function extractFailedSelectors(errorMessage: string): string[] {
  const pattern =
    /waiting for locator\(['"`](.*?)['"`]\)|element not found.*?['"`](.*?)['"`]/gi;
  const selectors = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(errorMessage)) !== null) {
    const selector = (match[1] ?? match[2] ?? "").trim();
    if (selector) selectors.add(selector);
  }

  return [...selectors];
}

function sanitizeFileName(title: string): string {
  return title.replace(/[^a-zA-Z0-9-_ ]/g, "").replace(/\s+/g, "-").slice(0, 80);
}

function escapeForRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
