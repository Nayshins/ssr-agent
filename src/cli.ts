#!/usr/bin/env node
import { Command } from "commander";
import { writeFileSync, mkdirSync, existsSync, readFileSync, cpSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig, type Persona } from "./config/schema.js";
import { createBrowserContext, startTrace, captureScreenshot } from "./browser/harness.js";
import { runAgent, type AgentRunResult, type StepLogEntry } from "./agent/runner.js";
import { persistAllResults } from "./results/persist.js";
import { scoreAllAnswers, saveSsrScores, type SsrScoresResult } from "./ssr/score-answers.js";
import { VoyageProvider } from "./ssr/voyage-provider.js";
import type { RunResult } from "./types/run-result.js";

const program = new Command();

program
  .name("webtest")
  .description("Claude-powered website testing with SSR scoring")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize a webtest.config.json file")
  .action(() => {
    const configPath = join(process.cwd(), "webtest.config.json");

    if (existsSync(configPath)) {
      console.error("webtest.config.json already exists");
      process.exit(1);
    }

    const exampleConfig = {
      baseUrl: "https://example.com",
      allowedHosts: ["example.com"],
      scenarios: [
        {
          id: "login-flow",
          name: "User Login",
          goal: "Log in with valid credentials",
          successCriteria: "User sees dashboard after login",
        },
      ],
      personas: [
        {
          id: "casual-user",
          name: "Casual User",
          traits: ["impatient", "not tech-savvy", "easily frustrated"],
          demographics: {
            age: 35,
            techExperience: "low",
          },
        },
      ],
      evaluationQuestions: [
        {
          id: "ease",
          question: "How easy was it to complete the task?",
        },
        {
          id: "trust",
          question: "How trustworthy did this site feel?",
        },
      ],
      anchors: {
        ease: {
          1: "Extremely difficult, could not complete",
          2: "Difficult, required significant effort",
          3: "Moderately easy, some friction",
          4: "Easy, minor issues",
          5: "Very easy, effortless",
        },
        trust: {
          1: "Not trustworthy at all, suspicious",
          2: "Somewhat untrustworthy",
          3: "Neutral, neither trust nor distrust",
          4: "Somewhat trustworthy",
          5: "Very trustworthy, would share sensitive info",
        },
      },
    };

    writeFileSync(configPath, JSON.stringify(exampleConfig, null, 2) + "\n");
    console.log("Created webtest.config.json");
  });

interface RunOptions {
  scenario: string;
  persona: string;
  headless: boolean;
  saveBaseline?: string;
  ci: boolean;
}

