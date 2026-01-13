import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunResult, Step } from "../types/run-result.js";

export function saveRunResult(runDir: string, result: RunResult): void {
  const resultPath = join(runDir, "run-result.json");
  writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
}

export function saveStepLog(runDir: string, steps: Step[]): void {
  const stepLogPath = join(runDir, "step-log.json");
  writeFileSync(stepLogPath, JSON.stringify(steps, null, 2) + "\n");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

export function generateReport(result: RunResult): string {
  const lines: string[] = [];

  lines.push(`# Test Run Report`);
  lines.push("");
  lines.push(`## Summary`);
  lines.push("");
  lines.push(`| Field | Value |`);
  lines.push(`|-------|-------|`);
  lines.push(`| **Status** | ${result.success ? "PASSED" : "FAILED"} |`);
  lines.push(`| **Scenario** | ${result.task.scenarioName} |`);
  lines.push(`| **Persona** | ${result.persona.name} |`);
  lines.push(`| **Duration** | ${formatDuration(result.timing.durationMs)} |`);
  lines.push(`| **Steps** | ${result.steps.length} |`);
  lines.push("");

  if (!result.success && result.failureReason) {
    lines.push(`## Failure Reason`);
    lines.push("");
    lines.push(`> ${result.failureReason}`);
    lines.push("");
  }

  lines.push(`## Task Details`);
  lines.push("");
  lines.push(`**Goal:** ${result.task.goal}`);
  lines.push("");
  lines.push(`**Success Criteria:** ${result.task.successCriteria}`);
  lines.push("");

  lines.push(`## Persona`);
  lines.push("");
  lines.push(`**Name:** ${result.persona.name}`);
  lines.push("");
  lines.push(`**Traits:** ${result.persona.traits.join(", ")}`);
  lines.push("");

  lines.push(`## Steps`);
  lines.push("");
  if (result.steps.length === 0) {
    lines.push("_No steps recorded_");
  } else {
    lines.push(`| # | Action | Target | Outcome |`);
    lines.push(`|---|--------|--------|---------|`);
    result.steps.forEach((step, i) => {
      const target = step.target ? `\`${step.target.slice(0, 40)}${step.target.length > 40 ? "..." : ""}\`` : "-";
      const outcome = step.outcome.slice(0, 30);
      lines.push(`| ${i + 1} | ${step.action} | ${target} | ${outcome} |`);
    });
  }
  lines.push("");

  const errors = result.steps.filter((s) => s.outcome.startsWith("error"));
  if (errors.length > 0) {
    lines.push(`## Errors`);
    lines.push("");
    errors.forEach((error) => {
      lines.push(`- **${error.action}** (${error.target || "no target"}): ${error.outcome}`);
    });
    lines.push("");
  }

  if (result.riskFlags.length > 0) {
    lines.push(`## Risk Flags`);
    lines.push("");
    result.riskFlags.forEach((flag) => {
      lines.push(`- ${flag}`);
    });
    lines.push("");
  }

  if (result.qualitativeFeedback) {
    lines.push(`## Qualitative Feedback`);
    lines.push("");
    lines.push(result.qualitativeFeedback);
    lines.push("");
  }

  const answers = Object.entries(result.freeTextAnswers);
  if (answers.length > 0) {
    lines.push(`## Evaluation Answers`);
    lines.push("");
    answers.forEach(([question, answer]) => {
      lines.push(`### ${question}`);
      lines.push("");
      lines.push(answer);
      lines.push("");
    });
  }

  lines.push(`## Artifacts`);
  lines.push("");
  lines.push(`- **Run Directory:** \`${result.artifacts.runDir}\``);
  if (result.artifacts.tracePath) {
    lines.push(`- **Trace:** \`${result.artifacts.tracePath}\``);
  }
  if (result.artifacts.screenshotPaths.length > 0) {
    lines.push(`- **Screenshots:**`);
    result.artifacts.screenshotPaths.forEach((path) => {
      lines.push(`  - \`${path}\``);
    });
  }
  lines.push("");

  lines.push(`## Timing`);
  lines.push("");
  lines.push(`- **Start:** ${result.timing.startTime}`);
  lines.push(`- **End:** ${result.timing.endTime}`);
  lines.push(`- **Duration:** ${formatDuration(result.timing.durationMs)}`);
  lines.push("");

  return lines.join("\n");
}

export function saveReport(runDir: string, result: RunResult): void {
  const report = generateReport(result);
  const reportPath = join(runDir, "report.md");
  writeFileSync(reportPath, report);
}

export function persistAllResults(runDir: string, result: RunResult): void {
  saveRunResult(runDir, result);
  saveStepLog(runDir, result.steps);
  saveReport(runDir, result);
}
