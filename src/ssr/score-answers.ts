import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EmbeddingProvider } from "./embedding-provider.js";
import { SsrScorer, type ScoreResult } from "./scorer.js";

export interface SsrScoresResult {
  scores: {
    [questionId: string]: ScoreResult & {
      answer: string;
    };
  };
  summary: {
    averageExpectedScore: number;
    averageEntropy: number;
    questionCount: number;
  };
}

export async function scoreAllAnswers(
  freeTextAnswers: Record<string, string>,
  provider: EmbeddingProvider,
  questionTypeMapping?: Record<string, string>
): Promise<SsrScoresResult> {
  const scorer = new SsrScorer({ provider });

  const scores: SsrScoresResult["scores"] = {};

  const entries = Object.entries(freeTextAnswers);
  let totalExpectedScore = 0;
  let totalEntropy = 0;

  for (const [questionId, answer] of entries) {
    const questionType = questionTypeMapping?.[questionId] ?? questionId;

    try {
      const result = await scorer.scoreAnswer(questionType, answer);
      scores[questionId] = {
        ...result,
        answer,
      };
      totalExpectedScore += result.expectedScore;
      totalEntropy += result.entropy;
    } catch (error) {
      console.warn(
        `Warning: Could not score question '${questionId}': ${error}`
      );
    }
  }

  const scoredCount = Object.keys(scores).length;

  return {
    scores,
    summary: {
      averageExpectedScore: scoredCount > 0 ? totalExpectedScore / scoredCount : 0,
      averageEntropy: scoredCount > 0 ? totalEntropy / scoredCount : 0,
      questionCount: scoredCount,
    },
  };
}

export function saveSsrScores(runDir: string, scores: SsrScoresResult): void {
  const scoresPath = join(runDir, "ssr-scores.json");
  writeFileSync(scoresPath, JSON.stringify(scores, null, 2) + "\n");
}