async function executeRun(options: RunOptions): Promise<void> {
  const config = loadConfig();

  const scenario = config.scenarios.find((s) => s.id === options.scenario);
  if (!scenario) {
    console.error(`Scenario '${options.scenario}' not found in config`);
    process.exit(1);
  }

  const persona = config.personas.find((p) => p.id === options.persona);
  if (!persona) {
    console.error(`Persona '${options.persona}' not found in config`);
    process.exit(1);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(
    process.cwd(),
    "runs",
    `${timestamp}-${options.scenario}-${options.persona}`
  );

  mkdirSync(runDir, { recursive: true });

  const startTime = new Date();

  const metadata = {
    scenario: scenario,
    persona: persona,
    headless: options.headless,
    startTime: startTime.toISOString(),
    config: {
      baseUrl: config.baseUrl,
      allowedHosts: config.allowedHosts,
    },
  };

  writeFileSync(
    join(runDir, "metadata.json"),
    JSON.stringify(metadata, null, 2) + "\n"
  );

  console.log(`Run directory: ${runDir}`);
  console.log(`Scenario: ${scenario.name}`);
  console.log(`Persona: ${persona.name}`);
  console.log(`Headless: ${options.headless}`);
  console.log("");

  const tracePath = join(runDir, "trace.zip");
  const screenshotPaths: string[] = [];
  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];

  console.log("Launching browser...");
  const { context, page } = await createBrowserContext(options.headless);

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(`[${new Date().toISOString()}] ${msg.text()}`);
    }
  });

  page.on("pageerror", (error) => {
    consoleErrors.push(`[${new Date().toISOString()}] ${error.message}`);
  });

  page.on("requestfailed", (request) => {
    networkErrors.push(
      `[${new Date().toISOString()}] ${request.method()} ${request.url()} - ${request.failure()?.errorText}`
    );
  });

  await startTrace(context);

  console.log(`Navigating to ${config.baseUrl}...`);
  await page.goto(config.baseUrl);

  const initialScreenshot = join(runDir, "screenshot-initial.png");
  await captureScreenshot(page, initialScreenshot);
  screenshotPaths.push(initialScreenshot);

  console.log("Starting agent...");
  console.log("");

  let agentResult: AgentRunResult;
  try {
    agentResult = await runAgent({
      scenario,
      persona,
      config,
      page,
      context,
      tracePath,
      maxTurns: 50,
      evaluationQuestions: config.evaluationQuestions,
    });
  } catch (error) {
    console.error("Agent execution failed:", error);

    const finalScreenshot = join(runDir, "screenshot-error.png");
    try {
      await captureScreenshot(page, finalScreenshot);
      screenshotPaths.push(finalScreenshot);
    } catch {
      // Page may already be closed
    }

    agentResult = {
      success: false,
      messages: [],
      stepLog: [],
      finalMessage: null,
      freeTextAnswers: {},
      qualitativeFeedback: `Agent failed with error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const endTime = new Date();

  const finalScreenshot = join(runDir, "screenshot-final.png");
  try {
    await captureScreenshot(page, finalScreenshot);
    screenshotPaths.push(finalScreenshot);
  } catch {
    // Page may already be closed
  }

  const runResult: RunResult = {
    task: {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      goal: scenario.goal,
      successCriteria: scenario.successCriteria,
    },
    persona: {
      id: persona.id,
      name: persona.name,
      traits: persona.traits,
    },
    success: agentResult.success,
    failureReason: agentResult.success ? undefined : agentResult.qualitativeFeedback,
    steps: agentResult.stepLog,
    observations: [],
    freeTextAnswers: agentResult.freeTextAnswers,
    qualitativeFeedback: agentResult.qualitativeFeedback,
    riskFlags: [
      ...consoleErrors.length > 0 ? [`${consoleErrors.length} console errors`] : [],
      ...networkErrors.length > 0 ? [`${networkErrors.length} network failures`] : [],
    ],
    artifacts: {
      tracePath,
      screenshotPaths,
      runDir,
    },
    timing: {
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      durationMs: endTime.getTime() - startTime.getTime(),
    },
  };

  if (consoleErrors.length > 0) {
    writeFileSync(
      join(runDir, "console-errors.json"),
      JSON.stringify(consoleErrors, null, 2) + "\n"
    );
  }

  if (networkErrors.length > 0) {
    writeFileSync(
      join(runDir, "network-errors.json"),
      JSON.stringify(networkErrors, null, 2) + "\n"
    );
  }

  persistAllResults(runDir, runResult);

  console.log("");
  console.log(`Result: ${runResult.success ? "SUCCESS" : "FAILED"}`);
  console.log(`Steps: ${runResult.steps.length}`);
  console.log(`Duration: ${(runResult.timing.durationMs / 1000).toFixed(1)}s`);

  if (Object.keys(agentResult.freeTextAnswers).length > 0 && process.env.VOYAGE_API_KEY) {
    console.log("");
    console.log("Calculating SSR scores...");

    try {
      const provider = new VoyageProvider();
      const ssrScores = await scoreAllAnswers(agentResult.freeTextAnswers, provider);
      saveSsrScores(runDir, ssrScores);

      console.log(`  Average score: ${ssrScores.summary.averageExpectedScore.toFixed(2)}/5.00`);
      for (const [questionId, scoreData] of Object.entries(ssrScores.scores)) {
        console.log(`  ${questionId}: ${scoreData.expectedScore.toFixed(2)}/5.00`);
      }
    } catch (error) {
      console.error("SSR scoring failed:", error);
    }
  } else if (Object.keys(agentResult.freeTextAnswers).length > 0) {
    console.log("");
    console.log("Skipping SSR scoring (VOYAGE_API_KEY not set)");
  }

  if (options.saveBaseline) {
    const baselineDir = join(process.cwd(), "baselines", options.saveBaseline);
    mkdirSync(baselineDir, { recursive: true });
    cpSync(runDir, baselineDir, { recursive: true });
    console.log("");
    console.log(`Saved baseline to: ${baselineDir}`);
  }

  if (options.ci) {
    const ssrScoresPath = join(runDir, "ssr-scores.json");
    const thresholds = config.thresholds || {};

    const results: Array<{ name: string; passed: boolean; value: number; threshold: number }> = [];
    let allPassed = true;

    if (thresholds.minSuccessRate !== undefined) {
      const successRate = runResult.success ? 1 : 0;
      const passed = successRate >= thresholds.minSuccessRate;
      results.push({
        name: "Success Rate",
        passed,
        value: successRate,
        threshold: thresholds.minSuccessRate,
      });
      if (!passed) allPassed = false;
    }

    if (existsSync(ssrScoresPath)) {
      const ssrScores = JSON.parse(readFileSync(ssrScoresPath, "utf-8")) as SsrScoresResult;

      if (thresholds.minEaseScore !== undefined && ssrScores.scores.ease) {
        const passed = ssrScores.scores.ease.expectedScore >= thresholds.minEaseScore;
        results.push({
          name: "Ease Score",
          passed,
          value: ssrScores.scores.ease.expectedScore,
          threshold: thresholds.minEaseScore,
        });
        if (!passed) allPassed = false;
      }

      if (thresholds.minTrustScore !== undefined && ssrScores.scores.trust) {
        const passed = ssrScores.scores.trust.expectedScore >= thresholds.minTrustScore;
        results.push({
          name: "Trust Score",
          passed,
          value: ssrScores.scores.trust.expectedScore,
          threshold: thresholds.minTrustScore,
        });
        if (!passed) allPassed = false;
      }
    }

    console.log("");
    console.log("CI Threshold Results:");
    console.log("---------------------");
    for (const result of results) {
      const status = result.passed ? "PASS" : "FAIL";
      console.log(
        `  ${result.name}: ${result.value.toFixed(2)} (threshold: ${result.threshold}) - ${status}`
      );
    }

    if (results.length === 0) {
      console.log("  No thresholds configured");
    }

    console.log("");
    console.log(`Overall: ${allPassed ? "PASS" : "FAIL"}`);

    if (!allPassed) {
      process.exit(1);
    }
  }
}

program
  .command("run")
  .description("Run a test scenario with a persona")
  .requiredOption("--scenario <id>", "Scenario ID to run")
  .requiredOption("--persona <id>", "Persona ID to use")
  .option("--headless", "Run in headless mode", false)
  .option("--save-baseline <name>", "Save results as baseline with given name")
  .option("--ci", "CI mode: exit with code based on thresholds", false)
  .action((options: RunOptions) => {
    executeRun(options).catch((error) => {
      console.error("Run failed:", error);
      process.exit(1);
    });
  });

interface CompareOptions {
  baseline: string;
  candidate: string;
}

program
  .command("compare")
  .description("Compare a run against a baseline")
  .requiredOption("--baseline <name>", "Baseline name to compare against")
  .requiredOption("--candidate <run-id>", "Run ID to compare")
  .action((options: CompareOptions) => {
    const baselineDir = join(process.cwd(), "baselines", options.baseline);
    const candidateDir = join(process.cwd(), "runs", options.candidate);

    if (!existsSync(baselineDir)) {
      console.error(`Baseline '${options.baseline}' not found at ${baselineDir}`);
      process.exit(1);
    }

    if (!existsSync(candidateDir)) {
      console.error(`Candidate run '${options.candidate}' not found at ${candidateDir}`);
      process.exit(1);
    }

    const baselineScoresPath = join(baselineDir, "ssr-scores.json");
    const candidateScoresPath = join(candidateDir, "ssr-scores.json");

    if (!existsSync(baselineScoresPath)) {
      console.error(`No SSR scores found in baseline at ${baselineScoresPath}`);
      process.exit(1);
    }

    if (!existsSync(candidateScoresPath)) {
      console.error(`No SSR scores found in candidate at ${candidateScoresPath}`);
      process.exit(1);
    }

    const baselineScores = JSON.parse(
      readFileSync(baselineScoresPath, "utf-8")
    ) as SsrScoresResult;
    const candidateScores = JSON.parse(
      readFileSync(candidateScoresPath, "utf-8")
    ) as SsrScoresResult;

    const deltas: Record<
      string,
      {
        baselineScore: number;
        candidateScore: number;
        delta: number;
        percentChange: number;
      }
    > = {};

    const allQuestions = new Set([
      ...Object.keys(baselineScores.scores),
      ...Object.keys(candidateScores.scores),
    ]);

    for (const questionId of allQuestions) {
      const baselineScore = baselineScores.scores[questionId]?.expectedScore ?? 0;
      const candidateScore = candidateScores.scores[questionId]?.expectedScore ?? 0;
      const delta = candidateScore - baselineScore;
      const percentChange =
        baselineScore !== 0 ? (delta / baselineScore) * 100 : 0;

      deltas[questionId] = {
        baselineScore,
        candidateScore,
        delta,
        percentChange,
      };
    }

    const summaryDelta =
      candidateScores.summary.averageExpectedScore -
      baselineScores.summary.averageExpectedScore;

    const comparison = {
      baseline: options.baseline,
      candidate: options.candidate,
      timestamp: new Date().toISOString(),
      deltas,
      summary: {
        baselineAverage: baselineScores.summary.averageExpectedScore,
        candidateAverage: candidateScores.summary.averageExpectedScore,
        overallDelta: summaryDelta,
        percentChange:
          baselineScores.summary.averageExpectedScore !== 0
            ? (summaryDelta / baselineScores.summary.averageExpectedScore) * 100
            : 0,
      },
    };

    const comparisonPath = join(candidateDir, "comparison.json");
    writeFileSync(comparisonPath, JSON.stringify(comparison, null, 2) + "\n");

    console.log(`Comparison saved to: ${comparisonPath}`);
    console.log("");
    console.log("Score Deltas:");
    for (const [questionId, data] of Object.entries(deltas)) {
      const sign = data.delta >= 0 ? "+" : "";
      console.log(
        `  ${questionId}: ${data.baselineScore.toFixed(2)} → ${data.candidateScore.toFixed(2)} (${sign}${data.delta.toFixed(2)})`
      );
    }
    console.log("");
    console.log(
      `Overall: ${comparison.summary.baselineAverage.toFixed(2)} → ${comparison.summary.candidateAverage.toFixed(2)} (${summaryDelta >= 0 ? "+" : ""}${summaryDelta.toFixed(2)})`
    );
  });

interface ReportOptions {
  latest: boolean;
  run?: string;
}

function findLatestRun(): string | null {
  const runsDir = join(process.cwd(), "runs");
  if (!existsSync(runsDir)) return null;

  const runs = readdirSync(runsDir)
    .filter((name) => {
      const runPath = join(runsDir, name);
      return existsSync(join(runPath, "run-result.json"));
    })
    .sort()
    .reverse();

  return runs[0] || null;
}

function createDistributionBar(distribution: number[]): string {
  const barWidth = 20;
  const chars = ["1", "2", "3", "4", "5"];
  let bar = "";

  for (let i = 0; i < 5; i++) {
    const width = Math.round(distribution[i] * barWidth);
    bar += chars[i].repeat(width);
  }

  const totalWidth = bar.length;
  if (totalWidth < barWidth) {
    bar += " ".repeat(barWidth - totalWidth);
  }

  return `[${bar.slice(0, barWidth)}]`;
}

program
  .command("report")
  .description("View a run report")
  .option("--latest", "Show the latest run report", false)
  .option("--run <id>", "Run ID to show")
  .action((options: ReportOptions) => {
    let runId: string | null = null;

    if (options.latest) {
      runId = findLatestRun();
      if (!runId) {
        console.error("No runs found");
        process.exit(1);
      }
    } else if (options.run) {
      runId = options.run;
    } else {
      console.error("Please specify --latest or --run <id>");
      process.exit(1);
    }

    const runDir = join(process.cwd(), "runs", runId);

    if (!existsSync(runDir)) {
      console.error(`Run '${runId}' not found at ${runDir}`);
      process.exit(1);
    }

    const reportPath = join(runDir, "report.md");
    const ssrScoresPath = join(runDir, "ssr-scores.json");
    const runResultPath = join(runDir, "run-result.json");

    const lines: string[] = [];

    if (existsSync(reportPath)) {
      const report = readFileSync(reportPath, "utf-8");
      lines.push(report);
    } else if (existsSync(runResultPath)) {
      const result = JSON.parse(readFileSync(runResultPath, "utf-8")) as RunResult;
      lines.push(`# Test Run Report`);
      lines.push("");
      lines.push(`**Run ID:** ${basename(runDir)}`);
      lines.push(`**Status:** ${result.success ? "PASSED" : "FAILED"}`);
      lines.push("");
    } else {
      console.error(`No report or result found in ${runDir}`);
      process.exit(1);
    }

    if (existsSync(ssrScoresPath)) {
      const ssrScores = JSON.parse(readFileSync(ssrScoresPath, "utf-8")) as SsrScoresResult;

      lines.push("");
      lines.push("## SSR Scores");
      lines.push("");

      for (const [questionId, scoreData] of Object.entries(ssrScores.scores)) {
        const bar = createDistributionBar(scoreData.distribution);
        const expected = scoreData.expectedScore.toFixed(2);
        const entropy = scoreData.entropy.toFixed(2);

        lines.push(`### ${questionId}`);
        lines.push("");
        lines.push(`**Expected Score:** ${expected} / 5.00`);
        lines.push(`**Entropy:** ${entropy}`);
        lines.push(`**Distribution:** ${bar}`);
        lines.push("");
        lines.push(`> "${scoreData.answer.slice(0, 200)}${scoreData.answer.length > 200 ? "..." : ""}"`);
        lines.push("");
      }

      lines.push("### Summary");
      lines.push("");
      lines.push(`- **Average Expected Score:** ${ssrScores.summary.averageExpectedScore.toFixed(2)}`);
      lines.push(`- **Average Entropy:** ${ssrScores.summary.averageEntropy.toFixed(2)}`);
      lines.push(`- **Questions Scored:** ${ssrScores.summary.questionCount}`);
      lines.push("");
    }

    let config;
    try {
      config = loadConfig();
    } catch {
      config = null;
    }

    if (config?.thresholds && existsSync(ssrScoresPath)) {
      const ssrScores = JSON.parse(readFileSync(ssrScoresPath, "utf-8")) as SsrScoresResult;
      const thresholds = config.thresholds;

      lines.push("## Threshold Results");
      lines.push("");

      if (thresholds.minEaseScore !== undefined && ssrScores.scores.ease) {
        const passed = ssrScores.scores.ease.expectedScore >= thresholds.minEaseScore;
        lines.push(`- **Ease Score:** ${ssrScores.scores.ease.expectedScore.toFixed(2)} >= ${thresholds.minEaseScore} - ${passed ? "PASS" : "FAIL"}`);
      }

      if (thresholds.minTrustScore !== undefined && ssrScores.scores.trust) {
        const passed = ssrScores.scores.trust.expectedScore >= thresholds.minTrustScore;
        lines.push(`- **Trust Score:** ${ssrScores.scores.trust.expectedScore.toFixed(2)} >= ${thresholds.minTrustScore} - ${passed ? "PASS" : "FAIL"}`);
      }

      lines.push("");
    }

    console.log(lines.join("\n"));
  });

