import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JiraMcpAgent } from "./jira-mcp-agent";
import {
  FileMcpCache,
  GeneratedTestResult,
  PlaywrightMcpCache,
  PlaywrightMcpClient,
  PlaywrightMcpGeneratorError,
  PlaywrightMcpGeneratorService,
  buildPrompt,
} from "./playwright-mcp-generator";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const STORY_KEY = "ECOM-LOGIN-001";

const storyRepository = {
  getStoryByKey(issueKey: string) {
    if (issueKey !== STORY_KEY) return undefined;
    return {
      storyId: STORY_KEY,
      key: STORY_KEY,
      summary: "Customer can log in to the storefront with valid credentials",
      description: "As a returning shopper, I want to log in to the e-commerce storefront.",
      acceptanceCriteria: [
        "Given a registered customer, when valid email and password are submitted, then the customer is signed in and redirected to the account or home page.",
        "Given incorrect credentials, when the customer attempts to sign in, then a clear authentication error is displayed without exposing sensitive details.",
      ],
      comments: ["Use this story as the baseline for Playwright login coverage."],
    };
  },
  getSummary(key: string) { return this.getStoryByKey(key)?.summary; },
  getDescription(key: string) { return this.getStoryByKey(key)?.description; },
  getAcceptanceCriteria(key: string) { return this.getStoryByKey(key)?.acceptanceCriteria ?? []; },
  getComments(key: string) { return this.getStoryByKey(key)?.comments ?? []; },
};

function makeNormalizedStory() {
  const agent = new JiraMcpAgent(storyRepository, silentLogger());
  return agent.processStory(STORY_KEY);
}

function silentLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

/** Stub MCP client — returns deterministic `testCode` via the snapshot payload */
function makeStubMcpClient(testCode = "// generated test code"): PlaywrightMcpClient {
  return {
    navigate: async () => undefined,
    snapshot: async () => ({
      content: "stub-snapshot",
      url: "https://stub.example.com/",
      title: "Stub Page",
      testCode,
    } as unknown as Awaited<ReturnType<PlaywrightMcpClient["snapshot"]>>),
    fill: async () => undefined,
    click: async () => undefined,
    close: async () => undefined,
  };
}

