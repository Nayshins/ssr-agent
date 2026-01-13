import { z } from "zod";

export const StepSchema = z.object({
  action: z.string(),
  target: z.string().optional(),
  value: z.string().optional(),
  outcome: z.string(),
  url: z.string(),
  timestamp: z.string(),
});

export const ObservationSchema = z.object({
  url: z.string(),
  title: z.string(),
  timestamp: z.string(),
  elementCount: z.number(),
  visibleTextLength: z.number(),
});

export const RunResultSchema = z.object({
  task: z.object({
    scenarioId: z.string(),
    scenarioName: z.string(),
    goal: z.string(),
    successCriteria: z.string(),
  }),
  persona: z.object({
    id: z.string(),
    name: z.string(),
    traits: z.array(z.string()),
  }),
  success: z.boolean(),
  failureReason: z.string().optional(),
  steps: z.array(StepSchema),
  observations: z.array(ObservationSchema),
  freeTextAnswers: z.record(z.string()),
  qualitativeFeedback: z.string().optional(),
  riskFlags: z.array(z.string()),
  artifacts: z.object({
    tracePath: z.string().optional(),
    screenshotPaths: z.array(z.string()),
    runDir: z.string(),
  }),
  timing: z.object({
    startTime: z.string(),
    endTime: z.string(),
    durationMs: z.number(),
  }),
});

export type Step = z.infer<typeof StepSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type RunResult = z.infer<typeof RunResultSchema>;

export const AgentOutputSchema = z.object({
  taskCompleted: z.boolean(),
  failureReason: z.string().optional(),
  qualitativeFeedback: z.string().optional(),
  riskFlags: z.array(z.string()),
  freeTextAnswers: z.record(z.string()),
});

export type AgentOutput = z.infer<typeof AgentOutputSchema>;
