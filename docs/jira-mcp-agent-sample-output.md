# Jira MCP Agent Sample Output

Input story: `jira/story-login.json`

Normalized output example:

```json
{
  "source": {
    "system": "jira-mcp-simulation",
    "normalizedAt": "2026-09-01T12:00:00.000Z"
  },
  "issue": {
    "storyId": "ECOM-LOGIN-001",
    "key": "ECOM-LOGIN-001",
    "summary": "Customer can log in to the storefront with valid credentials",
    "description": "As a returning shopper, I want to log in to the e-commerce storefront so that I can access my account, saved addresses, and order history.",
    "comments": [
      "Use this story as the baseline for Playwright test generation.",
      "Prefer stable selectors such as data-testid attributes in future automation."
    ]
  },
  "acceptanceCriteria": [
    "Given a registered customer, when valid email and password are submitted, then the customer is signed in and redirected to the account or home page.",
    "Given the login form, when required fields are empty, then inline validation messages are shown and submission is blocked."
  ],
  "testObjectives": [
    {
      "objectiveId": "ECOM-LOGIN-001-OBJ-01",
      "requirement": "Given a registered customer, when valid email and password are submitted, then the customer is signed in and redirected to the account or home page.",
      "category": "happy-path",
      "priority": "high",
      "given": "a registered customer",
      "when": "valid email and password are submitted",
      "then": "the customer is signed in and redirected to the account or home page",
      "testIntent": "Verify the login flow succeeds for the expected customer path: valid email and password are submitted",
      "assertions": [
        "the customer is signed in and redirected to the account or home page",
        "The user reaches an authenticated state or account page."
      ],
      "playwrightHints": [
        "Load the login page",
        "Use stable selectors",
        "Assert the visible end state",
        "Fill valid credentials",
        "Assert redirect or account header",
        "Validate outcome: the customer is signed in and redirected to the account or home page"
      ]
    }
  ]
}
```

## Unit Test Examples

The repository includes example unit tests in [agent/jira-mcp-agent.example.test.ts](../agent/jira-mcp-agent.example.test.ts) covering:

- successful normalization of acceptance criteria into structured objectives
- error handling for missing Jira story keys
