import Anthropic from "@anthropic-ai/sdk";
import type { BetaToolUnion } from "@anthropic-ai/sdk/resources/beta.mjs";
import type { Page, BrowserContext } from "playwright";
import { observePage } from "../browser/observe.js";
import { closeBrowserContext, stopTrace } from "../browser/harness.js";
import type { Scenario, Persona, Config, EvaluationQuestion } from "../config/schema.js";

interface RunnerOptions {
  scenario: Scenario;
  persona: Persona;
  config: Config;
  page: Page;
  context: BrowserContext;
  tracePath?: string;
  maxTurns?: number;
  evaluationQuestions?: EvaluationQuestion[];
}

export interface StepLogEntry {
  action: string;
  target?: string;
  value?: string;
  outcome: string;
  url: string;
  timestamp: string;
}

export interface AgentRunResult {
  success: boolean;
  messages: Anthropic.Beta.Messages.BetaMessageParam[];
  stepLog: StepLogEntry[];
  finalMessage: Anthropic.Beta.Messages.BetaMessage | null;
  freeTextAnswers: Record<string, string>;
  qualitativeFeedback?: string;
}

function buildSystemPrompt(scenario: Scenario, persona: Persona): string {
  const traits = persona.traits.join(", ");
  const demographics = persona.demographics
    ? `\nDemographics: ${JSON.stringify(persona.demographics)}`
    : "";

  return `You are a synthetic user testing a website. You are roleplaying as a specific persona.

## Your Persona
Name: ${persona.name}
Traits: ${traits}${demographics}

## Your Task
Goal: ${scenario.goal}
Success Criteria: ${scenario.successCriteria}

## Instructions
1. Use browser_observe to see the current page state
2. Use browser_act to interact with the page (click, type, navigate, etc.)
3. Use browser_assert to verify conditions
4. When you have completed the task (success or failure), use browser_end to finish

Always think step-by-step about what a user with your persona traits would do.
If you encounter difficulties, behave as your persona would - for example, an impatient user might give up sooner.

Start by observing the current page, then work towards achieving the goal.`;
}

