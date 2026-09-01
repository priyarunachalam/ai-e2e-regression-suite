import { JiraMcpLogger, ConsoleJiraMcpLogger } from "../agent/jira-mcp-agent";

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export type JiraWriterErrorCode =
  | "INVALID_TEST_RESULT"
  | "COMMENT_POST_FAILED"
  | "TRANSITION_FETCH_FAILED"
  | "TRANSITION_POST_FAILED"
  | "TRANSITION_NOT_FOUND";

export class JiraWriterError extends Error {
  readonly code: JiraWriterErrorCode;

  constructor(code: JiraWriterErrorCode, message: string) {
    super(message);
    this.name = "JiraWriterError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

export interface ScreenshotAttachment {
  /** Display name shown in the Jira comment */
  name: string;
  /** Absolute or workspace-relative file path */
  filePath: string;
  mimeType: "image/png" | "image/jpeg";
}

export interface TestExecutionResult {
  /** Jira issue key this result belongs to, e.g. "ECOM-LOGIN-001" */
  issueKey: string;
  /** Human-readable test title */
  testTitle: string;
  /** Playwright test outcome */
  status: "passed" | "failed" | "skipped";
  /** Total test duration in milliseconds */
  durationMs: number;
  /** ISO 8601 timestamp of execution start */
  executedAt: string;
  /** Error message from the test runner (failures only) */
  errorMessage?: string;
  /** Stack trace string (failures only) */
  errorStack?: string;
  /** Screenshots captured during the test run */
  screenshots: ScreenshotAttachment[];
  /** Structured objective ID from JiraMcpAgent, e.g. "ECOM-LOGIN-001-OBJ-01" */
  objectiveId?: string;
  /** Browser name, e.g. "chromium" */
  browser?: string;
  /** Playwright worker index */
  worker?: number;
}

export interface JiraWriteResult {
  issueKey: string;
  /** Jira comment ID returned by the API */
  commentId: string;
  /** Self URL of the created comment */
  commentUrl: string;
  /** Name of the transition that was applied, or null if none was needed */
  transitionApplied: string | null;
  writtenAt: string;
}

// ---------------------------------------------------------------------------
// Atlassian Document Format (ADF) — minimal subset for comment bodies
// ---------------------------------------------------------------------------

interface AdfTextMark {
  type: "strong" | "code" | "link";
  attrs?: { href?: string; title?: string };
}

interface AdfTextNode {
  type: "text";
  text: string;
  marks?: AdfTextMark[];
}

interface AdfEmojiNode {
  type: "emoji";
  attrs: { shortName: string; text: string };
}

interface AdfHardBreak {
  type: "hardBreak";
}

type AdfInlineNode = AdfTextNode | AdfEmojiNode | AdfHardBreak;

interface AdfParagraphNode {
  type: "paragraph";
  content: AdfInlineNode[];
}

interface AdfHeadingNode {
  type: "heading";
  attrs: { level: 1 | 2 | 3 | 4 };
  content: AdfTextNode[];
}

interface AdfBulletListNode {
  type: "bulletList";
  content: AdfListItemNode[];
}

interface AdfListItemNode {
  type: "listItem";
  content: [AdfParagraphNode];
}

interface AdfCodeBlockNode {
  type: "codeBlock";
  attrs: { language: string };
  content: [AdfTextNode];
}

interface AdfRuleNode {
  type: "rule";
}

type AdfBlockNode =
  | AdfHeadingNode
  | AdfParagraphNode
  | AdfBulletListNode
  | AdfCodeBlockNode
  | AdfRuleNode;

interface AdfDocument {
  version: 1;
  type: "doc";
  content: AdfBlockNode[];
}

// ---------------------------------------------------------------------------
// Jira REST API payload types
// ---------------------------------------------------------------------------

export interface JiraCommentPayload {
  body: AdfDocument;
}

export interface JiraTransitionPayload {
  transition: { id: string };
}

export interface JiraTransition {
  id: string;
  name: string;
  to: { name: string; statusCategory: { key: string } };
}

export interface JiraCommentResponse {
  id: string;
  self: string;
  created: string;
}

// ---------------------------------------------------------------------------
// Jira HTTP client interface
// ---------------------------------------------------------------------------

export interface JiraHttpClient {
  postComment(
    issueKey: string,
    payload: JiraCommentPayload,
  ): Promise<JiraCommentResponse>;

  postTransition(
    issueKey: string,
    payload: JiraTransitionPayload,
  ): Promise<void>;

  getTransitions(issueKey: string): Promise<JiraTransition[]>;
}

// ---------------------------------------------------------------------------
// Mock Jira HTTP client
// ---------------------------------------------------------------------------

export interface MockJiraCall {
  method: "postComment" | "postTransition" | "getTransitions";
  issueKey: string;
  payload?: unknown;
}

/**
 * In-memory mock that captures every outbound Jira API call.
 * Inject pre-configured transitions to test specific flow paths.
 */
export class MockJiraHttpClient implements JiraHttpClient {
  readonly calls: MockJiraCall[] = [];

  private commentCounter = 1;

  /**
   * Preset transitions returned by getTransitions().
   * Defaults to the standard workflow stubs used across example tests.
   */
  constructor(
    readonly transitions: JiraTransition[] = DEFAULT_TRANSITIONS,
    private readonly baseUrl = "https://mock.atlassian.net/rest/api/3",
  ) {}

  async postComment(
    issueKey: string,
    payload: JiraCommentPayload,
  ): Promise<JiraCommentResponse> {
    this.calls.push({ method: "postComment", issueKey, payload });
    const id = String(10000 + this.commentCounter++);
    return {
      id,
      self: `${this.baseUrl}/issue/${issueKey}/comment/${id}`,
      created: new Date().toISOString(),
    };
  }

  async postTransition(
    issueKey: string,
    payload: JiraTransitionPayload,
  ): Promise<void> {
    this.calls.push({ method: "postTransition", issueKey, payload });
  }

  async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    this.calls.push({ method: "getTransitions", issueKey });
    return this.transitions;
  }
}

// ---------------------------------------------------------------------------
// Default transition stubs (mirrors a typical Jira Software workflow)
// ---------------------------------------------------------------------------

export const DEFAULT_TRANSITIONS: JiraTransition[] = [
  {
    id: "11",
    name: "To Do",
    to: { name: "To Do", statusCategory: { key: "new" } },
  },
  {
    id: "21",
    name: "In Progress",
    to: { name: "In Progress", statusCategory: { key: "indeterminate" } },
  },
  {
    id: "31",
    name: "Done",
    to: { name: "Done", statusCategory: { key: "done" } },
  },
  {
    id: "41",
    name: "In Testing",
    to: { name: "In Testing", statusCategory: { key: "indeterminate" } },
  },
  {
    id: "51",
    name: "Failed",
    to: { name: "Failed", statusCategory: { key: "indeterminate" } },
  },
];

// Maps each test status to the ordered list of preferred transition names.
const TRANSITION_PREFERENCE: Record<TestExecutionResult["status"], string[]> = {
  passed: ["Done", "Closed", "Resolved"],
  failed: ["Failed", "In Testing", "Reopened", "In Progress"],
  skipped: [],
};

// Status badge text and emoji used in the comment heading.
const STATUS_BADGE: Record<TestExecutionResult["status"], { emoji: string; label: string }> = {
  passed: { emoji: "✅", label: "PASSED" },
  failed: { emoji: "❌", label: "FAILED" },
  skipped: { emoji: "⏭️", label: "SKIPPED" },
};

// ---------------------------------------------------------------------------
// Service options
// ---------------------------------------------------------------------------

export interface JiraWriterOptions {
  /** Whether to apply a Jira status transition based on test outcome. Default: true */
  applyTransition?: boolean;
}

// ---------------------------------------------------------------------------
// Example payloads (exported for documentation and integration testing)
// ---------------------------------------------------------------------------

export const EXAMPLE_PASSED_RESULT: TestExecutionResult = {
  issueKey: "ECOM-LOGIN-001",
  testTitle:
    "Verify the login flow succeeds for the expected customer path: valid email and password are submitted",
  status: "passed",
  durationMs: 5912,
  executedAt: "2026-09-01T09:00:00.000Z",
  screenshots: [],
  objectiveId: "ECOM-LOGIN-001-OBJ-01",
  browser: "chromium",
  worker: 0,
};

export const EXAMPLE_FAILED_RESULT: TestExecutionResult = {
  issueKey: "ECOM-LOGIN-001",
  testTitle:
    "Verify authentication failures are handled safely: incorrect credentials",
  status: "failed",
  durationMs: 3512,
  executedAt: "2026-09-01T09:00:05.000Z",
  errorMessage:
    "expect(received).toContainText(expected)\nExpected: \"Invalid credentials\"\nReceived: \"Unexpected error\"",
  errorStack:
    "Error: expect(received).toContainText(expected)\n    at Object.<anonymous> (playwright-tests/login.spec.ts:72:5)",
  screenshots: [
    {
      name: "Verify-authentication-failures-are-handled-safely-failure.png",
      filePath: "screenshots/Verify-authentication-failures-are-handled-safely-failure.png",
      mimeType: "image/png",
    },
  ],
  objectiveId: "ECOM-LOGIN-001-OBJ-03",
  browser: "chromium",
  worker: 0,
};

// ---------------------------------------------------------------------------
// Jira writer service
// ---------------------------------------------------------------------------

export class JiraWriterService {
  private readonly applyTransition: boolean;

