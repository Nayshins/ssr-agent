export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}
