import { JiraClient, JiraClientError, JiraStory } from "../jira-client";

export type JiraObjectiveCategory = "happy-path" | "validation" | "error-handling" | "regression";

export interface JiraMcpLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export class ConsoleJiraMcpLogger implements JiraMcpLogger {
  info(message: string, context: Record<string, unknown> = {}): void {
    console.log(JSON.stringify({ level: "info", message, ...context }));
  }

  warn(message: string, context: Record<string, unknown> = {}): void {
    console.warn(JSON.stringify({ level: "warn", message, ...context }));
  }

  error(message: string, context: Record<string, unknown> = {}): void {
    console.error(JSON.stringify({ level: "error", message, ...context }));
  }
}

export interface ParsedAcceptanceCriterion {
  given: string;
  when: string;
  then: string;
}

export interface StructuredTestObjective {
  objectiveId: string;
  requirement: string;
  category: JiraObjectiveCategory;
  priority: "high" | "medium" | "low";
  given: string;
  when: string;
  then: string;
  testIntent: string;
  assertions: string[];
  playwrightHints: string[];
}

export interface NormalizedJiraStory {
  source: {
    system: "jira-mcp-simulation";
    normalizedAt: string;
  };
  issue: {
    storyId: string;
    key: string;
    summary: string;
    description: string;
    comments: string[];
  };
  acceptanceCriteria: string[];
  testObjectives: StructuredTestObjective[];
}

export interface JiraStoryRepository {
  getStoryByKey(issueKey: string): JiraStory | undefined;
  getSummary(issueKey: string): string | undefined;
  getDescription(issueKey: string): string | undefined;
  getAcceptanceCriteria(issueKey: string): string[];
  getComments(issueKey: string): string[];
}

export class JiraMcpAgent {
  constructor(
    private readonly repository: JiraStoryRepository = new JiraClient(),
    private readonly logger: JiraMcpLogger = new ConsoleJiraMcpLogger(),
  ) {}

  processStory(issueKey: string): NormalizedJiraStory {
    this.logger.info("jira.story.lookup.started", { issueKey });

    const story = this.repository.getStoryByKey(issueKey);

    if (!story) {
      this.logger.error("jira.story.lookup.failed", { issueKey, reason: "Story not found" });
      throw new JiraClientError("STORY_NOT_FOUND", `No Jira story found for issue key ${issueKey}`);
    }

    const acceptanceCriteria = this.repository.getAcceptanceCriteria(issueKey);
    const comments = this.repository.getComments(issueKey);
    const summary = this.repository.getSummary(issueKey) ?? story.summary;
    const description = this.repository.getDescription(issueKey) ?? story.description ?? "";

    this.logger.info("jira.story.lookup.completed", {
      issueKey,
      acceptanceCriteriaCount: acceptanceCriteria.length,
      commentCount: comments.length,
    });

    if (acceptanceCriteria.length === 0) {
      this.logger.warn("jira.story.acceptance-criteria.empty", { issueKey });
    }

    const testObjectives = acceptanceCriteria.map((criterion, index) => this.normalizeAcceptanceCriterion(issueKey, criterion, index + 1));

    const normalizedStory: NormalizedJiraStory = {
      source: {
        system: "jira-mcp-simulation",
        normalizedAt: new Date().toISOString(),
      },
      issue: {
        storyId: story.storyId ?? story.key,
        key: story.key,
        summary,
        description,
        comments,
      },
      acceptanceCriteria,
      testObjectives,
    };

    this.logger.info("jira.story.normalization.completed", {
      issueKey,
      objectiveCount: normalizedStory.testObjectives.length,
    });

    return normalizedStory;
  }

  private normalizeAcceptanceCriterion(issueKey: string, criterion: string, index: number): StructuredTestObjective {
    const parsed = this.parseAcceptanceCriterion(criterion);
    const category = this.classifyAcceptanceCriterion(criterion, parsed);
    const objectiveId = `${issueKey}-OBJ-${index.toString().padStart(2, "0")}`;
    const testIntent = this.buildTestIntent(category, parsed, criterion);
    const assertions = this.buildAssertions(category, parsed, criterion);
    const playwrightHints = this.buildPlaywrightHints(category, parsed);

    const objective: StructuredTestObjective = {
      objectiveId,
      requirement: criterion,
      category,
      priority: category === "error-handling" ? "high" : "high",
      given: parsed.given,
      when: parsed.when,
      then: parsed.then,
      testIntent,
      assertions,
      playwrightHints,
    };

    this.logger.info("jira.story.acceptance-criteria.normalized", {
      issueKey,
      objectiveId,
      category,
    });

    return objective;
  }

  private parseAcceptanceCriterion(criterion: string): ParsedAcceptanceCriterion {
    const normalized = criterion.replace(/\s+/g, " ").trim();
    const gwtMatch = /given\s+(.*?),\s*when\s+(.*?),\s*then\s+(.*?)(?:\.|$)/i.exec(normalized);

    if (gwtMatch) {
      return {
        given: gwtMatch[1].trim(),
        when: gwtMatch[2].trim(),
        then: gwtMatch[3].trim(),
      };
    }

    return {
      given: "Story context is available",
      when: normalized,
      then: normalized,
    };
  }

  private classifyAcceptanceCriterion(criterion: string, parsed: ParsedAcceptanceCriterion): JiraObjectiveCategory {
    const text = `${criterion} ${parsed.given} ${parsed.when} ${parsed.then}`.toLowerCase();

    if (/(empty|required|validation)/i.test(text)) {
      return "validation";
    }

    if (/(invalid|incorrect|error|denied|unauthorized|authentication)/i.test(text)) {
      return "error-handling";
    }

    if (/(successful|valid|redirect|signed in|login)/i.test(text)) {
      return "happy-path";
    }

    return "regression";
  }

  private buildTestIntent(category: JiraObjectiveCategory, parsed: ParsedAcceptanceCriterion, requirement: string): string {
    const subject = parsed.when || requirement;

    switch (category) {
      case "happy-path":
        return `Verify the login flow succeeds for the expected customer path: ${subject}`;
      case "validation":
        return `Verify login field validation prevents invalid submission: ${subject}`;
      case "error-handling":
        return `Verify authentication failures are handled safely: ${subject}`;
      default:
        return `Verify the requirement remains stable under regression coverage: ${subject}`;
    }
  }

  private buildAssertions(category: JiraObjectiveCategory, parsed: ParsedAcceptanceCriterion, requirement: string): string[] {
    const assertions: string[] = [];

    if (parsed.then) {
      assertions.push(parsed.then);
    }

    if (category === "happy-path") {
      assertions.push("The user reaches an authenticated state or account page.");
    }

    if (category === "validation") {
      assertions.push("Inline validation prevents submission with empty or invalid input.");
    }

    if (category === "error-handling") {
      assertions.push("An authentication error is shown without exposing sensitive implementation details.");
    }

    if (assertions.length === 0) {
      assertions.push(requirement);
    }

    return assertions;
  }

  private buildPlaywrightHints(category: JiraObjectiveCategory, parsed: ParsedAcceptanceCriterion): string[] {
    const hints = ["Load the login page", "Use stable selectors", "Assert the visible end state"];

    if (category === "happy-path") {
      hints.push("Fill valid credentials", "Assert redirect or account header");
    }

    if (category === "validation") {
      hints.push("Submit empty form", "Assert required field messages");
    }

    if (category === "error-handling") {
      hints.push("Fill invalid credentials", "Assert visible auth error");
    }

    if (parsed.then) {
      hints.push(`Validate outcome: ${parsed.then}`);
    }

    return hints;
  }
}