export async function runAgent(options: RunnerOptions): Promise<AgentRunResult> {
  const {
    scenario,
    persona,
    config,
    page,
    context,
    tracePath,
    maxTurns = 50,
    evaluationQuestions = [],
  } = options;

  const client = new Anthropic();
  const stepLog: StepLogEntry[] = [];
  let sessionEnded = false;

  function logStep(
    action: string,
    outcome: string,
    target?: string,
    value?: string
  ) {
    stepLog.push({
      action,
      target,
      value,
      outcome,
      url: page.url(),
      timestamp: new Date().toISOString(),
    });
  }

  const browserObserveTool: BetaToolUnion & {
    run: () => Promise<string>;
    parse: (content: unknown) => Record<string, never>;
  } = {
    name: "mcp__browser__observe",
    description:
      "Observe the current page state including URL, title, interactive elements, and visible text",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
    run: async () => {
      const observation = await observePage(page);
      logStep("observe", "success");
      return JSON.stringify(observation, null, 2);
    },
    parse: () => ({}),
  };

  const browserActTool: BetaToolUnion & {
    run: (args: {
      action: string;
      target?: string;
      value?: string;
    }) => Promise<string>;
    parse: (content: unknown) => { action: string; target?: string; value?: string };
  } = {
    name: "mcp__browser__act",
    description:
      "Perform a browser action like navigation, clicking, typing, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["goto", "click", "type", "press", "select", "scroll", "wait", "back"],
          description: "The action to perform",
        },
        target: {
          type: "string",
          description: "CSS selector, text content, or URL depending on action",
        },
        value: {
          type: "string",
          description: "Value for type/select actions, or scroll direction (up/down)",
        },
      },
      required: ["action"],
    },
    run: async (args) => {
      const { action, target, value } = args;
      const timeout = 30000;

      try {
        let navigationOccurred = false;

        switch (action) {
          case "goto": {
            if (!target) {
              logStep(action, "error: missing target", target);
              return JSON.stringify({ success: false, error: "goto requires a target URL" });
            }
            const url = new URL(target, page.url());
            if (!config.allowedHosts.includes(url.hostname)) {
              logStep(action, "blocked", target);
              return JSON.stringify({
                success: false,
                error: `Navigation to ${url.hostname} is not allowed. Allowed hosts: ${config.allowedHosts.join(", ")}`,
              });
            }
            await page.goto(url.toString(), { timeout });
            navigationOccurred = true;
            break;
          }

          case "click": {
            if (!target) {
              logStep(action, "error: missing target", target);
              return JSON.stringify({ success: false, error: "click requires a target selector" });
            }
            const element = await page.locator(target).first();
            await element.click({ timeout });
            await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
            break;
          }

          case "type": {
            if (!target || !value) {
              logStep(action, "error: missing target or value", target, value);
              return JSON.stringify({ success: false, error: "type requires target and value" });
            }
            const input = await page.locator(target).first();
            await input.fill(value, { timeout });
            break;
          }

          case "press": {
            if (!target) {
              logStep(action, "error: missing key name", target);
              return JSON.stringify({ success: false, error: "press requires a key name" });
            }
            await page.keyboard.press(target);
            break;
          }

          case "select": {
            if (!target || !value) {
              logStep(action, "error: missing target or value", target, value);
              return JSON.stringify({ success: false, error: "select requires target and value" });
            }
            const select = await page.locator(target).first();
            await select.selectOption(value, { timeout });
            break;
          }

          case "scroll": {
            const direction = value === "up" ? -500 : 500;
            await page.mouse.wheel(0, direction);
            await page.waitForTimeout(500);
            break;
          }

          case "wait": {
            const waitTime = value ? parseInt(value, 10) : 1000;
            await page.waitForTimeout(Math.min(waitTime, 10000));
            break;
          }

          case "back": {
            await page.goBack({ timeout });
            navigationOccurred = true;
            break;
          }
        }

        logStep(action, "success", target, value);

        return JSON.stringify({
          success: true,
          action,
          target,
          value,
          navigationOccurred,
          currentUrl: page.url(),
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logStep(action, `error: ${errorMessage}`, target, value);
        return JSON.stringify({
          success: false,
          action,
          target,
          value,
          error: errorMessage,
        });
      }
    },
    parse: (content) => content as { action: string; target?: string; value?: string },
  };

  const browserAssertTool: BetaToolUnion & {
    run: (args: { assertion: string; expected: string }) => Promise<string>;
    parse: (content: unknown) => { assertion: string; expected: string };
  } = {
    name: "mcp__browser__assert",
    description: "Assert a condition about the current page state",
    input_schema: {
      type: "object" as const,
      properties: {
        assertion: {
          type: "string",
          enum: ["urlContains", "textVisible", "elementVisible"],
          description: "The type of assertion to check",
        },
        expected: {
          type: "string",
          description: "The expected value - URL substring, text content, or CSS selector",
        },
      },
      required: ["assertion", "expected"],
    },
    run: async (args) => {
      const { assertion, expected } = args;

      try {
        let passed = false;
        let actual = "";

        switch (assertion) {
          case "urlContains": {
            actual = page.url();
            passed = actual.includes(expected);
            break;
          }

          case "textVisible": {
            const bodyText = (await page.locator("body").textContent()) || "";
            actual = bodyText.includes(expected) ? expected : `Text "${expected}" not found`;
            passed = bodyText.includes(expected);
            break;
          }

          case "elementVisible": {
            const element = page.locator(expected).first();
            passed = await element.isVisible({ timeout: 5000 }).catch(() => false);
            actual = passed ? "visible" : "not visible";
            break;
          }
        }

        logStep("assert", passed ? "passed" : "failed", assertion, expected);

        return JSON.stringify({
          passed,
          assertion,
          expected,
          actual,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logStep("assert", `error: ${errorMessage}`, assertion, expected);
        return JSON.stringify({
          passed: false,
          assertion,
          expected,
          error: errorMessage,
        });
      }
    },
    parse: (content) => content as { assertion: string; expected: string },
  };

  const browserEndTool: BetaToolUnion & {
    run: () => Promise<string>;
    parse: (content: unknown) => Record<string, never>;
  } = {
    name: "mcp__browser__end",
    description: "End the browser session, flushing trace data and closing the context",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
    run: async () => {
      try {
        if (tracePath) {
          await stopTrace(context, tracePath);
        }

        await closeBrowserContext({ context, page });
        sessionEnded = true;

        logStep("end", "success");

        return JSON.stringify({
          success: true,
          traceSaved: !!tracePath,
          tracePath: tracePath || undefined,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logStep("end", `error: ${errorMessage}`);
        return JSON.stringify({
          success: false,
          error: errorMessage,
        });
      }
    },
    parse: () => ({}),
  };

  const tools = [browserObserveTool, browserActTool, browserAssertTool, browserEndTool];

  const systemPrompt = buildSystemPrompt(scenario, persona);

  const runner = client.beta.messages.toolRunner({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: `Please complete the following task: ${scenario.goal}\n\nStart by observing the current page at ${config.baseUrl}`,
      },
    ],
    tools,
    max_iterations: maxTurns,
  });

  let finalMessage: Anthropic.Beta.Messages.BetaMessage | null = null;

  try {
    finalMessage = await runner.runUntilDone();
  } catch (error) {
    console.error("Agent run error:", error);
  }

  const success =
    sessionEnded ||
    (finalMessage?.stop_reason === "end_turn" &&
      stepLog.some((s) => s.action === "assert" && s.outcome === "passed"));

  const freeTextAnswers: Record<string, string> = {};
  let qualitativeFeedback: string | undefined;

  if (evaluationQuestions.length > 0) {
    try {
      const evalResult = await collectEvaluationAnswers(
        client,
        persona,
        scenario,
        evaluationQuestions,
        success
      );
      Object.assign(freeTextAnswers, evalResult.answers);
      qualitativeFeedback = evalResult.qualitativeFeedback;
    } catch (error) {
      console.error("Error collecting evaluation answers:", error);
    }
  }

  return {
    success,
    messages: runner.params.messages,
    stepLog,
    finalMessage,
    freeTextAnswers,
    qualitativeFeedback,
  };
}

async function collectEvaluationAnswers(
  client: Anthropic,
  persona: Persona,
  scenario: Scenario,
  questions: EvaluationQuestion[],
  taskSucceeded: boolean
): Promise<{ answers: Record<string, string>; qualitativeFeedback?: string }> {
  const questionList = questions
    .map((q, i) => `${i + 1}. ${q.question}`)
    .join("\n");

  const prompt = `You just finished attempting a task on a website. The task was: "${scenario.goal}"
The task ${taskSucceeded ? "was completed successfully" : "could not be completed"}.

As the persona "${persona.name}" (${persona.traits.join(", ")}), please answer the following evaluation questions based on your experience.

For each question, provide a thoughtful free-text response (2-4 sentences) that reflects how someone with your persona's traits would feel about the experience.

Questions:
${questionList}

Also provide any additional qualitative feedback about your overall experience.

Respond in JSON format:
{
  "answers": {
    "<question_id>": "<your answer>",
    ...
  },
  "qualitativeFeedback": "<overall feedback>"
}`;

  const questionIds = questions.map((q) => q.id);

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const textContent = response.content.find((c) => c.type === "text");
  if (!textContent || textContent.type !== "text") {
    return { answers: {} };
  }

  try {
    const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { answers: {} };
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      answers?: Record<string, string>;
      qualitativeFeedback?: string;
    };

    const answers: Record<string, string> = {};
    if (parsed.answers) {
      for (const id of questionIds) {
        if (parsed.answers[id]) {
          answers[id] = parsed.answers[id];
        }
      }
    }

    return {
      answers,
      qualitativeFeedback: parsed.qualitativeFeedback,
    };
  } catch {
    return { answers: {} };
  }
}
