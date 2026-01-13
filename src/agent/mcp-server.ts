import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Page, BrowserContext } from "playwright";
import { observePage } from "../browser/observe.js";
import { closeBrowserContext, stopTrace } from "../browser/harness.js";

let currentPage: Page | null = null;
let currentContext: BrowserContext | null = null;
let allowedHosts: string[] = [];
let tracePath: string | null = null;
let stepLog: Array<{
  action: string;
  target?: string;
  value?: string;
  outcome: string;
  url: string;
  timestamp: string;
}> = [];

export function setPageAndContext(
  page: Page,
  context: BrowserContext,
  hosts: string[],
  traceOutputPath?: string
): void {
  currentPage = page;
  currentContext = context;
  allowedHosts = hosts;
  tracePath = traceOutputPath || null;
  stepLog = [];
}

export function getStepLog() {
  return stepLog;
}

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
    url: currentPage?.url() || "",
    timestamp: new Date().toISOString(),
  });
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "browser", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "browser_observe",
    {
      description: "Observe the current page state including URL, title, interactive elements, and visible text",
    },
    async () => {
      if (!currentPage) {
        return {
          content: [{ type: "text", text: "Error: No browser page available" }],
        };
      }

      const observation = await observePage(currentPage);
      logStep("observe", "success");

      return {
        content: [{ type: "text", text: JSON.stringify(observation, null, 2) }],
      };
    }
  );

  const ActionSchema = z.object({
    action: z.enum(["goto", "click", "type", "press", "select", "scroll", "wait", "back"]),
    target: z.string().optional(),
    value: z.string().optional(),
  });

  server.registerTool(
    "browser_act",
    {
      description: "Perform a browser action like navigation, clicking, typing, etc.",
      inputSchema: {
        action: z.enum(["goto", "click", "type", "press", "select", "scroll", "wait", "back"])
          .describe("The action to perform"),
        target: z.string().optional()
          .describe("CSS selector, text content, or URL depending on action"),
        value: z.string().optional()
          .describe("Value for type/select actions, or scroll direction (up/down)"),
      },
    },
    async (args) => {
      if (!currentPage) {
        return {
          content: [{ type: "text", text: "Error: No browser page available" }],
        };
      }

      const { action, target, value } = args;
      const timeout = 30000;

      try {
        let outcome = "success";
        let navigationOccurred = false;

        switch (action) {
          case "goto": {
            if (!target) {
              return { content: [{ type: "text", text: "Error: goto requires a target URL" }] };
            }
            const url = new URL(target, currentPage.url());
            if (!allowedHosts.includes(url.hostname)) {
              logStep(action, "blocked", target);
              return {
                content: [{ type: "text", text: `Error: Navigation to ${url.hostname} is not allowed. Allowed hosts: ${allowedHosts.join(", ")}` }],
              };
            }
            await currentPage.goto(url.toString(), { timeout });
            navigationOccurred = true;
            break;
          }

          case "click": {
            if (!target) {
              return { content: [{ type: "text", text: "Error: click requires a target selector" }] };
            }
            const element = await currentPage.locator(target).first();
            await element.click({ timeout });
            await currentPage.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
            break;
          }

          case "type": {
            if (!target || !value) {
              return { content: [{ type: "text", text: "Error: type requires target and value" }] };
            }
            const input = await currentPage.locator(target).first();
            await input.fill(value, { timeout });
            break;
          }

          case "press": {
            if (!target) {
              return { content: [{ type: "text", text: "Error: press requires a key name" }] };
            }
            await currentPage.keyboard.press(target);
            break;
          }

          case "select": {
            if (!target || !value) {
              return { content: [{ type: "text", text: "Error: select requires target and value" }] };
            }
            const select = await currentPage.locator(target).first();
            await select.selectOption(value, { timeout });
            break;
          }

          case "scroll": {
            const direction = value === "up" ? -500 : 500;
            await currentPage.mouse.wheel(0, direction);
            await currentPage.waitForTimeout(500);
            break;
          }

          case "wait": {
            const waitTime = value ? parseInt(value, 10) : 1000;
            await currentPage.waitForTimeout(Math.min(waitTime, 10000));
            break;
          }

          case "back": {
            await currentPage.goBack({ timeout });
            navigationOccurred = true;
            break;
          }
        }

        logStep(action, outcome, target, value);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              action,
              target,
              value,
              navigationOccurred,
              currentUrl: currentPage.url(),
            }, null, 2),
          }],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logStep(action, `error: ${errorMessage}`, target, value);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              action,
              target,
              value,
              error: errorMessage,
            }, null, 2),
          }],
        };
      }
    }
  );

  server.registerTool(
    "browser_assert",
    {
      description: "Assert a condition about the current page state",
      inputSchema: {
        assertion: z.enum(["urlContains", "textVisible", "elementVisible"])
          .describe("The type of assertion to check"),
        expected: z.string()
          .describe("The expected value - URL substring, text content, or CSS selector"),
      },
    },
    async (args) => {
      if (!currentPage) {
        return {
          content: [{ type: "text", text: "Error: No browser page available" }],
        };
      }

      const { assertion, expected } = args;

      try {
        let passed = false;
        let actual = "";

        switch (assertion) {
          case "urlContains": {
            actual = currentPage.url();
            passed = actual.includes(expected);
            break;
          }

          case "textVisible": {
            const bodyText = await currentPage.locator("body").textContent() || "";
            actual = bodyText.includes(expected) ? expected : `Text "${expected}" not found`;
            passed = bodyText.includes(expected);
            break;
          }

          case "elementVisible": {
            const element = currentPage.locator(expected).first();
            passed = await element.isVisible({ timeout: 5000 }).catch(() => false);
            actual = passed ? "visible" : "not visible";
            break;
          }
        }

        logStep("assert", passed ? "passed" : "failed", assertion, expected);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              passed,
              assertion,
              expected,
              actual,
            }, null, 2),
          }],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logStep("assert", `error: ${errorMessage}`, assertion, expected);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              passed: false,
              assertion,
              expected,
              error: errorMessage,
            }, null, 2),
          }],
        };
      }
    }
  );

  server.registerTool(
    "browser_end",
    {
      description: "End the browser session, flushing trace data and closing the context",
    },
    async () => {
      if (!currentContext) {
        return {
          content: [{ type: "text", text: "Error: No browser context available" }],
        };
      }

      try {
        if (tracePath) {
          await stopTrace(currentContext, tracePath);
        }

        await closeBrowserContext({ context: currentContext, page: currentPage! });

        logStep("end", "success");

        const result = {
          success: true,
          traceSaved: !!tracePath,
          tracePath: tracePath || undefined,
        };

        currentPage = null;
        currentContext = null;
        tracePath = null;

        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logStep("end", `error: ${errorMessage}`);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: errorMessage,
            }, null, 2),
          }],
        };
      }
    }
  );

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
