import assert from "node:assert/strict";
import test from "node:test";

import { JiraMcpAgent, JiraStoryRepository, NormalizedJiraStory } from "./jira-mcp-agent";

const storyRepository: JiraStoryRepository = {
  getStoryByKey(issueKey: string) {
    if (issueKey !== "ECOM-LOGIN-001") {
      return undefined;
    }

    return {
      storyId: "ECOM-LOGIN-001",
      key: "ECOM-LOGIN-001",
      summary: "Customer can log in to the storefront with valid credentials",
      description: "As a returning shopper, I want to log in to the e-commerce storefront.",
      acceptanceCriteria: [
        "Given a registered customer, when valid email and password are submitted, then the customer is signed in and redirected to the account or home page.",
        "Given incorrect credentials, when the customer attempts to sign in, then a clear authentication error is displayed without exposing sensitive details.",
      ],
      comments: ["Use the story as a baseline for Playwright login coverage."],
    };
  },
  getSummary(issueKey: string) {
    return this.getStoryByKey(issueKey)?.summary;
  },
  getDescription(issueKey: string) {
    return this.getStoryByKey(issueKey)?.description;
  },
  getAcceptanceCriteria(issueKey: string) {
    return this.getStoryByKey(issueKey)?.acceptanceCriteria ?? [];
  },
  getComments(issueKey: string) {
    return this.getStoryByKey(issueKey)?.comments ?? [];
  },
};

test("normalizes Jira acceptance criteria into structured test objectives", () => {
  const loggerMessages: string[] = [];
  const logger = {
    info(message: string) {
      loggerMessages.push(`info:${message}`);
    },
    warn(message: string) {
      loggerMessages.push(`warn:${message}`);
    },
    error(message: string) {
      loggerMessages.push(`error:${message}`);
    },
  };

  const agent = new JiraMcpAgent(storyRepository, logger);
  const result: NormalizedJiraStory = agent.processStory("ECOM-LOGIN-001");

  assert.equal(result.issue.key, "ECOM-LOGIN-001");
  assert.equal(result.testObjectives.length, 2);
  assert.equal(result.testObjectives[0].category, "happy-path");
  assert.equal(result.testObjectives[1].category, "error-handling");
  assert.match(result.testObjectives[0].testIntent, /login flow succeeds/);
  assert.ok(loggerMessages.includes("info:jira.story.normalization.completed"));
});

test("throws a descriptive error when the Jira story key is missing", () => {
  const agent = new JiraMcpAgent(storyRepository);

  assert.throws(() => agent.processStory("UNKNOWN-001"), {
    name: "JiraClientError",
    message: /No Jira story found for issue key UNKNOWN-001/,
  });
});
