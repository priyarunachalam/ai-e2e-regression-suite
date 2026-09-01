import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_TRANSITIONS,
  EXAMPLE_FAILED_RESULT,
  EXAMPLE_PASSED_RESULT,
  JiraCommentPayload,
  JiraCommentResponse,
  JiraTransition,
  JiraTransitionPayload,
  JiraWriterError,
  JiraWriterService,
  MockJiraHttpClient,
  TestExecutionResult,
} from "./jira-writer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function makeService(
  client = new MockJiraHttpClient(),
  opts: { applyTransition?: boolean } = {},
) {
  return new JiraWriterService(client, silentLogger(), opts);
}

// ---------------------------------------------------------------------------
// Example payloads (printed here as documentation)
// ---------------------------------------------------------------------------

test("example payload — PASSED result shape is valid", () => {
  assert.equal(EXAMPLE_PASSED_RESULT.issueKey, "ECOM-LOGIN-001");
  assert.equal(EXAMPLE_PASSED_RESULT.status, "passed");
  assert.equal(typeof EXAMPLE_PASSED_RESULT.durationMs, "number");
  assert.ok(EXAMPLE_PASSED_RESULT.executedAt.includes("T"));
  assert.equal(EXAMPLE_PASSED_RESULT.screenshots.length, 0);
});

test("example payload — FAILED result has errorMessage and screenshot", () => {
  assert.equal(EXAMPLE_FAILED_RESULT.status, "failed");
  assert.ok(EXAMPLE_FAILED_RESULT.errorMessage?.includes("Invalid credentials"));
  assert.equal(EXAMPLE_FAILED_RESULT.screenshots.length, 1);
  assert.equal(
    EXAMPLE_FAILED_RESULT.screenshots[0].mimeType,
    "image/png",
  );
});

// ---------------------------------------------------------------------------
// write() — happy path (passed)
// ---------------------------------------------------------------------------

test("write() posts a comment and transitions to Done for a passed test", async () => {
  const client = new MockJiraHttpClient();
  const service = makeService(client);

  const result = await service.write(EXAMPLE_PASSED_RESULT);

  assert.equal(result.issueKey, "ECOM-LOGIN-001");
  assert.ok(result.commentId.length > 0);
  assert.match(result.commentUrl, /ECOM-LOGIN-001/);
  assert.equal(result.transitionApplied, "Done");

  const commentCalls = client.calls.filter((c) => c.method === "postComment");
  const transitionCalls = client.calls.filter((c) => c.method === "postTransition");

  assert.equal(commentCalls.length, 1);
  assert.equal(transitionCalls.length, 1);
  assert.equal(
    (transitionCalls[0].payload as JiraTransitionPayload).transition.id,
    "31",
  );
});

// ---------------------------------------------------------------------------
// write() — failed test
// ---------------------------------------------------------------------------

test("write() posts a comment and transitions to Failed for a failed test", async () => {
  const client = new MockJiraHttpClient();
  const service = makeService(client);

  const result = await service.write(EXAMPLE_FAILED_RESULT);

  assert.equal(result.transitionApplied, "Failed");

  const commentCalls = client.calls.filter((c) => c.method === "postComment");
  assert.equal(commentCalls.length, 1);

  const payload = commentCalls[0].payload as JiraCommentPayload;
  const docJson = JSON.stringify(payload.body);

  // Comment body must contain the error message
  assert.ok(
    docJson.includes("Invalid credentials"),
    "Comment should reference the assertion failure",
  );
  // Stack trace should appear in a code block
  assert.ok(docJson.includes("codeBlock"), "Stack trace should be in a codeBlock node");
  // Screenshot name should be listed
  assert.ok(
    docJson.includes("failure.png"),
    "Comment should reference the screenshot file",
  );
});

// ---------------------------------------------------------------------------
// write() — skipped test (no transition)
// ---------------------------------------------------------------------------

