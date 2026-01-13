import type { EmbeddingProvider } from "./embedding-provider.js";

interface VoyageEmbeddingResponse {
  object: string;
  data: Array<{
    object: string;
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage: {
    total_tokens: number;
  };
}

export class VoyageProvider implements EmbeddingProvider {
  private apiKey: string;
  private model: string;
  private cache: Map<string, number[]>;
  private baseUrl: string;

  constructor(options?: { apiKey?: string; model?: string }) {
    const apiKey = options?.apiKey ?? process.env.VOYAGE_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Voyage API key required. Set VOYAGE_API_KEY environment variable or pass apiKey option."
      );
    }
    this.apiKey = apiKey;
    this.model = options?.model ?? "voyage-3-lite";
    this.cache = new Map();
    this.baseUrl = "https://api.voyageai.com/v1";
  }

  async embed(texts: string[]): Promise<number[][]> {
    const results: (number[] | null)[] = new Array(texts.length).fill(null);
    const uncachedTexts: string[] = [];
    const uncachedIndices: number[] = [];

    for (let i = 0; i < texts.length; i++) {
      const cached = this.cache.get(texts[i]);
      if (cached) {
        results[i] = cached;
      } else {
        uncachedTexts.push(texts[i]);
        uncachedIndices.push(i);
      }
    }

    if (uncachedTexts.length > 0) {
      const embeddings = await this.fetchEmbeddings(uncachedTexts);

      for (let i = 0; i < uncachedTexts.length; i++) {
        const text = uncachedTexts[i];
        const embedding = embeddings[i];
        this.cache.set(text, embedding);
        results[uncachedIndices[i]] = embedding;
      }
    }

    return results as number[][];
  }

  private async fetchEmbeddings(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        input_type: "document",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Voyage API error (${response.status}): ${errorText}`
      );
    }

    const data = (await response.json()) as VoyageEmbeddingResponse;

    const sortedData = [...data.data].sort((a, b) => a.index - b.index);
    return sortedData.map((d) => d.embedding);
  }

  clearCache(): void {
    this.cache.clear();
  }

  getCacheSize(): number {
    return this.cache.size;
  }
}
