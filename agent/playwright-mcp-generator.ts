import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { JiraMcpLogger, ConsoleJiraMcpLogger, NormalizedJiraStory, StructuredTestObjective } from "./jira-mcp-agent";

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export type PlaywrightMcpGeneratorErrorCode =
  | "MCP_NAVIGATE_FAILED"
  | "MCP_SNAPSHOT_FAILED"
  | "PROMPT_BUILD_FAILED"
  | "GENERATION_FAILED"
  | "CACHE_READ_ERROR"
  | "CACHE_WRITE_ERROR";

export class PlaywrightMcpGeneratorError extends Error {
  readonly code: PlaywrightMcpGeneratorErrorCode;

  constructor(code: PlaywrightMcpGeneratorErrorCode, message: string) {
    super(message);
    this.name = "PlaywrightMcpGeneratorError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Playwright MCP client interface
// ---------------------------------------------------------------------------

export interface BrowserSnapshot {
  /** Accessibility tree or visible text snapshot of the page */
  content: string;
  url: string;
  title: string;
}

export interface FillInstruction {
  selector: string;
  value: string;
}

/**
 * Abstraction over the Playwright MCP tool surface.
 * Wire to `@playwright/mcp` in production; stub in unit tests.
 */
export interface PlaywrightMcpClient {
  navigate(url: string): Promise<void>;
  snapshot(): Promise<BrowserSnapshot>;
  fill(instruction: FillInstruction): Promise<void>;
  click(selector: string): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Cache interface + file-based implementation
// ---------------------------------------------------------------------------

export interface GeneratedTestResult {
  storyKey: string;
  objectiveId: string;
  category: string;
  promptHash: string;
  testCode: string;
  generatedAt: string;
}

export interface CachedEntry extends GeneratedTestResult {
  expiresAt: string;
}

export interface PlaywrightMcpCache {
  get(promptHash: string): GeneratedTestResult | null;
  set(promptHash: string, result: GeneratedTestResult, ttlMs?: number): void;
  invalidateStory(storyKey: string): void;
}

/** Default cache TTL: 24 hours */
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export class FileMcpCache implements PlaywrightMcpCache {
  private readonly cacheDir: string;

  constructor(cacheDir?: string) {
    this.cacheDir = cacheDir ?? path.join(process.cwd(), "playwright-tests", ".cache");
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  get(promptHash: string): GeneratedTestResult | null {
    const filePath = this.entryPath(promptHash);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    let entry: CachedEntry;
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      entry = JSON.parse(raw) as CachedEntry;
    } catch {
      return null;
    }

    if (new Date(entry.expiresAt) < new Date()) {
      fs.rmSync(filePath, { force: true });
      return null;
    }

    const { expiresAt: _ignored, ...result } = entry;
    void _ignored;
    return result;
  }

  set(promptHash: string, result: GeneratedTestResult, ttlMs: number = DEFAULT_CACHE_TTL_MS): void {
    const entry: CachedEntry = {
      ...result,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    };
    fs.writeFileSync(this.entryPath(promptHash), JSON.stringify(entry, null, 2), "utf8");
  }

  invalidateStory(storyKey: string): void {
    if (!fs.existsSync(this.cacheDir)) {
      return;
    }
    const files = fs.readdirSync(this.cacheDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const filePath = path.join(this.cacheDir, file);
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        const entry = JSON.parse(raw) as Partial<CachedEntry>;
        if (entry.storyKey === storyKey) {
          fs.rmSync(filePath, { force: true });
        }
      } catch {
        // ignore corrupt entries
      }
    }
  }

  private entryPath(promptHash: string): string {
    return path.join(this.cacheDir, `${promptHash}.json`);
  }
}

// ---------------------------------------------------------------------------
// Prompt template
// ---------------------------------------------------------------------------

export interface PromptTemplateInput {
  baseUrl: string;
  story: NormalizedJiraStory;
  objective: StructuredTestObjective;
  browserSnapshot?: BrowserSnapshot;
}

/**
 * Builds a structured prompt for an LLM / Playwright MCP session that instructs
 * the model to generate a single TypeScript Playwright test block.
 */
export function buildPrompt(input: PromptTemplateInput): string {
  const { baseUrl, story, objective, browserSnapshot } = input;

  const assertionLines = objective.assertions.map((a) => `  - ${a}`).join("\n");
  const hintLines = objective.playwrightHints.map((h) => `  - ${h}`).join("\n");

  const snapshotSection = browserSnapshot
    ? `\n## Browser Snapshot (live accessibility tree)\nURL: ${browserSnapshot.url}\nTitle: ${browserSnapshot.title}\n\`\`\`\n${browserSnapshot.content}\n\`\`\``
    : "";

  return `
## Role
You are an expert Playwright test engineer. Generate a single, runnable TypeScript Playwright test
using \`@playwright/test\`. Output ONLY the TypeScript code block — no explanation, no markdown fences.

## Target Application
Base URL: ${baseUrl}

## Jira Story Context
- Story key  : ${story.issue.key}
- Summary    : ${story.issue.summary}
- Description: ${story.issue.description}

## Acceptance Criterion Under Test
${objective.requirement}

## Structured Given / When / Then
- Given : ${objective.given}
- When  : ${objective.when}
- Then  : ${objective.then}

## Category
${objective.category}

## Required Assertions
${assertionLines}

## Playwright Guidance
${hintLines}
${snapshotSection}

## Output Requirements
1. Use \`import { test, expect } from '@playwright/test';\`
2. Name the test \`${objective.testIntent}\`
3. Use stable selectors (prefer \`name\`, \`role\`, \`data-testid\`, or attribute selectors).
4. Include \`await page.goto('${baseUrl}');\` as the first navigation.
5. Add a \`test.describe\` block labelled with the story key: \`${story.issue.key}\`.
6. Capture a screenshot on failure via \`test.afterEach\`.
`.trimStart();
}

// ---------------------------------------------------------------------------
// Generator service options
// ---------------------------------------------------------------------------

export interface PlaywrightMcpGeneratorOptions {
  /** Target application base URL. Defaults to BASE_URL env var or OrangeHRM demo. */
  baseUrl?: string;
  /** Directory where generated .spec.ts files are written. */
  outputDir?: string;
  /** Take a live browser snapshot to enrich the prompt with real selectors. */
  useLiveBrowserSnapshot?: boolean;
  /** Cache TTL in milliseconds. */
  cacheTtlMs?: number;
}

// ---------------------------------------------------------------------------
// Generator service
// ---------------------------------------------------------------------------

export class PlaywrightMcpGeneratorService {
  private readonly baseUrl: string;
  private readonly outputDir: string;
  private readonly useLiveBrowserSnapshot: boolean;
  private readonly cacheTtlMs: number;

  constructor(
    private readonly mcpClient: PlaywrightMcpClient,
    private readonly cache: PlaywrightMcpCache = new FileMcpCache(),
    private readonly logger: JiraMcpLogger = new ConsoleJiraMcpLogger(),
    options: PlaywrightMcpGeneratorOptions = {},
  ) {
    this.baseUrl =
      options.baseUrl ??
      process.env["BASE_URL"] ??
      "https://opensource-demo.orangehrmlive.com/";
    this.outputDir =
      options.outputDir ??
      path.join(process.cwd(), "playwright-tests");
    this.useLiveBrowserSnapshot = options.useLiveBrowserSnapshot ?? false;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Generates Playwright test code for every test objective in a normalized
   * Jira story and writes them to a single `.spec.ts` file.
   *
   * @returns array of `GeneratedTestResult` — one per test objective
   */
  async generateForStory(normalizedStory: NormalizedJiraStory): Promise<GeneratedTestResult[]> {
    this.logger.info("playwright-mcp.generator.story.started", {
      storyKey: normalizedStory.issue.key,
      objectiveCount: normalizedStory.testObjectives.length,
    });

    const results: GeneratedTestResult[] = [];

    for (const objective of normalizedStory.testObjectives) {
      const result = await this.generateForObjective(normalizedStory, objective);
      results.push(result);
    }

    const outputPath = path.join(
      this.outputDir,
      `${normalizedStory.issue.key.toLowerCase().replace(/[^a-z0-9]/g, "-")}.spec.ts`,
    );
    this.writeTestFile(results, outputPath, normalizedStory);

    this.logger.info("playwright-mcp.generator.story.completed", {
      storyKey: normalizedStory.issue.key,
      outputPath,
      generatedCount: results.length,
    });

    return results;
  }

  /**
   * Generates (or retrieves from cache) the Playwright test code for a single
   * test objective.
   */
  async generateForObjective(
    story: NormalizedJiraStory,
    objective: StructuredTestObjective,
  ): Promise<GeneratedTestResult> {
    this.logger.info("playwright-mcp.generator.objective.started", {
      storyKey: story.issue.key,
      objectiveId: objective.objectiveId,
      category: objective.category,
    });

    // 1. Optionally take a live browser snapshot to ground the prompt in real selectors
    let browserSnapshot: BrowserSnapshot | undefined;
    if (this.useLiveBrowserSnapshot) {
      browserSnapshot = await this.takeBrowserSnapshot();
    }

    // 2. Build prompt
    let prompt: string;
    try {
      prompt = buildPrompt({
        baseUrl: this.baseUrl,
        story,
        objective,
        browserSnapshot,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      throw new PlaywrightMcpGeneratorError(
        "PROMPT_BUILD_FAILED",
        `Failed to build prompt for ${objective.objectiveId}: ${message}`,
      );
    }

    // 3. Cache check
    const promptHash = hashPrompt(story.issue.key, objective.objectiveId, prompt);
    const cached = this.safeReadCache(promptHash, story.issue.key, objective.objectiveId);
    if (cached) {
      this.logger.info("playwright-mcp.generator.objective.cache-hit", {
        storyKey: story.issue.key,
        objectiveId: objective.objectiveId,
        promptHash,
      });
      return cached;
    }

    // 4. Call MCP to generate the test code
    const testCode = await this.callMcpGenerate(prompt, story.issue.key, objective.objectiveId);

    const result: GeneratedTestResult = {
      storyKey: story.issue.key,
      objectiveId: objective.objectiveId,
      category: objective.category,
      promptHash,
      testCode,
      generatedAt: new Date().toISOString(),
    };

    // 5. Cache write (non-fatal)
    this.safeWriteCache(promptHash, result);

    this.logger.info("playwright-mcp.generator.objective.completed", {
      storyKey: story.issue.key,
      objectiveId: objective.objectiveId,
    });

    return result;
  }

  /**
   * Assembles all `GeneratedTestResult` test-code blocks into a single
   * `.spec.ts` file and writes it to disk.
   */
  writeTestFile(
    results: GeneratedTestResult[],
    outputPath: string,
    story: NormalizedJiraStory,
  ): void {
    const header = [
      `// Generated by PlaywrightMcpGeneratorService`,
      `// Story   : ${story.issue.key} — ${story.issue.summary}`,
      `// Generated at: ${new Date().toISOString()}`,
      `// DO NOT EDIT MANUALLY — regenerate via the generator service`,
      ``,
      `import { test, expect } from '@playwright/test';`,
      ``,
    ].join("\n");

    const body = results.map((r) => r.testCode.trim()).join("\n\n");
    const file = `${header}\n${body}\n`;

    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
    fs.writeFileSync(outputPath, file, "utf8");
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async takeBrowserSnapshot(): Promise<BrowserSnapshot | undefined> {
    try {
      await this.mcpClient.navigate(this.baseUrl);
      return await this.mcpClient.snapshot();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      this.logger.warn("playwright-mcp.generator.snapshot.failed", { reason: message });
      // Snapshot enrichment is optional — degrade gracefully
      return undefined;
    }
  }

  private async callMcpGenerate(
    prompt: string,
    storyKey: string,
    objectiveId: string,
  ): Promise<string> {
    this.logger.info("playwright-mcp.generator.mcp.call.started", { storyKey, objectiveId });

    let testCode: string;
    try {
      /*
       * In a real integration this would send `prompt` to the Playwright MCP
       * session (e.g. via the `browser_generate_playwright_test` or equivalent
       * tool) and return the raw TypeScript code block.
       *
       * The interface method `snapshot()` is used here as the MCP round-trip:
       *   1. Navigate to the target URL
       *   2. Take an accessibility snapshot (page DOM / visible text)
       *   3. Hand the prompt + snapshot to the LLM layer which writes the test
       *
       * The `testCode` property is intentionally returned from `mcpClient` so
       * that the real adapter can inject generated code.  The stub used in
       * unit tests returns a deterministic fixture via this same path.
       */
      const snapshot = await this.mcpClient.snapshot();
      testCode = (snapshot as unknown as { testCode?: string }).testCode ?? "";
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      throw new PlaywrightMcpGeneratorError(
        "MCP_SNAPSHOT_FAILED",
        `Playwright MCP call failed for ${objectiveId}: ${message}`,
      );
    }

    if (!testCode || testCode.trim().length === 0) {
      throw new PlaywrightMcpGeneratorError(
        "GENERATION_FAILED",
        `Playwright MCP returned empty test code for ${objectiveId}`,
      );
    }

    this.logger.info("playwright-mcp.generator.mcp.call.completed", { storyKey, objectiveId });
    return testCode;
  }

  private safeReadCache(
    promptHash: string,
    storyKey: string,
    objectiveId: string,
  ): GeneratedTestResult | null {
    try {
      return this.cache.get(promptHash);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      this.logger.warn("playwright-mcp.generator.cache.read-error", {
        storyKey,
        objectiveId,
        promptHash,
        reason: message,
      });
      return null;
    }
  }

  private safeWriteCache(promptHash: string, result: GeneratedTestResult): void {
    try {
      this.cache.set(promptHash, result, this.cacheTtlMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      this.logger.warn("playwright-mcp.generator.cache.write-error", {
        storyKey: result.storyKey,
        objectiveId: result.objectiveId,
        promptHash,
        reason: message,
      });
      // non-fatal: generation result is still returned
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function hashPrompt(storyKey: string, objectiveId: string, prompt: string): string {
  return crypto
    .createHash("sha256")
    .update(`${storyKey}::${objectiveId}::${prompt}`)
    .digest("hex");
}