test("write() posts a comment but applies no transition for skipped tests", async () => {
  const client = new MockJiraHttpClient();
  const service = makeService(client);

  const skipped: TestExecutionResult = {
    ...EXAMPLE_PASSED_RESULT,
    status: "skipped",
    testTitle: "Skipped: session persistence",
  };

  const result = await service.write(skipped);

  assert.equal(result.transitionApplied, null);
  const transitionCalls = client.calls.filter((c) => c.method === "postTransition");
  assert.equal(transitionCalls.length, 0);
});

// ---------------------------------------------------------------------------
// buildCommentPayload() — ADF structure
// ---------------------------------------------------------------------------

test("buildCommentPayload() produces a valid ADF document with required sections", () => {
  const service = makeService();
  const payload = service.buildCommentPayload(EXAMPLE_PASSED_RESULT);

  assert.equal(payload.body.version, 1);
  assert.equal(payload.body.type, "doc");
  assert.ok(Array.isArray(payload.body.content));

  const docJson = JSON.stringify(payload.body);
  assert.ok(docJson.includes("PASSED"), "Heading must include PASSED label");
  assert.ok(docJson.includes("ECOM-LOGIN-001"), "Must reference the issue key");
  assert.ok(docJson.includes("chromium"), "Must reference the browser");
  assert.ok(docJson.includes("5.9s"), "Must format duration correctly");
  assert.ok(
    docJson.includes("PlaywrightMcpGeneratorService"),
    "Must include footer attribution",
  );
});

test("buildCommentPayload() includes error detail and code block for failures", () => {
  const service = makeService();
  const payload = service.buildCommentPayload(EXAMPLE_FAILED_RESULT);
  const docJson = JSON.stringify(payload.body);

  assert.ok(docJson.includes("Failure Detail"), "Must have a Failure Detail heading");
  assert.ok(docJson.includes("FAILED"), "Heading must include FAILED label");
  assert.ok(docJson.includes("codeBlock"), "Stack trace must use a codeBlock");
  assert.ok(docJson.includes("Screenshots"), "Must have a Screenshots section");
});

// ---------------------------------------------------------------------------
// Transition resolution — fallback preference chain
// ---------------------------------------------------------------------------

test("write() falls back to second transition preference when first is unavailable", async () => {
  // Provide transitions that do NOT include "Failed" but do include "In Testing"
  const transitions: JiraTransition[] = DEFAULT_TRANSITIONS.filter(
    (t) => t.name !== "Failed",
  );
  const client = new MockJiraHttpClient(transitions);
  const service = makeService(client);

  const result = await service.write(EXAMPLE_FAILED_RESULT);

  // Should fall back to "In Testing" since "Failed" is not available
  assert.equal(result.transitionApplied, "In Testing");
});

test("write() sets transitionApplied to null when no matching transition exists", async () => {
  const client = new MockJiraHttpClient([]);  // no transitions at all
  const service = makeService(client);

  const result = await service.write(EXAMPLE_FAILED_RESULT);

  assert.equal(result.transitionApplied, null);
});

// ---------------------------------------------------------------------------
// applyTransition: false — no transition API calls
// ---------------------------------------------------------------------------

test("write() skips all transition calls when applyTransition is false", async () => {
  const client = new MockJiraHttpClient();
  const service = makeService(client, { applyTransition: false });

  const result = await service.write(EXAMPLE_PASSED_RESULT);

  assert.equal(result.transitionApplied, null);
  const transitionCalls = client.calls.filter(
    (c) => c.method === "getTransitions" || c.method === "postTransition",
  );
  assert.equal(transitionCalls.length, 0);
});

// ---------------------------------------------------------------------------
// writeBatch() — mixed results
// ---------------------------------------------------------------------------

