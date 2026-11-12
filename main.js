// @ts-check

import SpriteText from "https://esm.sh/three-spritetext";
import * as pdfjsLib from "./lib/pdfjs/build/pdf.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "./lib/pdfjs/build/pdf.worker.mjs";

const FILE_INPUT = /** @type {HTMLInputElement}*/ (
  document.getElementById("file-input")
);
const TEXT_INPUT_FORM = /** @type{HTMLFormElement}*/ (
  document.getElementById("text-input-form")
);
const TEXT_INPUT = /** @type{HTMLInputElement}*/ (
  document.getElementById("text-input")
);
const MAIN_PROGRESS = /** @type {HTMLProgressElement}*/ (
  document.getElementById("main-progress")
);

/** @type {{busy:boolean, instance:Worker}[]} */
const EMBEDDING_WORKER_POOL = [];

/**
 * @param {File} file
 * @returns {Promise<string>}
 */
async function getTextFromPdf(file) {
  console.assert(file.type === "application/pdf");
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(arrayBuffer),
  }).promise;

  return (
    await Promise.all(
      Array.from({ length: pdf.numPages }, (_, pageIndex) =>
        pdf
          .getPage(pageIndex + 1)
          .then((page) => page.getTextContent())
          .then((pageContent) =>
            pageContent.items.map((contentItem) => contentItem.str).join(" "),
          ),
      ),
    )
  ).join(" ");
}

/**
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function getEmbedding(text) {
  async function getAvailableWorker() {
    while (true) {
      const worker = EMBEDDING_WORKER_POOL.find((w) => !w.busy);
      if (worker) {
        worker.busy = true;
        return worker;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const queryEmbeddingWorker = await getAvailableWorker();

  const queryEmbeddingPromise = new Promise((resolve) => {
    const handler = (event) => {
      queryEmbeddingWorker.instance.removeEventListener("message", handler);
      resolve(event.data.embedding);
      queryEmbeddingWorker.busy = false;
    };
    queryEmbeddingWorker.instance.addEventListener("message", handler);
  });
  queryEmbeddingWorker.instance.postMessage({ text });
  return queryEmbeddingPromise;
}

function getCosineSimilarity(a, b) {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dot / (magA * magB);
}

/**
 * @param {number[][]} embeddingVectors
 * @returns {{source: number, target: number, distance: number, similarity: number}[]}
 */
function getLinks(embeddingVectors) {
  const n = embeddingVectors.length;
  const links = new Array((n ** 2 - n) / 2);

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i <= j) continue;
      const cosineSimilarity = getCosineSimilarity(
        embeddingVectors[i],
        embeddingVectors[j],
      );
      links[(i * (i - 1)) / 2 + j] = {
        source: i,
        target: j,
        distance: 1 - cosineSimilarity,
        similarity: cosineSimilarity,
      };
    }
  }

  const minWeight = Math.min(...links.map((l) => l.distance));
  const maxWeight = Math.max(...links.map((l) => l.distance));
  const range = maxWeight - minWeight;

  for (const link of links) {
    if (range !== 0) link.distance = (link.distance - minWeight) / range;
    link.distance = ((link.distance / 1.2 + 0.1) * 25) ** 2;
  }

  return links;
}

function createGraph() {
  const graph = new ForceGraph3D(document.getElementById("graph"));
  graph.d3Force("link").distance((link) => link.distance);
  graph.nodeThreeObject((node) => {
    const sprite = new SpriteText(node.label);
    sprite.material.depthWrite = false; // make sprite background transparent
    sprite.color = "black";
    sprite.textHeight = 8;
    sprite.center.y = -0.6;
    return sprite;
  });
  graph.nodeThreeObjectExtend(true);
  graph.backgroundColor("white");
  graph.linkColor(() => "blue");
  graph.nodeColor(() => "red");
  graph.linkOpacity(0.1);
  graph.linkWidth((link) => (link.similarity * 1.25) ** 2);
  // graph.linkVisibility(() => false);
  return graph;
}

const embeddingVectors = [];
const labels = [];
const graph = createGraph();
let requestGraphUpdate = false;

function graphUpdate() {
  requestGraphUpdate = false;
  graph.graphData({
    nodes: labels.map((label, i) => ({
      id: i,
      label: label.length > 15 ? label.substring(0, 15) + "..." : label,
    })),
    links: getLinks(embeddingVectors),
  });

  setTimeout(() => {
    graph.zoomToFit(1000, 0);
  }, 250);
}

setInterval(() => {
  if (!requestGraphUpdate) return;
  graphUpdate();
}, 3000);

/**
 * @param {string} text
 */
async function textPipeline(text) {
  getEmbedding(text).then((embeddingVector) => {
    embeddingVectors.push(embeddingVector);
    labels.push(text);
    graphUpdate();
    MAIN_PROGRESS.style.opacity = 0;
  });
}

/**
 * @param {File[]} pdfs
 */
async function pdfPipeline(pdfs) {
  pdfs.forEach((pdf) => {
    getTextFromPdf(pdf).then((pdfText) => {
      getEmbedding(pdfText).then((embeddingVector) => {
        embeddingVectors.push(embeddingVector);
        labels.push(pdf.name);
        requestGraphUpdate = true;
        MAIN_PROGRESS.value += 1 / pdfs.length;
        if (MAIN_PROGRESS.value >= 1 - 0.01) {
          graphUpdate();
          MAIN_PROGRESS.style.opacity = 0;
        }
      });
    });
  });
}

async function initialize() {
  FILE_INPUT?.addEventListener("input", async () => {
    MAIN_PROGRESS.style.opacity = 1;
    MAIN_PROGRESS.value = 0;
    const files = Array.from(FILE_INPUT.files);
    pdfPipeline(files);
  });
  TEXT_INPUT_FORM?.addEventListener("submit", (event) => {
    event.preventDefault();
    const inputText = TEXT_INPUT.value;
    TEXT_INPUT.value = "";
    MAIN_PROGRESS.style.opacity = 1;
    textPipeline(inputText);
  });
}
initialize();

function preload() {
  for (let i = 0; i < 1; i++) {
    const embeddingWorker = new Worker("./embedding-worker.js", {
      type: "module",
    });
    EMBEDDING_WORKER_POOL.push({
      busy: false,
      instance: embeddingWorker,
    });
  }
}
setTimeout(preload);
