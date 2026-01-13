import { z } from "zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const ScenarioSchema = z.object({
  id: z.string(),
  name: z.string(),
  goal: z.string(),
  successCriteria: z.string(),
});

export const PersonaSchema = z.object({
  id: z.string(),
  name: z.string(),
  traits: z.array(z.string()),
  demographics: z.record(z.unknown()).optional(),
});

export const EvaluationQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
});

export const AnchorSetSchema = z.record(z.string());

export const ConfigSchema = z.object({
  baseUrl: z.string().url(),
  allowedHosts: z.array(z.string()),
  scenarios: z.array(ScenarioSchema),
  personas: z.array(PersonaSchema),
  evaluationQuestions: z.array(EvaluationQuestionSchema),
  anchors: z.record(AnchorSetSchema),
  thresholds: z
    .object({
      minSuccessRate: z.number().optional(),
      minTrustScore: z.number().optional(),
      minEaseScore: z.number().optional(),
    })
    .optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;
export type Persona = z.infer<typeof PersonaSchema>;
export type EvaluationQuestion = z.infer<typeof EvaluationQuestionSchema>;

export function loadConfig(configPath?: string): Config {
  const path = configPath ?? join(process.cwd(), "webtest.config.json");

  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch (error) {
    throw new Error(`Could not read config file at ${path}: ${error}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid JSON in config file: ${error}`);
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid config:\n${issues}`);
  }

  return result.data;
}