interface GeneratePersonasOptions {
  count: number;
  audience: string;
  update: boolean;
}

async function generatePersonas(options: GeneratePersonasOptions): Promise<void> {
  const client = new Anthropic();

  const prompt = `Generate ${options.count} realistic user personas for usability testing of a website.

Target audience: ${options.audience}

For each persona, provide:
1. A unique lowercase kebab-case ID (e.g., "busy-parent", "tech-savvy-millennial")
2. A descriptive name (e.g., "Busy Working Parent", "Tech-Savvy Millennial")
3. 3-5 behavioral traits that affect how they interact with websites (e.g., "impatient", "skims content", "detail-oriented")
4. Demographics object with relevant characteristics (e.g., age range, tech experience level, any relevant context)

The personas should:
- Be diverse and represent different user segments within the target audience
- Have distinct behavioral patterns that will produce different test results
- Include both tech-savvy and less technical users if appropriate for the audience
- Feel realistic and based on real user archetypes

Respond with a JSON array of personas in this exact format:
[
  {
    "id": "persona-id",
    "name": "Persona Name",
    "traits": ["trait1", "trait2", "trait3"],
    "demographics": {
      "ageRange": "25-35",
      "techExperience": "high",
      "otherRelevantKey": "value"
    }
  }
]

Only output the JSON array, no other text.`;

  console.error(`Generating ${options.count} personas for: ${options.audience}...`);

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const textContent = response.content.find((c) => c.type === "text");
  if (!textContent || textContent.type !== "text") {
    console.error("Failed to generate personas: no text response");
    process.exit(1);
  }

  let personas: Persona[];
  try {
    const jsonMatch = textContent.text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error("No JSON array found in response");
    }
    personas = JSON.parse(jsonMatch[0]) as Persona[];
  } catch (error) {
    console.error("Failed to parse personas JSON:", error);
    console.error("Raw response:", textContent.text);
    process.exit(1);
  }

  if (options.update) {
    const configPath = join(process.cwd(), "webtest.config.json");
    if (!existsSync(configPath)) {
      console.error("No webtest.config.json found. Run 'webtest init' first.");
      process.exit(1);
    }

    const config = JSON.parse(readFileSync(configPath, "utf-8"));

    const existingIds = new Set(config.personas?.map((p: Persona) => p.id) || []);
    const newPersonas = personas.filter((p) => !existingIds.has(p.id));

    if (newPersonas.length < personas.length) {
      console.error(`Skipping ${personas.length - newPersonas.length} personas with duplicate IDs`);
    }

    config.personas = [...(config.personas || []), ...newPersonas];
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    console.error(`Added ${newPersonas.length} personas to webtest.config.json`);
  }

  console.log(JSON.stringify(personas, null, 2));
}

