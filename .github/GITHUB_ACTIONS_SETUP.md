# GitHub Actions Setup

## Required Secrets

To enable GitHub Actions workflows, you must configure the following secrets in your repository settings.

### How to Add Secrets

1. Go to **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**
3. Add each secret below

### Secret Configuration

#### Core Testing Secrets

| Secret Name | Description | Example |
|---|---|---|
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI service endpoint | `https://your-resource.openai.azure.com/` |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI API key | `sk-...` |

**How to obtain:**
- Log in to [Azure Portal](https://portal.azure.com)
- Navigate to **OpenAI** → your resource
- Copy endpoint from **Keys and Endpoint**
- Copy API key from **Keys and Endpoint**

#### Jira Integration Secrets (Optional)

These are only required if you want full Jira write-back integration:

| Secret Name | Description | Example |
|---|---|---|
| `JIRA_BASE_URL` | Jira instance URL | `https://your-org.atlassian.net` |
| `JIRA_USER_EMAIL` | Jira automation user email | `automation@company.com` |
| `JIRA_API_TOKEN` | Jira API token | `ATATT3xFfGF0...` |

**How to obtain:**
- Log in to [Atlassian Account](https://id.atlassian.com/manage-profile/security/api-tokens)
- Click **Create API token**
- Copy the generated token
- Store it as `JIRA_API_TOKEN` in GitHub Secrets

### Setting Secrets via CLI

If you prefer using the GitHub CLI:

```bash
gh secret set AZURE_OPENAI_ENDPOINT --body "https://your-resource.openai.azure.com/"
gh secret set AZURE_OPENAI_API_KEY --body "your-api-key"
gh secret set JIRA_BASE_URL --body "https://your-org.atlassian.net"
gh secret set JIRA_USER_EMAIL --body "automation@company.com"
gh secret set JIRA_API_TOKEN --body "your-api-token"
```

## Workflows

### CI Pipeline (`ci.yml`)

Runs on every push and pull request to `main` or `develop` branches.

**Jobs:**
1. **Lint & Type Check** — TypeScript compilation
2. **Unit Tests** — 42 unit tests (jira-mcp-agent, generator, orchestrator, jira-writer, self-healing)
3. **API Tests** — 9 API integration tests
4. **E2E Tests** — 3 Playwright E2E tests
5. **Test Summary** — Overall pass/fail decision

**Artifacts:**
- Playwright HTML report (30 days)
- Test videos (7 days)
- Failure screenshots (7 days on failure)

### Nightly Healing Demo (`nightly-healing.yml`)

Runs daily at 2 AM UTC (configurable via cron schedule) and on manual trigger.

**Purpose:**
- Demonstrates self-healing on a scheduled basis
- Captures healing proposals and artifacts
- Tests Azure OpenAI integration regularly

**Artifacts:**
- Healing proposals (90 days)
- Healing demo artifacts — screenshots, logs (30 days)

**Trigger manually:**
- Go to **Actions** → **Nightly Healing Demo**
- Click **Run workflow**

## Workflow Status Badges

Add these badges to your README to show CI/CD status:

```markdown
[![CI Pipeline](https://github.com/your-org/ai-e2e-regression-suite/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/ai-e2e-regression-suite/actions/workflows/ci.yml)
[![Nightly Healing Demo](https://github.com/your-org/ai-e2e-regression-suite/actions/workflows/nightly-healing.yml/badge.svg)](https://github.com/your-org/ai-e2e-regression-suite/actions/workflows/nightly-healing.yml)
```

## Environment Variables

All workflows use the following environment variables (set automatically in `ci.yml`):

```yaml
AZURE_OPENAI_DEPLOYMENT: gpt-4o
AZURE_OPENAI_API_VERSION: "2024-02-15-preview"
AUTO_APPROVE: "false"  # Set to "true" in nightly workflow for auto-approval
JIRA_PROJECT_KEY: ECOM
BASE_URL: https://opensource-demo.orangehrmlive.com/
NODE_VERSION: "18"
```

## Troubleshooting

### Tests fail with "Secret not found"

Ensure all required secrets are configured in Settings → Secrets. The workflow will continue with mock clients if secrets are missing, but real API calls will fail.

### Playwright tests timeout in CI

GitHub Actions may have slower network. The CI workflow installs browsers with `--with-deps` for better performance. If timeouts persist:
- Increase timeout in `playwright.config.ts`
- Run locally first: `npm run test:e2e:headed`

### E2E tests fail intermittently

OrangeHRM demo site occasionally has uptime issues. If E2E tests fail only in CI but pass locally:
1. Check https://opensource-demo.orangehrmlive.com/ is accessible
2. Re-run the workflow via **Actions** → **CI Pipeline** → **Run workflow**

### Healing demo always uses mock AI

The nightly workflow sets `AUTO_APPROVE=true` and uses Azure OpenAI from secrets. If no suggestions are generated:
1. Verify `AZURE_OPENAI_ENDPOINT` and `AZURE_OPENAI_API_KEY` are set
2. Check job logs in **Actions** for API errors
3. Azure OpenAI quota may be exhausted — check Azure portal

## Next Steps

1. Configure secrets: https://github.com/your-org/ai-e2e-regression-suite/settings/secrets/actions
2. Verify CI passes: https://github.com/your-org/ai-e2e-regression-suite/actions
3. Add badges to README
4. Set branch protection rules (Settings → Branches → Add rule)
   - Require CI pipeline to pass before merge
   - Require PR reviews