test("writeBatch() writes all results and returns one JiraWriteResult per input", async () => {
  const client = new MockJiraHttpClient();
  const service = makeService(client);

  const results = await service.writeBatch([
    EXAMPLE_PASSED_RESULT,
    EXAMPLE_FAILED_RESULT,
  ]);

  assert.equal(results.length, 2);
  assert.equal(results[0].transitionApplied, "Done");
  assert.equal(results[1].transitionApplied, "Failed");

  const commentCalls = client.calls.filter((c) => c.method === "postComment");
  assert.equal(commentCalls.length, 2);
});

test("writeBatch() continues writing remaining results after an individual failure", async () => {
  let callCount = 0;
  const faultyClient = {
    postComment: async (): Promise<JiraCommentResponse> => {
      callCount++;
      if (callCount === 1) throw new Error("network timeout");
      return { id: "99999", self: "https://mock/99999", created: new Date().toISOString() };
    },
    postTransition: async () => undefined,
    getTransitions: async () => DEFAULT_TRANSITIONS,
  };

  const warnings: string[] = [];
  const logger = {
    ...silentLogger(),
    error(message: string) { warnings.push(message); },
  };

  const service = new JiraWriterService(faultyClient, logger);
  const results = await service.writeBatch([
    EXAMPLE_PASSED_RESULT,  // fails (first call)
    EXAMPLE_FAILED_RESULT,  // succeeds (second call)
  ]);

  assert.equal(results.length, 1, "Only the successful write should be returned");
  assert.ok(
    warnings.some((w) => w.includes("batch.item.failed")),
    "Error should be logged for the failed item",
  );
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

test("write() throws INVALID_TEST_RESULT when issueKey is empty", async () => {
  const service = makeService();
  const bad: TestExecutionResult = { ...EXAMPLE_PASSED_RESULT, issueKey: "" };

  await assert.rejects(
    () => service.write(bad),
    (err: unknown) => {
      assert.ok(err instanceof JiraWriterError);
      assert.equal(err.code, "INVALID_TEST_RESULT");
      assert.match(err.message, /issueKey/);
      return true;
    },
  );
});

test("write() throws INVALID_TEST_RESULT when testTitle is missing", async () => {
  const service = makeService();
  const bad: TestExecutionResult = { ...EXAMPLE_PASSED_RESULT, testTitle: "  " };

  await assert.rejects(
    () => service.write(bad),
    (err: unknown) => {
      assert.ok(err instanceof JiraWriterError);
      assert.equal(err.code, "INVALID_TEST_RESULT");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// HTTP error propagation
// ---------------------------------------------------------------------------

test("write() throws COMMENT_POST_FAILED when postComment rejects", async () => {
  const client = {
    postComment: async (): Promise<JiraCommentResponse> => {
      throw new Error("503 Service Unavailable");
    },
    postTransition: async () => undefined,
    getTransitions: async () => DEFAULT_TRANSITIONS,
  };

  const service = new JiraWriterService(client, silentLogger());

  await assert.rejects(
    () => service.write(EXAMPLE_PASSED_RESULT),
    (err: unknown) => {
      assert.ok(err instanceof JiraWriterError);
      assert.equal(err.code, "COMMENT_POST_FAILED");
      assert.match(err.message, /503/);
      return true;
    },
  );
});

test("write() throws TRANSITION_POST_FAILED when postTransition rejects", async () => {
  const client = {
    postComment: async (): Promise<JiraCommentResponse> => ({
      id: "1",
      self: "https://mock/1",
      created: new Date().toISOString(),
    }),
    postTransition: async (): Promise<void> => {
      throw new Error("Transition not allowed");
    },
    getTransitions: async () => DEFAULT_TRANSITIONS,
  };

  const service = new JiraWriterService(client, silentLogger());

  await assert.rejects(
    () => service.write(EXAMPLE_PASSED_RESULT),
    (err: unknown) => {
      assert.ok(err instanceof JiraWriterError);
      assert.equal(err.code, "TRANSITION_POST_FAILED");
      return true;
    },
  );
});