program
  .command("generate-personas")
  .description("Generate user personas using Claude")
  .requiredOption("--audience <description>", "Description of target audience (e.g., \"e-commerce shoppers aged 25-45\")")
  .option("--count <number>", "Number of personas to generate", "3")
  .option("--update", "Add generated personas to webtest.config.json", false)
  .action((options: { audience: string; count: string; update: boolean }) => {
    generatePersonas({
      audience: options.audience,
      count: parseInt(options.count, 10),
      update: options.update,
    }).catch((error) => {
      console.error("Generation failed:", error);
      process.exit(1);
    });
  });

interface ExplainOptions {
  run?: string;
  latest: boolean;
  screenshots: boolean;
  question?: string;
}

async function explainRun(options: ExplainOptions): Promise<void> {
  let runId: string | null = null;

  if (options.latest) {
    runId = findLatestRun();
    if (!runId) {
      console.error("No runs found");
      process.exit(1);
    }
  } else if (options.run) {
    runId = options.run;
  } else {
    console.error("Please specify --latest or --run <id>");
    process.exit(1);
  }

  const runDir = join(process.cwd(), "runs", runId);

  if (!existsSync(runDir)) {
    console.error(`Run '${runId}' not found at ${runDir}`);
    process.exit(1);
  }

  const runResultPath = join(runDir, "run-result.json");
  const stepLogPath = join(runDir, "step-log.json");
  const ssrScoresPath = join(runDir, "ssr-scores.json");
  const consoleErrorsPath = join(runDir, "console-errors.json");
  const networkErrorsPath = join(runDir, "network-errors.json");

  if (!existsSync(runResultPath)) {
    console.error(`No run-result.json found in ${runDir}`);
    process.exit(1);
  }

  const runResult = JSON.parse(readFileSync(runResultPath, "utf-8")) as RunResult;
  const stepLog = existsSync(stepLogPath)
    ? JSON.parse(readFileSync(stepLogPath, "utf-8"))
    : [];
  const ssrScores = existsSync(ssrScoresPath)
    ? JSON.parse(readFileSync(ssrScoresPath, "utf-8"))
    : null;
  const consoleErrors = existsSync(consoleErrorsPath)
    ? JSON.parse(readFileSync(consoleErrorsPath, "utf-8"))
    : [];
  const networkErrors = existsSync(networkErrorsPath)
    ? JSON.parse(readFileSync(networkErrorsPath, "utf-8"))
    : [];

  const contentParts: Anthropic.MessageParam["content"] = [];

  const contextText = `# Run Analysis Request

## Run Information
- **Run ID:** ${runId}
- **Scenario:** ${runResult.task.scenarioName} (${runResult.task.scenarioId})
- **Goal:** ${runResult.task.goal}
- **Success Criteria:** ${runResult.task.successCriteria}
- **Persona:** ${runResult.persona.name} (traits: ${runResult.persona.traits.join(", ")})
- **Result:** ${runResult.success ? "SUCCESS" : "FAILED"}
- **Duration:** ${(runResult.timing.durationMs / 1000).toFixed(1)}s

## Step Log (${stepLog.length} steps)
${JSON.stringify(stepLog, null, 2)}

## Risk Flags
${runResult.riskFlags.length > 0 ? runResult.riskFlags.map((f: string) => `- ${f}`).join("\n") : "None"}

## Console Errors (${consoleErrors.length})
${consoleErrors.length > 0 ? JSON.stringify(consoleErrors, null, 2) : "None"}

## Network Errors (${networkErrors.length})
${networkErrors.length > 0 ? JSON.stringify(networkErrors, null, 2) : "None"}

## Qualitative Feedback
${runResult.qualitativeFeedback || "None provided"}

## Free-Text Answers
${Object.entries(runResult.freeTextAnswers || {})
  .map(([q, a]) => `**${q}:** ${a}`)
  .join("\n\n") || "None"}

${ssrScores ? `## SSR Scores
${Object.entries(ssrScores.scores)
  .map(([q, data]: [string, unknown]) => {
    const scoreData = data as { expectedScore: number; entropy: number };
    return `- **${q}:** ${scoreData.expectedScore.toFixed(2)}/5.00 (entropy: ${scoreData.entropy.toFixed(2)})`;
  })
  .join("\n")}
- **Average:** ${ssrScores.summary.averageExpectedScore.toFixed(2)}/5.00` : ""}`;

  contentParts.push({ type: "text", text: contextText });

  if (options.screenshots) {
    const screenshotFiles = ["screenshot-initial.png", "screenshot-final.png", "screenshot-error.png"];
    for (const filename of screenshotFiles) {
      const screenshotPath = join(runDir, filename);
      if (existsSync(screenshotPath)) {
        const imageData = readFileSync(screenshotPath);
        const base64 = imageData.toString("base64");
        contentParts.push({
          type: "text",
          text: `\n## Screenshot: ${filename}\n`,
        });
        contentParts.push({
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: base64,
          },
        });
      }
    }
  }

  const userQuestion = options.question || (runResult.success
    ? "This run succeeded. Please analyze what went well and identify any potential UX issues or areas for improvement that the persona might have experienced."
    : "This run failed. Please explain why it failed, what went wrong, and suggest specific improvements to fix the issues.");

  contentParts.push({
    type: "text",
    text: `\n---\n\n**Question:** ${userQuestion}`,
  });

  console.error(`Analyzing run ${runId}...`);
  if (options.screenshots) {
    console.error("(including screenshots for visual analysis)");
  }
  console.error("");

  const client = new Anthropic();

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: `You are a UX analyst reviewing synthetic usability test runs. You analyze test logs, errors, and screenshots to provide actionable insights about website usability issues.

Your analysis should:
1. Identify the root cause of any failures
2. Explain what the synthetic user experienced from their persona's perspective
3. Highlight specific UX problems (confusing UI, missing feedback, broken flows, etc.)
4. Suggest concrete improvements
5. Note any concerning patterns (errors, slow responses, accessibility issues)

Be specific and reference actual steps from the log. If screenshots are provided, describe what you see and how it relates to the issues.`,
    messages: [
      {
        role: "user",
        content: contentParts,
      },
    ],
  });

  const textContent = response.content.find((c) => c.type === "text");
  if (textContent && textContent.type === "text") {
    console.log(textContent.text);
  }
}

program
  .command("explain")
  .description("Get Claude's analysis of why a run succeeded or failed")
  .option("--run <id>", "Run ID to analyze")
  .option("--latest", "Analyze the latest run", false)
  .option("--screenshots", "Include screenshots in analysis (uses vision)", false)
  .option("--question <text>", "Specific question to ask about the run")
  .action((options: ExplainOptions) => {
    explainRun(options).catch((error) => {
      console.error("Explain failed:", error);
      process.exit(1);
    });
  });

program.parse();
