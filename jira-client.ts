import fs from "fs";
import path from "path";

export class JiraClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "JiraClientError";
    this.code = code;
  }
}

export interface JiraStoryTestScenario {
  name: string;
  given: string;
  when: string;
  then: string;
  playwrightFocus?: string[];
}

export interface JiraStory {
  storyId?: string;
  key: string;
  summary: string;
  description?: string;
  acceptanceCriteria: string[];
  comments: string[];
  testScenarios?: JiraStoryTestScenario[];
}

interface JiraStoryFile {
  issues: Array<Record<string, unknown>>;
}

export class JiraClient {
  private readonly storyFilePath: string;

  constructor(storyFilePath?: string) {
    this.storyFilePath = storyFilePath ?? path.join(process.cwd(), "jira", "story-login.json");
  }

  readStories(): JiraStory[] {
    if (!fs.existsSync(this.storyFilePath)) {
      throw new JiraClientError("STORY_FILE_NOT_FOUND", `Jira story file not found at ${this.storyFilePath}`);
    }

    let parsed: JiraStoryFile;

    try {
      const raw = fs.readFileSync(this.storyFilePath, "utf8");
      parsed = JSON.parse(raw) as JiraStoryFile;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown JSON parsing error";
      throw new JiraClientError("STORY_FILE_INVALID", `Unable to read Jira story file: ${message}`);
    }

    if (!Array.isArray(parsed.issues)) {
      throw new JiraClientError("STORY_FILE_INVALID", "Jira story file must contain an issues array");
    }

    return parsed.issues.flatMap((issue) => {
      const key = typeof issue.key === "string" ? issue.key : typeof issue.storyId === "string" ? issue.storyId : "";
      const summary = typeof issue.summary === "string" ? issue.summary : "";

      if (!key || !summary) {
        return [];
      }

      return [
        {
          storyId: typeof issue.storyId === "string" ? issue.storyId : key,
          key,
          summary,
          description: typeof issue.description === "string" ? issue.description : undefined,
          acceptanceCriteria: this.asStringArray(issue.acceptanceCriteria),
          comments: this.asStringArray(issue.comments),
          testScenarios: this.asTestScenarios(issue.testScenarios),
        },
      ];
    });
  }

  getStoryByKey(issueKey: string): JiraStory | undefined {
    return this.readStories().find((story) => story.key === issueKey);
  }

  getIssueKey(issueKey: string): string | undefined {
    return this.getStoryByKey(issueKey)?.key;
  }

  getSummary(issueKey: string): string | undefined {
    return this.getStoryByKey(issueKey)?.summary;
  }

  getDescription(issueKey: string): string | undefined {
    return this.getStoryByKey(issueKey)?.description;
  }

  getAcceptanceCriteria(issueKey: string): string[] {
    return this.getStoryByKey(issueKey)?.acceptanceCriteria ?? [];
  }

  getComments(issueKey: string): string[] {
    return this.getStoryByKey(issueKey)?.comments ?? [];
  }

  getTestScenarios(issueKey: string): JiraStoryTestScenario[] {
    return this.getStoryByKey(issueKey)?.testScenarios ?? [];
  }

  private asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  }

  private asTestScenarios(value: unknown): JiraStoryTestScenario[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.flatMap((scenario) => {
      if (typeof scenario !== "object" || scenario === null) {
        return [];
      }

      const record = scenario as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name.trim() : "";
      const given = typeof record.given === "string" ? record.given.trim() : "";
      const when = typeof record.when === "string" ? record.when.trim() : "";
      const then = typeof record.then === "string" ? record.then.trim() : "";

      if (!name || !given || !when || !then) {
        return [];
      }

      const playwrightFocus = this.asStringArray(record.playwrightFocus);

      return [
        {
          name,
          given,
          when,
          then,
          playwrightFocus: playwrightFocus.length > 0 ? playwrightFocus : undefined,
        },
      ];
    });
  }
}
