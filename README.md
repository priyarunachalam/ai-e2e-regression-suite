<div align="center">

# 🤖 AI E2E Regression Suite

**An intelligent, self-healing end-to-end automation framework**  
powered by Playwright · Azure OpenAI · Jira MCP

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Playwright](https://img.shields.io/badge/Playwright-1.54-2EAD33?logo=playwright&logoColor=white)](https://playwright.dev/)
[![Azure OpenAI](https://img.shields.io/badge/Azure_OpenAI-GPT--4o-0078D4?logo=microsoft-azure&logoColor=white)](https://azure.microsoft.com/en-us/products/ai-services/openai-service)
[![Tests](https://img.shields.io/badge/Tests-44%20passing-brightgreen)](.)
[![License](https://img.shields.io/badge/License-MIT-blue)](.)

</div>

---

# AI E2E Regression Suite

A fully implemented TypeScript end-to-end automation framework that combines
Playwright, Azure OpenAI, and Jira MCP into a self-healing regression pipeline.

## Demo Target

- **OrangeHRM demo site:** https://opensource-demo.orangehrmlive.com/

---

## Overview

This framework demonstrates how AI-assisted tooling can automate the full
software testing lifecycle — from reading a Jira story through to posting
results back to Jira — with a built-in self-healing layer that recovers
automatically from selector drift without requiring manual test maintenance.

The pipeline reads **acceptance criteria** from a Jira story, uses an AI model
to **generate Playwright test code**, **executes the tests**, and if any fail
due to a changed UI selector it **calls Azure OpenAI** to identify the
replacement element, **patches the spec file**, **re-runs**, and finally
**posts a structured comment** and **transitions the Jira issue status**
automatically.

> **Demo target:** OrangeHRM open-source HR demo — login scenarios (valid
> credentials and invalid credentials) mapped to story `ECOM-LOGIN-001`.

---

## Architecture

```mermaid
flowchart LR
    A[Jira Story] --> B[Jira MCP]
    B --> C[Playwright MCP]
    C --> D[Generated Test]
    D --> E[Playwright Execution]
    E --> F[Azure OpenAI Self-Healing]
    F --> G[Jira Update]
```

### Component Map

| Layer | File | Responsibility |
|---|---|---|
| **Jira reader** | `jira-client.ts` | Reads `story-login.json`, exposes acceptance criteria and test scenarios |
| **Story normaliser** | `agent/jira-mcp-agent.ts` | Classifies AC into `happy-path`, `error-handling`, `validation`, `regression`; builds Given/When/Then + Playwright hints |
| **Test generator** | `agent/playwright-mcp-generator.ts` | Prompt template builder → Playwright MCP call → SHA-256 cached `.spec.ts` output |
| **Page objects** | `playwright-tests/pages/*.ts` | Encapsulate selectors and interactions; used by E2E tests for maintainability |
| **Test runner** | `agent/orchestrator.ts` | Spawns `playwright test --reporter=json`, parses results |
| **API client** | `api/orangehrm-api.client.ts` | REST client for OrangeHRM API — authentication, employee CRUD, token verification |
| **Healing AI** | `healing/azure-openai-client.ts` | Sends failing selector + live DOM to Azure OpenAI, returns `{candidateSelector, confidence, reasoning}` |
| **Healing engine** | `healing/self-healing-engine.ts` | DOM inspection → AI suggestion → approval gate → spec patch → retry |
| **Proposal store** | `healing/healing-store.ts` | File-based `healing-proposals.json` with `pending→approved/rejected` lifecycle |
| **Jira writer** | `jira/jira-writer.ts` | Posts ADF-formatted comments and transitions issue status via Jira REST API |
| **Orchestrator** | `agent/orchestrator.ts` | Drives all 7 pipeline steps; wires all components; returns `OrchestrationResult` |
| **Logger** | `agent/orchestrator-logger.ts` | Structured JSON logs with `pipelineId`, step timing, level filtering, pluggable transports |

---

## Setup Instructions

### Prerequisites

| Tool | Version |
|---|---|
| Node.js | 18+ |
| npm | 9+ |

### 1. Clone and install

```bash
git clone https://github.com/your-org/ai-e2e-regression-suite.git
cd ai-e2e-regression-suite
npm install
```

### 2. Install Playwright browsers

```bash
npx playwright install chromium
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Application under test
BASE_URL=https://opensource-demo.orangehrmlive.com/

# Azure OpenAI — required for self-healing
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
AZURE_OPENAI_API_KEY=your-api-key
AZURE_OPENAI_DEPLOYMENT=gpt-4o
AZURE_OPENAI_API_VERSION=2024-02-15-preview

# Self-healing approval (set to true in CI to auto-approve all suggestions)
AUTO_APPROVE=false

# Jira REST API — required for Jira write-back
JIRA_BASE_URL=https://your-org.atlassian.net
JIRA_USER_EMAIL=automation@your-org.com
JIRA_API_TOKEN=your-api-token
JIRA_PROJECT_KEY=ECOM
```

---

## Running the Solution

### Run the generated E2E tests

```bash
# Headless (default)
npm run test:e2e

# Headed — watch the browser
npm run test:e2e:headed

# Interactive Playwright UI
npm run test:e2e:ui
```

Expected output:

```
Running 2 tests using 1 worker

  ✓  1 …valid email and password are submitted (5.9s)
  ✓  2 …authentication failures are handled safely (3.5s)

  2 passed (11.6s)
```

### Run all unit test suites

```bash
npm run test:unit
```

### Run API tests

```bash
npm run test:api
```

### Run all tests (unit + API + E2E)

```bash
npm run test:all
```

### Type-check

```bash
.\node_modules\.bin\tsc --noEmit
```

### Test coverage summary

| Suite | Tests | Result |
|---|---|---|
| `jira-mcp-agent.example.test.ts` | 2 | ✅ pass |
| `playwright-mcp-generator.example.test.ts` | 8 | ✅ pass |
| `orchestrator.example.test.ts` | 8 | ✅ pass |
| `jira-writer.example.test.ts` | 16 | ✅ pass |
| `self-healing-engine.example.test.ts` | 8 | ✅ pass |
| `orangehrm-api.example.test.ts` (API) | 9 | ✅ pass |
| `playwright-tests/login.spec.ts` (E2E) | 3 | ✅ pass |
| **Total** | **54** | **✅ all pass** |

---

## Page Object Model (POM)

This framework includes a mature page object model for maintainable test code. Page objects encapsulate selectors and interactions, making tests more readable and resistant to UI changes.

### Page Objects

| File | Purpose |
|---|---|
| `playwright-tests/pages/login.page.ts` | OrangeHRM login form — username/password fields, login button, error handling |
| `playwright-tests/pages/dashboard.page.ts` | Dashboard after successful login — navigation, logout |

### Usage Example

```typescript
import { LoginPage } from './pages/login.page';
import { DashboardPage } from './pages/dashboard.page';

test('successful login', async ({ page }) => {
  const loginPage = new LoginPage(page);
  const dashboardPage = new DashboardPage(page);

  // Navigate and verify login page loaded
  await loginPage.goto();
  await loginPage.assertLoginPageDisplayed();

  // Perform login
  await loginPage.login('Admin', 'admin123');

  // Verify dashboard
  await dashboardPage.assertDashboardDisplayed();
  await dashboardPage.assertUserLoggedIn();
});
```

### Creating New Page Objects

Each page object extends the following pattern:

```typescript
import { Page, expect } from '@playwright/test';

export class MyPage {
  readonly page: Page;

  // ── Selectors ────────────────────────────────────────────────────
  readonly myButton = 'button[data-testid="my-button"]';
  readonly myInput = 'input[name="myInput"]';

  constructor(page: Page) {
    this.page = page;
  }

  // ── Navigation ───────────────────────────────────────────────────
  async goto(): Promise<void> {
    await this.page.goto('/my-page');
  }

  // ── Interactions ─────────────────────────────────────────────────
  async clickMyButton(): Promise<void> {
    await this.page.click(this.myButton);
  }

  // ── Assertions ───────────────────────────────────────────────────
  async assertPageLoaded(): Promise<void> {
    await expect(this.page.locator(this.myInput)).toBeVisible();
  }
}
```

Benefits of POM:

- **Maintainability**: Change selector once, all tests updated automatically
- **Readability**: Test code reads like user actions, not CSS internals
- **Reusability**: Share page objects across multiple test suites
- **Locator consistency**: Healing engine can patch selectors in page objects directly

---

## API Testing

The framework includes a comprehensive REST API client for testing OrangeHRM API endpoints. This enables end-to-end API validation alongside UI testing.

### API Client

| File | Purpose |
|---|---|
| `api/orangehrm-api.client.ts` | OrangeHRM REST API client — authentication, employee CRUD, token verification |
| `api/orangehrm-api.example.test.ts` | 9 API integration tests with mock and real client support |

### API Client Features

- **Authentication**: `POST /api/v1/auth/login` with `username` and `password`
- **Employee management**: `GET /api/v1/admin/employees`, `GET /api/v1/admin/employees/{id}`
- **Token verification**: Validate access token expiry and permissions
- **Error handling**: Typed `ApiResponse<T>` with `status`, `statusText`, `data`, `error` fields
- **Network resilience**: Automatic timeout handling and graceful error reporting

### Usage Example

```typescript
import { OrangeHRMApiClient } from './api/orangehrm-api.client';

const client = new OrangeHRMApiClient('https://opensource-demo.orangehrmlive.com/api/v1');

// Authenticate
const authResult = await client.authenticate('Admin', 'admin123');
if (authResult.status !== 200) {
  console.error('Authentication failed:', authResult.error);
  return;
}

// Fetch employees
const employeesResult = await client.getEmployees(limit: 50);
if (employeesResult.data) {
  console.log('Employees:', employeesResult.data);
}

// Verify token
const isValid = await client.verifyToken();
console.log('Token valid:', isValid);
```

### API Testing Integration

Run API tests independently:

```bash
npm run test:api
```

Add API validation to E2E tests:

```typescript
import { OrangeHRMApiClient } from '../api/orangehrm-api.client';

test('login succeeds and API is accessible', async ({ page }) => {
  const loginPage = new LoginPage(page);
  const api = new OrangeHRMApiClient();

  // UI login
  await loginPage.goto();
  await loginPage.login('Admin', 'admin123');

  // API validation: verify token and fetch employee data
  const authResult = await api.authenticate('Admin', 'admin123');
  expect(authResult.status).toBe(200);

  const employeesResult = await api.getEmployees();
  expect(employeesResult.data?.data.length).toBeGreaterThan(0);
});
```

### Mock vs. Real API Client

All 9 API tests use a `MockOrangeHRMApiClient` for CI/CD reliability (no external API dependency).
To test against real OrangeHRM API:

```typescript
const client = new OrangeHRMApiClient('https://demo.orangehrmlive.com/api/v1');
const result = await client.authenticate('Admin', 'admin123');
// Uses native fetch; real API calls
```

---

## Self-Healing Explanation

When a Playwright test fails because a UI selector can no longer be found
(e.g. a button's `data-testid` was renamed), the framework executes the
recovery workflow below.

### Self-Healing State Diagram

```mermaid
stateDiagram-v2
    [*] --> TestRunning : npm run execute

    TestRunning --> TestPassed : All selectors found ✅
    TestRunning --> TestFailed : Selector not found ❌

    TestPassed --> JiraCommentPass : Write PASS to Jira
    JiraCommentPass --> [*]

    TestFailed --> JiraCommentFail : Write FAIL to Jira
    TestFailed --> DOMScan : healing/analyzer.ts triggered

    DOMScan --> CandidateFound : Similar selector found\n(e.g. login-button, 95%)
    DOMScan --> NoCandidateFound : No similar selector exists

    NoCandidateFound --> ManualFix : Manual intervention required
    ManualFix --> [*]

    CandidateFound --> PatchGenerated : Generate diff preview\ndocs/self-healing/*.diff

    PatchGenerated --> ApprovalPending : Write jira/approvals/\napproval-DEMO-102.json\nstatus: PENDING

    ApprovalPending --> HumanReview : ⏸️ WORKFLOW PAUSED\nAwaiting human decision

    HumanReview --> Approved : npm run approve\nstatus: APPROVED
    HumanReview --> Rejected : npm run reject\nstatus: REJECTED

    Approved --> PatchApplied : patch-applier.ts\nBackup + Replace selector
    PatchApplied --> TestRerun : Re-run patched test

    TestRerun --> TestPassed2 : PASS ✅
    TestRerun --> TestFailed2 : FAIL ❌ (unexpected)

    TestPassed2 --> JiraCommentHealed : Post: Patch applied + PASS
    TestFailed2 --> JiraCommentHealFail : Post: Patch applied but FAIL
    JiraCommentHealed --> [*]
    JiraCommentHealFail --> [*]

    Rejected --> JiraCommentReject : Post: Patch REJECTED\nNo code modified
    JiraCommentReject --> [*]
```

### How it works in code

**Scenario: `data-testid="login-btn"` renamed to `data-testid="signin-btn"`**

```jsonc
// healing/healing-proposals.json (after healing)
{
  "proposals": [{
    "proposalId": "heal-3f8a1c9e0b7d",
    "status": "approved",
    "decidedBy": "auto-confidence",
    "context": {
      "failedSelector": "[data-testid=\"login-btn\"]",
      "action": "click",
      "pageUrl": "https://opensource-demo.orangehrmlive.com/web/index.php/auth/login"
    },
    "suggestion": {
      "candidateSelector": "[data-testid=\"signin-btn\"]",
      "confidence": 0.94,
      "reasoning": "The element login-btn is no longer present. A button with data-testid=\"signin-btn\" and visible text \"Sign In\" is the clear replacement.",
      "alternatives": ["button[type=\"submit\"]", "[aria-label=\"Sign In\"]"]
    },
    "proposedAt": "2026-09-01T09:00:00.000Z",
    "decidedAt": "2026-09-01T09:00:00.312Z"
  }]
}
```

To integrate self-healing into your own tests:

```typescript
import { createHealingTest } from '../healing/self-healing-engine';
import { AzureOpenAiClient } from '../healing/azure-openai-client';

export const test = createHealingTest({
  aiClient: new AzureOpenAiClient({
    endpoint:       process.env.AZURE_OPENAI_ENDPOINT!,
    apiKey:         process.env.AZURE_OPENAI_API_KEY!,
    deploymentName: 'gpt-4o',
    apiVersion:     '2024-02-15-preview',
  }),
  options: { autoApproveThreshold: 0.85 },
});

// In your test:
test('login flow', async ({ page, selfHeal }) => {
  await page.goto('/');
  await selfHeal.click(page, '[data-testid="login-btn"]');  // heals automatically
});
```

---

## Security Approach

This framework follows the [OWASP Top 10](https://owasp.org/www-project-top-ten/)
principles throughout:

| Risk | Mitigation |
|---|---|
| **Secrets exposure** | All credentials (`AZURE_OPENAI_API_KEY`, `JIRA_API_TOKEN`) stored in `.env` only; `.env` is gitignored; no secrets in source code or logs |
| **Injection** | Azure OpenAI prompts are constructed from typed `HealingContext` and `DomElement` interfaces — no raw user input concatenated into prompts |
| **Insecure direct object references** | Jira story access is key-scoped; `JiraClient` validates file path before reading |
| **Security misconfiguration** | Mock clients (`MockJiraHttpClient`, `MockAzureOpenAiClient`) used in all tests — no real credentials needed for CI |
| **Sensitive data logging** | Log entries use structured fields; no API keys, passwords, or tokens are logged at any level |
| **Unvalidated AI output** | `parseResponse()` in `AzureOpenAiClient` validates all fields with type guards before use; malformed JSON throws a typed error |
| **Unsafe file writes** | `SpecPatcher` only patches files that exist on disk; selector replacement uses escaped regex — no arbitrary code injection |
| **Dependency vulnerabilities** | Minimal dependency surface: `@playwright/test`, `typescript`, `ts-node`, `@types/node` only — no ORM, no web server, no auth library |
| **Request timeouts** | `AzureOpenAiClient` enforces a configurable `timeoutMs` (default 20 s) with `AbortController` to prevent hanging CI pipelines |
| **Audit trail** | All healing decisions are persisted to `healing-proposals.json` with `decidedBy` and `decidedAt` fields for auditability |

---

## Screenshots

> Capture these during a live demo run and place files in `screenshots/`.

| # | Description | Filename |
|---|---|---|
| 1 | Jira issue `ECOM-LOGIN-001` — acceptance criteria and test scenarios visible | `01-jira-story-ecom-login-001.png` |
| 2 | VS Code showing `playwright-tests/login.spec.ts` — both test blocks and selector constants | `02-generated-test-login-spec.png` |
| 3 | Terminal: `2 passed (11.6s)` — green checkmarks on both scenarios | `03-test-execution-passed.png` |
| 4 | Terminal: `1 failed` — timeout error on `[data-testid="login-btn"]` | `04-test-execution-failed.png` |
| 5 | Terminal or `healing-proposals.json`: AI suggestion with `confidence: 0.94` and `candidateSelector` | `05-self-healing-recommendation.png` |
| 6 | Split view: `healing-proposals.json` showing `"status": "approved"` + patched `login.spec.ts` showing `signin-btn` | `06-healing-approved-fix.png` |
| 7 | Jira comment posted with `✅ PASSED` / `❌ FAILED` badge and issue transitioned to `Done` | `07-jira-update-comment-and-status.png` |

---

## AI Tools Used

| Tool | Role in this project |
|---|---|
| **GitHub Copilot (Claude Sonnet 4.6)** | Entire implementation — architecture design, all TypeScript source files, test suites, prompt templates, and this README |
| **Azure OpenAI (GPT-4o)** | Runtime self-healing: receives failing selector + live DOM snapshot, returns structured JSON with `candidateSelector`, `confidence`, and `reasoning` |
| **Playwright MCP** | Test code generation interface: `PlaywrightMcpClient` interface receives a structured prompt and returns runnable TypeScript Playwright test blocks |
| **Jira MCP simulation** | `JiraMcpAgent` simulates reading acceptance criteria from a Jira MCP server, normalises them into typed `StructuredTestObjective` records |

---

## What Was Implemented Manually

The following decisions and configurations were made manually (not AI-generated):

- **Project brief and requirements** — the user story, acceptance criteria in `jira/story-login.json`, and all prompt instructions to GitHub Copilot
- **OrangeHRM selector research** — identifying the correct CSS selectors (`input[name="username"]`, `.oxd-alert-content-text`, `.oxd-topbar-header-breadcrumb`) by inspecting the live demo site
- **Environment configuration** — `.env.example` values and the mock credential strategy for local development
- **Git commit strategy** — each feature committed separately for a clean history
- **Screenshot capture** — taking the 7 assessment screenshots against the live application

Everything else — all TypeScript source files, interfaces, test suites, error handling, caching logic, ADF comment formatting, healing prompt templates, orchestration flow, and this README — was implemented by GitHub Copilot.

---

## Future Improvements

| Area | Improvement |
|---|---|
| **Healing approval UI** | A lightweight web dashboard to review and approve pending proposals instead of editing JSON manually |
| **Parallel test execution** | Run multiple Jira stories through the orchestrator concurrently using `Promise.all` with worker limits |
| **Visual regression** | Integrate [Percy](https://percy.io/) or [Applitools](https://applitools.com/) for pixel-level change detection alongside selector healing |
| **Healing confidence tuning** | Log approval/rejection outcomes and fine-tune the Azure OpenAI system prompt based on observed accuracy over time |
| **Real Jira MCP integration** | Replace `JiraClient` JSON file reader with a live Atlassian MCP server connection for real-time story fetching |
| **CI/CD pipeline** | GitHub Actions workflow that runs the full orchestrator on every PR, posts results as PR comments, and fails the build on test regression |
| **Healing history analytics** | Export `healing-proposals.json` to a time-series store to track which selectors drift most frequently and alert developers |
| **Multi-browser matrix** | Extend `PlaywrightCliRunner` to run tests across Chromium, Firefox, and WebKit in parallel and aggregate results per-browser |
| **Test impact analysis** | Use the Jira story graph to identify which test suites are affected by a given story change and run only those |
| **Retry budget** | Add `maxHealingAttempts` cap per selector and escalate unresolved failures to a Jira sub-task automatically |

---

## Folder Structure

```
ai-e2e-regression-suite/
├── agent/
│   ├── jira-mcp-agent.ts                    Story normalisation + objective classification
│   ├── jira-mcp-agent.example.test.ts       Unit tests (2)
│   ├── playwright-mcp-generator.ts          Prompt builder + MCP generator + file cache
│   ├── playwright-mcp-generator.example.test.ts  Unit tests (8)
│   ├── orchestrator-logger.ts               Structured logger with step timing
│   ├── orchestrator.ts                      7-step pipeline orchestrator
│   └── orchestrator.example.test.ts         Unit tests (8)
├── api/
│   ├── orangehrm-api.client.ts              OrangeHRM REST API client + authentication
│   └── orangehrm-api.example.test.ts        API integration tests (9)
├── healing/
│   ├── azure-openai-client.ts               Azure OpenAI client (fetch) + mock
│   ├── healing-store.ts                     Proposal store: file-based + in-memory
│   ├── self-healing-engine.ts               Healing loop + Playwright fixture factory
│   ├── self-healing-engine.example.test.ts  Unit tests (8)
│   └── healing-proposals.json              ← generated at runtime
├── jira/
│   ├── story-login.json                     Source Jira story: ECOM-LOGIN-001
│   ├── jira-writer.ts                       ADF comment + transition writer + mock
│   └── jira-writer.example.test.ts          Unit tests (16)
├── playwright-tests/
│   ├── pages/
│   │   ├── login.page.ts                    Page object: login form
│   │   └── dashboard.page.ts                Page object: dashboard
│   ├── login.spec.ts                        Generated E2E tests (2 scenarios, using POM)
│   ├── login-healing-demo.spec.ts           Self-healing demo with intentional drift
│   └── .cache/                             ← SHA-256 keyed generation cache
├── screenshots/                             ← test failure evidence
├── docs/
│   └── jira-mcp-agent-sample-output.md
├── scripts/
│   └── healing-demo.ts                      Interactive 8-step self-healing demo
├── jira-client.ts                           JSON story file reader
├── package.json
├── tsconfig.json
└── .env.example
```

---

<div align="center">

Built with GitHub Copilot · Azure OpenAI · Playwright · TypeScript

</div>
