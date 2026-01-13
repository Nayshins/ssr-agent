import type { EmbeddingProvider } from "./embedding-provider.js";

export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) {
    throw new Error("Vectors must have the same length");
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

export function similarityToPmf(
  similarities: number[],
  options?: { epsilon?: number; temperature?: number }
): number[] {
  const epsilon = options?.epsilon ?? 1e-8;
  const temperature = options?.temperature ?? 1.0;

  const scaledSims = similarities.map((s) => s / temperature);

  const maxSim = Math.max(...scaledSims);
  const expSims = scaledSims.map((s) => Math.exp(s - maxSim));

  const sum = expSims.reduce((a, b) => a + b, 0) + epsilon * similarities.length;
  const pmf = expSims.map((e) => (e + epsilon) / sum);

  const pmfSum = pmf.reduce((a, b) => a + b, 0);
  return pmf.map((p) => p / pmfSum);
}

export type AnchorSet = {
  [level: number]: string;
};

export const DEFAULT_ANCHOR_SETS: { [questionType: string]: AnchorSet[] } = {
  ease: [
    {
      1: "This was extremely difficult. I could not complete the task at all.",
      2: "This was quite difficult. I struggled significantly to make progress.",
      3: "This was moderately easy. I encountered some friction but got through.",
      4: "This was fairly easy. I had only minor issues.",
      5: "This was very easy. I completed the task effortlessly.",
    },
    {
      1: "Impossible to use. The interface was completely confusing.",
      2: "Very hard to figure out. I got stuck multiple times.",
      3: "Somewhat straightforward. A few confusing moments.",
      4: "Pretty intuitive. Found my way without much trouble.",
      5: "Extremely intuitive. Everything was exactly where I expected.",
    },
    {
      1: "I gave up. This was too frustrating to continue.",
      2: "I almost gave up. Required significant effort to persist.",
      3: "I managed, but it took some effort to figure things out.",
      4: "Mostly smooth experience with minor hiccups.",
      5: "Completely smooth. No obstacles whatsoever.",
    },
    {
      1: "The worst user experience I've ever had.",
      2: "A poor user experience with many problems.",
      3: "An average user experience, neither great nor terrible.",
      4: "A good user experience with room for improvement.",
      5: "An excellent user experience, very well designed.",
    },
    {
      1: "I would never recommend this to anyone.",
      2: "I would warn others about the difficulty.",
      3: "I might mention it's a bit tricky to use.",
      4: "I would say it's pretty easy to use.",
      5: "I would highly recommend it for its ease of use.",
    },
    {
      1: "Completely failed to accomplish what I wanted.",
      2: "Barely accomplished my goal after much struggle.",
      3: "Accomplished my goal with moderate effort.",
      4: "Accomplished my goal fairly efficiently.",
      5: "Accomplished my goal quickly and easily.",
    },
  ],
  trust: [
    {
      1: "I don't trust this site at all. It feels suspicious and unsafe.",
      2: "I have significant concerns about this site's trustworthiness.",
      3: "I'm neutral. The site seems neither trustworthy nor untrustworthy.",
      4: "I mostly trust this site. It appears legitimate.",
      5: "I completely trust this site. I would share sensitive information.",
    },
    {
      1: "This site looks like a scam. I would never enter my information.",
      2: "This site feels unprofessional and raises red flags.",
      3: "This site seems okay but I'm not fully confident.",
      4: "This site looks professional and reliable.",
      5: "This site is clearly trustworthy and secure.",
    },
    {
      1: "I feel very unsafe using this website.",
      2: "I feel somewhat uneasy about security on this site.",
      3: "I don't have strong feelings about security either way.",
      4: "I feel reasonably secure using this site.",
      5: "I feel completely safe and secure on this website.",
    },
    {
      1: "I would never give my credit card to this site.",
      2: "I would be very hesitant to make a purchase here.",
      3: "I might consider a purchase but with caution.",
      4: "I would be comfortable making a purchase.",
      5: "I would have no hesitation buying from this site.",
    },
    {
      1: "This site seems designed to deceive users.",
      2: "This site has some deceptive or dark patterns.",
      3: "This site is fairly straightforward in its presentation.",
      4: "This site is transparent and honest in its design.",
      5: "This site is exemplary in its honesty and transparency.",
    },
    {
      1: "I feel this site is actively trying to harm users.",
      2: "I feel this site doesn't have users' best interests at heart.",
      3: "I feel this site is indifferent to user wellbeing.",
      4: "I feel this site cares about its users.",
      5: "I feel this site genuinely prioritizes user wellbeing.",
    },
  ],
};

export interface SsrScorerOptions {
  provider: EmbeddingProvider;
  anchorSets?: { [questionType: string]: AnchorSet[] };
  epsilon?: number;
  temperature?: number;
}

export interface ScoreResult {
  distribution: number[];
  expectedScore: number;
  entropy: number;
  anchorSetCount: number;
}

export class SsrScorer {
  private provider: EmbeddingProvider;
  private anchorSets: { [questionType: string]: AnchorSet[] };
  private epsilon: number;
  private temperature: number;
  private anchorEmbeddingsCache: Map<string, number[][]>;

  constructor(options: SsrScorerOptions) {
    this.provider = options.provider;
    this.anchorSets = options.anchorSets ?? DEFAULT_ANCHOR_SETS;
    this.epsilon = options.epsilon ?? 1e-8;
    this.temperature = options.temperature ?? 1.0;
    this.anchorEmbeddingsCache = new Map();
  }

  private async getAnchorEmbeddings(
    questionType: string,
    anchorSetIndex: number
  ): Promise<number[][]> {
    const cacheKey = `${questionType}:${anchorSetIndex}`;
    const cached = this.anchorEmbeddingsCache.get(cacheKey);
    if (cached) return cached;

    const anchorSet = this.anchorSets[questionType]?.[anchorSetIndex];
    if (!anchorSet) {
      throw new Error(
        `No anchor set found for ${questionType} at index ${anchorSetIndex}`
      );
    }

    const anchors = [1, 2, 3, 4, 5].map((level) => anchorSet[level]);
    const embeddings = await this.provider.embed(anchors);

    this.anchorEmbeddingsCache.set(cacheKey, embeddings);
    return embeddings;
  }

  async scoreAnswer(
    questionType: string,
    freeTextAnswer: string
  ): Promise<ScoreResult> {
    const sets = this.anchorSets[questionType];
    if (!sets || sets.length === 0) {
      throw new Error(`No anchor sets defined for question type: ${questionType}`);
    }

    const [answerEmbedding] = await this.provider.embed([freeTextAnswer]);

    const distributions: number[][] = [];

    for (let i = 0; i < sets.length; i++) {
      const anchorEmbeddings = await this.getAnchorEmbeddings(questionType, i);

      const similarities = anchorEmbeddings.map((anchor) =>
        cosineSimilarity(answerEmbedding, anchor)
      );

      const pmf = similarityToPmf(similarities, {
        epsilon: this.epsilon,
        temperature: this.temperature,
      });

      distributions.push(pmf);
    }

    const avgDistribution = [0, 0, 0, 0, 0];
    for (const dist of distributions) {
      for (let i = 0; i < 5; i++) {
        avgDistribution[i] += dist[i] / distributions.length;
      }
    }

    const expectedScore = avgDistribution.reduce(
      (sum, prob, i) => sum + prob * (i + 1),
      0
    );

    const entropy = avgDistribution.reduce((sum, prob) => {
      if (prob > 0) {
        return sum - prob * Math.log2(prob);
      }
      return sum;
    }, 0);

    return {
      distribution: avgDistribution,
      expectedScore,
      entropy,
      anchorSetCount: sets.length,
    };
  }

  clearCache(): void {
    this.anchorEmbeddingsCache.clear();
  }
}
