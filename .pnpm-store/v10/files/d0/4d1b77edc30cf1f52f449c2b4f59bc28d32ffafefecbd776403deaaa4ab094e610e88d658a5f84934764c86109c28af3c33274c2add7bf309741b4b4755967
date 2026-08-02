// src/index.ts
import {
  isBrowser,
  validateConfigSchema
} from "@chroma-core/ai-embeddings-common";
import {
  ChromaValueError,
  registerEmbeddingFunction
} from "chromadb";
var NAME = "ollama";
var OllamaEmbeddingFunction = class _OllamaEmbeddingFunction {
  constructor(args = {}) {
    this.name = NAME;
    const {
      url = "http://localhost:11434",
      model = "chroma/all-minilm-l6-v2-f32"
    } = args;
    this.url = url;
    this.model = model;
  }
  async import() {
    if (isBrowser()) {
      const { Ollama } = await import("ollama/browser");
      this.client = new Ollama({ host: this.url });
    } else {
      const { Ollama } = await import("ollama");
      this.client = new Ollama({ host: this.url });
    }
  }
  async generate(texts) {
    await this.import();
    if (!this.client) {
      throw new Error("Failed to instantiate Ollama client");
    }
    const response = await this.client.embed({
      model: this.model,
      input: texts
    });
    return response.embeddings;
  }
  defaultSpace() {
    return "cosine";
  }
  supportedSpaces() {
    return ["cosine", "l2", "ip"];
  }
  static buildFromConfig(config) {
    return new _OllamaEmbeddingFunction({
      model: config.model_name,
      url: config.url
    });
  }
  getConfig() {
    return {
      model_name: this.model,
      url: this.url
    };
  }
  validateConfigUpdate(newConfig) {
    if (this.getConfig().model_name !== newConfig.model_name) {
      throw new ChromaValueError("Model name cannot be updated");
    }
  }
  static validateConfig(config) {
    validateConfigSchema(config, NAME);
  }
};
registerEmbeddingFunction(NAME, OllamaEmbeddingFunction);
export {
  OllamaEmbeddingFunction
};
//# sourceMappingURL=ollama.mjs.map