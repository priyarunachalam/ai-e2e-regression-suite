import fs from "fs";
import path from "path";

export interface JiraStory {
  key: string;
  summary: string;
  acceptanceCriteria: string[];
  comments: string[];
}

interface JiraStoryFile {
  issues: JiraStory[];
}

export class JiraClient {
  private readonly storyFilePath: string;

  constructor(storyFilePath?: string) {
    this.storyFilePath = storyFilePath ?? path.join(process.cwd(), "jira", "story-login.json");
  }

  readStories(): JiraStory[] {
    const raw = fs.readFileSync(this.storyFilePath, "utf8");
    const parsed = JSON.parse(raw) as JiraStoryFile;

    if (!Array.isArray(parsed.issues)) {
      return [];
    }

    return parsed.issues;
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

  getAcceptanceCriteria(issueKey: string): string[] {
    return this.getStoryByKey(issueKey)?.acceptanceCriteria ?? [];
  }

  getComments(issueKey: string): string[] {
    return this.getStoryByKey(issueKey)?.comments ?? [];
  }
}