/** In-memory cache stub */
function makeMemoryCache(): PlaywrightMcpCache & { store: Map<string, GeneratedTestResult> } {
  const store = new Map<string, GeneratedTestResult>();
  return {
    store,
    get(hash) { return store.get(hash) ?? null; },
    set(hash, result) { store.set(hash, result); },
    invalidateStory(storyKey) {
      for (const [k, v] of store) {
        if (v.storyKey === storyKey) store.delete(k);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// buildPrompt
// ---------------------------------------------------------------------------

test("buildPrompt includes story key, summary and acceptance criterion", () => {
  const normalizedStory = makeNormalizedStory();
  const objective = normalizedStory.testObjectives[0];

  const prompt = buildPrompt({
    baseUrl: "https://example.com/",
    story: normalizedStory,
    objective,
  });

  assert.match(prompt, /ECOM-LOGIN-001/);
  assert.match(prompt, /Customer can log in/);
  assert.match(prompt, /Given a registered customer/);
  assert.match(prompt, /test\.describe/);
});

test("buildPrompt includes browser snapshot section when provided", () => {
  const normalizedStory = makeNormalizedStory();
  const objective = normalizedStory.testObjectives[0];

  const prompt = buildPrompt({
    baseUrl: "https://example.com/",
    story: normalizedStory,
    objective,
    browserSnapshot: { content: "accessibility-tree-text", url: "https://example.com/", title: "Example" },
  });

  assert.match(prompt, /Browser Snapshot/);
  assert.match(prompt, /accessibility-tree-text/);
});

// ---------------------------------------------------------------------------
// generateForObjective — cache hit
// ---------------------------------------------------------------------------

test("generateForObjective returns cached result without calling MCP", async () => {
  const normalizedStory = makeNormalizedStory();
  const objective = normalizedStory.testObjectives[0];
  const cache = makeMemoryCache();

  let mcpCallCount = 0;
  const mcpClient: PlaywrightMcpClient = {
    ...makeStubMcpClient(),
    snapshot: async () => {
      mcpCallCount++;
      return { content: "", url: "", title: "", testCode: "// from-mcp" } as unknown as Awaited<ReturnType<PlaywrightMcpClient["snapshot"]>>;
    },
  };

  const service = new PlaywrightMcpGeneratorService(mcpClient, cache, silentLogger(), {
    baseUrl: "https://example.com/",
    outputDir: os.tmpdir(),
  });

  // First call — MCP invoked
  const first = await service.generateForObjective(normalizedStory, objective);
  assert.equal(mcpCallCount, 1);

  // Second call — should come from cache, MCP NOT invoked again
  const second = await service.generateForObjective(normalizedStory, objective);
  assert.equal(mcpCallCount, 1);
  assert.equal(second.promptHash, first.promptHash);
  assert.equal(second.testCode, first.testCode);
});

// ---------------------------------------------------------------------------
// generateForObjective — cache miss triggers MCP
// ---------------------------------------------------------------------------

test("generateForObjective calls MCP when cache is empty and stores the result", async () => {
  const normalizedStory = makeNormalizedStory();
  const objective = normalizedStory.testObjectives[1];
  const cache = makeMemoryCache();
  const service = new PlaywrightMcpGeneratorService(
    makeStubMcpClient("// fresh-test-code"),
    cache,
    silentLogger(),
    { baseUrl: "https://example.com/", outputDir: os.tmpdir() },
  );

  const result = await service.generateForObjective(normalizedStory, objective);

  assert.equal(result.storyKey, STORY_KEY);
  assert.equal(result.category, "error-handling");
  assert.match(result.testCode, /fresh-test-code/);
  assert.equal(cache.store.size, 1);
});

// ---------------------------------------------------------------------------
// generateForObjective — GENERATION_FAILED error
// ---------------------------------------------------------------------------

test("generateForObjective throws GENERATION_FAILED when MCP returns empty code", async () => {
  const normalizedStory = makeNormalizedStory();
  const objective = normalizedStory.testObjectives[0];

  const service = new PlaywrightMcpGeneratorService(
    makeStubMcpClient("   "),   // empty / whitespace only
    makeMemoryCache(),
    silentLogger(),
    { baseUrl: "https://example.com/", outputDir: os.tmpdir() },
  );

  await assert.rejects(
    () => service.generateForObjective(normalizedStory, objective),
    (err: unknown) => {
      assert.ok(err instanceof PlaywrightMcpGeneratorError);
      assert.equal(err.code, "GENERATION_FAILED");
      assert.match(err.message, /empty test code/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// generateForObjective — CACHE_WRITE_ERROR is non-fatal
// ---------------------------------------------------------------------------

test("generateForObjective logs a warning but still returns test code when cache write fails", async () => {
  const normalizedStory = makeNormalizedStory();
  const objective = normalizedStory.testObjectives[0];

  const faultyCache: PlaywrightMcpCache = {
    get: () => null,
    set: () => { throw new Error("disk full"); },
    invalidateStory: () => undefined,
  };

  const warnings: string[] = [];
  const logger = {
    ...silentLogger(),
    warn(message: string) { warnings.push(message); },
  };

  const service = new PlaywrightMcpGeneratorService(
    makeStubMcpClient("// ok-despite-cache-failure"),
    faultyCache,
    logger,
    { baseUrl: "https://example.com/", outputDir: os.tmpdir() },
  );

  const result = await service.generateForObjective(normalizedStory, objective);
  assert.match(result.testCode, /ok-despite-cache-failure/);
  assert.ok(warnings.some((w) => w.includes("cache.write-error")));
});

// ---------------------------------------------------------------------------
// FileMcpCache — TTL expiry
// ---------------------------------------------------------------------------

test("FileMcpCache.get returns null for an expired entry", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cache-test-"));
  const cache = new FileMcpCache(tmpDir);

  const result: GeneratedTestResult = {
    storyKey: STORY_KEY,
    objectiveId: "OBJ-01",
    category: "happy-path",
    promptHash: "abc123",
    testCode: "// test",
    generatedAt: new Date().toISOString(),
  };

  // Write with a 1 ms TTL so it expires immediately
  cache.set("abc123", result, 1);

  // Introduce a small delay to ensure expiry
  const start = Date.now();
  while (Date.now() - start < 5) { /* spin */ }

  assert.equal(cache.get("abc123"), null);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("FileMcpCache.invalidateStory removes only entries for the given story", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cache-test-"));
  const cache = new FileMcpCache(tmpDir);

  const makeResult = (storyKey: string, hash: string): GeneratedTestResult => ({
    storyKey,
    objectiveId: "OBJ-01",
    category: "happy-path",
    promptHash: hash,
    testCode: "// test",
    generatedAt: new Date().toISOString(),
  });

  cache.set("hash-a", makeResult(STORY_KEY, "hash-a"));
  cache.set("hash-b", makeResult("OTHER-001", "hash-b"));

  cache.invalidateStory(STORY_KEY);

  assert.equal(cache.get("hash-a"), null);
  assert.notEqual(cache.get("hash-b"), null);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
