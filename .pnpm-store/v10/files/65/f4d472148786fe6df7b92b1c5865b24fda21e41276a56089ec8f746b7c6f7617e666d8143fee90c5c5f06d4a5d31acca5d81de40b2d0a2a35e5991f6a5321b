import { EmbeddingFunction, EmbeddingFunctionSpace } from 'chromadb';

interface OllamaConfig {
    url: string;
    model_name: string;
}
declare class OllamaEmbeddingFunction implements EmbeddingFunction {
    readonly name = "ollama";
    private readonly url;
    private readonly model;
    private client;
    constructor(args?: Partial<{
        url?: string;
        model: string;
    }>);
    private import;
    generate(texts: string[]): Promise<number[][]>;
    defaultSpace(): EmbeddingFunctionSpace;
    supportedSpaces(): EmbeddingFunctionSpace[];
    static buildFromConfig(config: OllamaConfig): OllamaEmbeddingFunction;
    getConfig(): OllamaConfig;
    validateConfigUpdate(newConfig: Record<string, any>): void;
    static validateConfig(config: OllamaConfig): void;
}

export { type OllamaConfig, OllamaEmbeddingFunction };
