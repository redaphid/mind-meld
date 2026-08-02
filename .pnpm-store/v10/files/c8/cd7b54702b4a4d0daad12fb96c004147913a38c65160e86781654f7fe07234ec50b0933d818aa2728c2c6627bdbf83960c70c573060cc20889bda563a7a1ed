"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var src_exports = {};
__export(src_exports, {
  OllamaEmbeddingFunction: () => OllamaEmbeddingFunction
});
module.exports = __toCommonJS(src_exports);
var import_ai_embeddings_common = require("@chroma-core/ai-embeddings-common");
var import_chromadb = require("chromadb");
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
    if ((0, import_ai_embeddings_common.isBrowser)()) {
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
      throw new import_chromadb.ChromaValueError("Model name cannot be updated");
    }
  }
  static validateConfig(config) {
    (0, import_ai_embeddings_common.validateConfigSchema)(config, NAME);
  }
};
(0, import_chromadb.registerEmbeddingFunction)(NAME, OllamaEmbeddingFunction);
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  OllamaEmbeddingFunction
});
//# sourceMappingURL=ollama.cjs.map