  constructor(
    private readonly httpClient: JiraHttpClient = new MockJiraHttpClient(),
    private readonly logger: JiraMcpLogger = new ConsoleJiraMcpLogger(),
    options: JiraWriterOptions = {},
  ) {
    this.applyTransition = options.applyTransition ?? true;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Posts a comment and optionally transitions a Jira issue based on a single
   * test execution result.
   */
  async write(result: TestExecutionResult): Promise<JiraWriteResult> {
    this.validateResult(result);

    this.logger.info("jira.writer.write.started", {
      issueKey: result.issueKey,
      status: result.status,
      objectiveId: result.objectiveId,
    });

    // 1. Build and post the comment
    const commentPayload = this.buildCommentPayload(result);
    let commentResponse: JiraCommentResponse;
    try {
      commentResponse = await this.httpClient.postComment(
        result.issueKey,
        commentPayload,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      throw new JiraWriterError(
        "COMMENT_POST_FAILED",
        `Failed to post comment on ${result.issueKey}: ${message}`,
      );
    }

    this.logger.info("jira.writer.comment.posted", {
      issueKey: result.issueKey,
      commentId: commentResponse.id,
    });

    // 2. Optionally apply a status transition
    let transitionApplied: string | null = null;
    if (this.applyTransition) {
      transitionApplied = await this.applyStatusTransition(result);
    }

    const writeResult: JiraWriteResult = {
      issueKey: result.issueKey,
      commentId: commentResponse.id,
      commentUrl: commentResponse.self,
      transitionApplied,
      writtenAt: new Date().toISOString(),
    };

    this.logger.info("jira.writer.write.completed", {
      issueKey: result.issueKey,
      commentId: writeResult.commentId,
      transitionApplied,
    });

    return writeResult;
  }

  /**
   * Writes multiple test results in sequence, collecting all outcomes.
   * Failures on individual results are logged as errors but do not abort the
   * remaining writes.
   */
  async writeBatch(results: TestExecutionResult[]): Promise<JiraWriteResult[]> {
    this.logger.info("jira.writer.batch.started", { count: results.length });

    const outcomes: JiraWriteResult[] = [];

    for (const result of results) {
      try {
        const outcome = await this.write(result);
        outcomes.push(outcome);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        this.logger.error("jira.writer.batch.item.failed", {
          issueKey: result.issueKey,
          objectiveId: result.objectiveId,
          reason: message,
        });
      }
    }

    this.logger.info("jira.writer.batch.completed", {
      total: results.length,
      written: outcomes.length,
      failed: results.length - outcomes.length,
    });

    return outcomes;
  }

  // -------------------------------------------------------------------------
  // Private helpers — comment building
  // -------------------------------------------------------------------------

  buildCommentPayload(result: TestExecutionResult): JiraCommentPayload {
    const badge = STATUS_BADGE[result.status];
    const blocks: AdfBlockNode[] = [];

    // --- Heading ---
    blocks.push(heading(2, `${badge.emoji} ${badge.label}: ${result.testTitle}`));

    // --- Metadata table as bullet list ---
    const metaItems: string[] = [
      `Issue key: ${result.issueKey}`,
      `Browser: ${result.browser ?? "unknown"}`,
      `Duration: ${formatDuration(result.durationMs)}`,
      `Executed at: ${result.executedAt}`,
    ];
    if (result.objectiveId) {
      metaItems.unshift(`Objective: ${result.objectiveId}`);
    }
    if (result.worker !== undefined) {
      metaItems.push(`Worker: ${result.worker}`);
    }
    blocks.push(bulletList(metaItems));

    // --- Error detail (failures only) ---
    if (result.status === "failed" && result.errorMessage) {
      blocks.push(heading(3, "Failure Detail"));
      blocks.push(paragraph([text(result.errorMessage)]));

      if (result.errorStack) {
        blocks.push(codeBlock("text", result.errorStack));
      }
    }

    // --- Screenshots ---
    if (result.screenshots.length > 0) {
      blocks.push(rule());
      blocks.push(heading(3, "Screenshots"));
      blocks.push(
        bulletList(result.screenshots.map((s) => s.name)),
      );
      blocks.push(
        paragraph([
          text("Screenshot files are attached to the test run artefact storage at: "),
          ...result.screenshots.map((s) => [
            textWithMark(s.filePath, "code"),
            text("  "),
          ]).flat(),
        ]),
      );
    }

    // --- Footer ---
    blocks.push(rule());
    blocks.push(
      paragraph([
        text("Generated by "),
        textWithMark("PlaywrightMcpGeneratorService", "code"),
        text(" · ai-e2e-regression-suite"),
      ]),
    );

    return { body: { version: 1, type: "doc", content: blocks } };
  }

  // -------------------------------------------------------------------------
  // Private helpers — transitions
  // -------------------------------------------------------------------------

  private async applyStatusTransition(
    result: TestExecutionResult,
  ): Promise<string | null> {
    const preferredNames = TRANSITION_PREFERENCE[result.status];
    if (preferredNames.length === 0) {
      return null; // skipped — no transition needed
    }

    let available: JiraTransition[];
    try {
      available = await this.httpClient.getTransitions(result.issueKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      throw new JiraWriterError(
        "TRANSITION_FETCH_FAILED",
        `Could not fetch transitions for ${result.issueKey}: ${message}`,
      );
    }

    const chosen = this.resolveTransition(available, preferredNames);
    if (!chosen) {
      this.logger.warn("jira.writer.transition.not-found", {
        issueKey: result.issueKey,
        preferred: preferredNames,
        available: available.map((t) => t.name),
      });
      return null;
    }

    try {
      await this.httpClient.postTransition(result.issueKey, {
        transition: { id: chosen.id },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      throw new JiraWriterError(
        "TRANSITION_POST_FAILED",
        `Failed to apply transition "${chosen.name}" on ${result.issueKey}: ${message}`,
      );
    }

    this.logger.info("jira.writer.transition.applied", {
      issueKey: result.issueKey,
      transitionId: chosen.id,
      transitionName: chosen.name,
    });

    return chosen.name;
  }

  private resolveTransition(
    available: JiraTransition[],
    preferredNames: string[],
  ): JiraTransition | undefined {
    for (const name of preferredNames) {
      const match = available.find(
        (t) => t.name.toLowerCase() === name.toLowerCase(),
      );
      if (match) return match;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  private validateResult(result: TestExecutionResult): void {
    if (!result.issueKey || !result.issueKey.trim()) {
      throw new JiraWriterError("INVALID_TEST_RESULT", "issueKey is required");
    }
    if (!result.testTitle || !result.testTitle.trim()) {
      throw new JiraWriterError(
        "INVALID_TEST_RESULT",
        "testTitle is required",
      );
    }
    if (!["passed", "failed", "skipped"].includes(result.status)) {
      throw new JiraWriterError(
        "INVALID_TEST_RESULT",
        `Unknown status "${result.status as string}"`,
      );
    }
    if (!result.executedAt) {
      throw new JiraWriterError(
        "INVALID_TEST_RESULT",
        "executedAt is required",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// ADF builder utilities
// ---------------------------------------------------------------------------

function heading(level: 2 | 3, content: string): AdfHeadingNode {
  return { type: "heading", attrs: { level }, content: [text(content)] };
}

function paragraph(content: AdfInlineNode[]): AdfParagraphNode {
  return { type: "paragraph", content };
}

function bulletList(items: string[]): AdfBulletListNode {
  return {
    type: "bulletList",
    content: items.map((item) => ({
      type: "listItem" as const,
      content: [paragraph([text(item)])],
    })),
  };
}

function codeBlock(language: string, code: string): AdfCodeBlockNode {
  return {
    type: "codeBlock",
    attrs: { language },
    content: [text(code)],
  };
}

function rule(): AdfRuleNode {
  return { type: "rule" };
}

function text(value: string): AdfTextNode {
  return { type: "text", text: value };
}

function textWithMark(value: string, markType: "strong" | "code"): AdfTextNode {
  return { type: "text", text: value, marks: [{ type: markType }] };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(1);
  return `${s}s`;
}
