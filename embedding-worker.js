import { pipeline } from "./lib/transformersjs/transformers.min.js";

const TEXT_EMBED_MODELS = {
  "all-mpnet-base-v2": [
    "feature-extraction",
    "Xenova/all-mpnet-base-v2",
    { dtype: "q8" },
  ],
  "gte-tiny": ["feature-extraction", "TaylorAI/gte-tiny", { dtype: "q8" }],
};

let currentTextEmbedModel = TEXT_EMBED_MODELS["gte-tiny"];

const extractorPromise = pipeline(...currentTextEmbedModel);

self.onmessage = async ({ data }) => {
  const extractor = await extractorPromise;
  if (data.preloadOnly) return;
  const result = await extractor(data.text, {
    pooling: "mean",
    normalize: true,
  });
  self.postMessage({ embedding: result.data });
};

setTimeout(async () => {
  await extractorPromise;
  console.log("preloaded embedding model");
});
