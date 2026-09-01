/**
 * Azure OpenAI client for the self-healing framework.
 *
 * Uses the native `fetch` API (Node 18+) — no extra SDK dependency.
 * The model is given a structured prompt describing the failing selector and
 * the live DOM elements collected from the page.  It returns JSON with a
 * candidate replacement selector, a confidence score, and reasoning.
 */

// ---------------------------------------------------------------------------
// Shared types (also consumed by self-healing-engine.ts)
// ---------------------------------------------------------------------------

export interface DomElement {
  tag: string;
  text: string;
  selector: string;        // best CSS selector for this element
  attributes: Record<string, string>;
}

export interface HealingContext {
  testTitle: string;
  testFile: string;
  failedSelector: string;
  selectorType?: "data-testid" | "id" | "css" | "xpath" | "text" | "role" | "other";
  action: "click" | "fill" | "check" | "waitFor" | "other";
  pageUrl: string;
  pageTitle: string;
}

export interface HealingSuggestion {
  /** Best-guess replacement selector */
  candidateSelector: string;
  /** Confidence in the suggestion, 0.0 – 1.0 */
  confidence: number;
  /** Human-readable explanation from the model */
  reasoning: string;
  /** Other possible selectors ordered by descending confidence */
  alternatives: string[];
}

// ---------------------------------------------------------------------------
// Client interface
// ---------------------------------------------------------------------------

export interface AzureOpenAiHealingClient {
  suggestReplacement(
    failedSelector: string,
    domElements: DomElement[],
    context: HealingContext,
  ): Promise<HealingSuggestion>;
}

// ---------------------------------------------------------------------------
// Azure OpenAI configuration
// ---------------------------------------------------------------------------

export interface AzureOpenAiConfig {
  endpoint: string;         // e.g. "https://my-resource.openai.azure.com"
  apiKey: string;
  deploymentName: string;   // e.g. "gpt-4o"
  apiVersion: string;       // e.g. "2024-02-15-preview"
  /** Max tokens for the completion. Default: 512 */
  maxTokens?: number;
  /** Request timeout in ms. Default: 20_000 */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// System + user prompt templates
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `
You are a Playwright test self-healing assistant.
Your task is to identify a replacement CSS selector when the original selector
can no longer be found in the live DOM.

Rules:
1. Prefer selectors in this order: data-testid → id → name attribute → aria-label → role+text → css path.
2. Never suggest XPath.
3. Output ONLY valid JSON — no markdown fences, no explanation outside the JSON.

Required JSON schema:
{
  "candidateSelector": "<string>",
  "confidence": <number 0.0-1.0>,
  "reasoning": "<string>",
  "alternatives": ["<string>", ...]
}
`.trimStart();

function buildUserPrompt(
  failedSelector: string,
  domElements: DomElement[],
  context: HealingContext,
): string {
  const elementLines = domElements
    .slice(0, 40) // keep prompt concise
    .map((el) => {
      const attrStr = Object.entries(el.attributes)
        .map(([k, v]) => `${k}="${v}"`)
        .join(" ");
      return `  <${el.tag} ${attrStr}>${el.text}</${el.tag}>  →  selector: "${el.selector}"`;
    })
    .join("\n");

  return `
## Test context
- File    : ${context.testFile}
- Title   : ${context.testTitle}
- URL     : ${context.pageUrl}
- Action  : ${context.action}

## Failed selector
${failedSelector}

## Interactive DOM elements currently visible on the page
${elementLines}

Identify the element that most likely replaced the one with selector "${failedSelector}".
`.trimStart();
}

// ---------------------------------------------------------------------------
// Real Azure OpenAI implementation
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionResponse {
  choices: Array<{
    message: { content: string };
    finish_reason: string;
  }>;
}

export class AzureOpenAiClient implements AzureOpenAiHealingClient {
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  constructor(private readonly config: AzureOpenAiConfig) {
    this.maxTokens = config.maxTokens ?? 512;
    this.timeoutMs = config.timeoutMs ?? 20_000;
  }

  async suggestReplacement(
    failedSelector: string,
    domElements: DomElement[],
    context: HealingContext,
  ): Promise<HealingSuggestion> {
    const url = `${this.config.endpoint}/openai/deployments/${this.config.deploymentName}/chat/completions?api-version=${this.config.apiVersion}`;

    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: buildUserPrompt(failedSelector, domElements, context),
      },
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let raw: string;
    try {
      const response = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "api-key": this.config.apiKey,
        },
        body: JSON.stringify({
          messages,
          max_tokens: this.maxTokens,
          temperature: 0.1,   // low temperature for deterministic selector matching
          response_format: { type: "json_object" },
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Azure OpenAI returned ${response.status}: ${body}`);
      }

      const json = (await response.json()) as ChatCompletionResponse;
      raw = json.choices[0]?.message?.content ?? "";
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") {
        throw new Error(`Azure OpenAI request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    return this.parseResponse(raw, failedSelector);
  }

  private parseResponse(raw: string, failedSelector: string): HealingSuggestion {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error(`Azure OpenAI returned non-JSON content: ${raw.slice(0, 200)}`);
    }

    const candidateSelector =
      typeof parsed["candidateSelector"] === "string"
        ? parsed["candidateSelector"].trim()
        : "";
    const confidence =
      typeof parsed["confidence"] === "number"
        ? Math.max(0, Math.min(1, parsed["confidence"]))
        : 0;
    const reasoning =
      typeof parsed["reasoning"] === "string" ? parsed["reasoning"] : "";
    const alternatives = Array.isArray(parsed["alternatives"])
      ? (parsed["alternatives"] as unknown[])
          .filter((a): a is string => typeof a === "string")
      : [];

    if (!candidateSelector) {
      throw new Error(
        `Azure OpenAI could not identify a replacement for "${failedSelector}": ${reasoning}`,
      );
    }

    return { candidateSelector, confidence, reasoning, alternatives };
  }
}

// ---------------------------------------------------------------------------
// Mock client (for unit tests and CI without OpenAI credentials)
// ---------------------------------------------------------------------------

export interface MockSuggestionMap {
  [failedSelector: string]: HealingSuggestion;
}

/**
 * Deterministic mock that returns pre-configured suggestions.
 * Falls back to a generic stub if the selector is not in the map.
 */
export class MockAzureOpenAiClient implements AzureOpenAiHealingClient {
  readonly calls: Array<{
    failedSelector: string;
    domElements: DomElement[];
    context: HealingContext;
  }> = [];

  constructor(private readonly suggestions: MockSuggestionMap = {}) {}

  async suggestReplacement(
    failedSelector: string,
    domElements: DomElement[],
    context: HealingContext,
  ): Promise<HealingSuggestion> {
    this.calls.push({ failedSelector, domElements, context });

    const suggestion = this.suggestions[failedSelector];
    if (suggestion) {
      return suggestion;
    }

    // Generic stub: picks the first dom element as the candidate
    const firstElement = domElements[0];
    return {
      candidateSelector: firstElement?.selector ?? '[data-testid="unknown"]',
      confidence: 0.5,
      reasoning: `Stub response: no pre-configured suggestion for "${failedSelector}"`,
      alternatives: [],
    };
  }
}
