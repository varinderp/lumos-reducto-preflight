import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function importPricing() {
  const source = await readFile(new URL("../lib/pricing.ts", import.meta.url), "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`
  );
}

function close(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${label}: ${actual} !== ${expected}`);
}

const documents = [{ name: "data-room.pdf", pages: 1_000 }];

async function apiRequest(payload) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("parsing-addons", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/api/estimate", {
      method: "POST",
      headers: { "content-type": "application/json", host: "lumos.example" },
      body: JSON.stringify(payload),
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("Legacy Agentic multiplies only the Parse page rate, not parsing add-ons", async () => {
  const { estimatePipeline, normalizeRequest } = await importPricing();
  const estimate = estimatePipeline(
    normalizeRequest({
      documents,
      pipeline: {
        parse: {
          settings: { model: "legacy", return_ocr_data: true },
          enhance: {
            agentic: [
              { scope: "text", prompt: "Extract the prompted blocks." },
              { scope: "figure", advanced_chart_agent: true },
            ],
          },
        },
        lumos_assumptions: {
          likely_complex_parse_share: 0.5,
          advanced_chart_counts: { likely: 10, maximum: 20 },
        },
      },
    }),
  );

  close(estimate.parseLow, 37, "low");
  close(estimate.parseLikely, 52.6, "likely");
  close(estimate.parseHigh, 68.2, "high");
  assert.equal(estimate.parsingAddOns.parse.ocr_usd, 2);
  assert.equal(estimate.parsingAddOns.parse.prompted_usd, 5);
  assert.equal(estimate.estimateComplete, true);
});

test("Extract prices OCR, prompted blocks, and detected charts above its page rate", async () => {
  const { estimatePipeline, normalizeRequest } = await importPricing();
  const estimate = estimatePipeline(
    normalizeRequest({
      documents,
      pipeline: {
        parse: null,
        extract: {
          settings: { optimize_for_latency: true },
          parsing: {
            settings: { return_ocr_data: true },
            enhance: {
              agentic: [
                { scope: "table", prompt: "Use this custom region." },
                { scope: "figure", advanced_chart_agent: true },
              ],
            },
          },
        },
        lumos_assumptions: {
          estimated_extract_fields_per_page: 10,
          advanced_chart_counts_by_endpoint: {
            extract: { likely: 10, maximum: 20 },
          },
        },
      },
    }),
  );

  close(estimate.extractLow, 47, "low");
  close(estimate.extractLikely, 47.6, "likely");
  close(estimate.extractHigh, 48.2, "high");
  assert.equal(estimate.extractCostMultiplier, 2);
  assert.equal(estimate.parsingAddOns.extract.ocr_pages, 1_000);
  assert.equal(estimate.parsingAddOns.extract.prompted_pages, 1_000);
});

test("Split prices parsing add-ons without a separate base Parse charge", async () => {
  const { estimatePipeline, normalizeRequest } = await importPricing();
  const estimate = estimatePipeline(
    normalizeRequest({
      documents,
      pipeline: {
        parse: null,
        split: {
          settings: { deep_split: true },
          parsing: {
            settings: { return_ocr_data: true },
            enhance: {
              agentic: [
                { scope: "text", prompt: "Find prompted blocks." },
                { scope: "figure", advanced_chart_agent: true },
              ],
            },
          },
        },
        lumos_assumptions: {
          advanced_chart_counts_by_endpoint: {
            split: { likely: 10, maximum: 20 },
          },
        },
      },
    }),
  );

  close(estimate.splitLow, 47, "low");
  close(estimate.splitLikely, 47.6, "likely");
  close(estimate.splitHigh, 48.2, "high");
  assert.equal(estimate.parsePages, 0);
  assert.equal(estimate.parseLow, 0);
});

test("jobid inputs do not rebill nested parsing add-ons", async () => {
  const { estimatePipeline, normalizeRequest } = await importPricing();
  const parsing = {
    settings: { return_ocr_data: true },
    enhance: {
      agentic: [
        { scope: "table", prompt: "Prompted block." },
        { scope: "figure", advanced_chart_agent: true },
      ],
    },
  };
  const estimate = estimatePipeline(
    normalizeRequest({
      documents,
      pipeline: {
        extract: { settings: {}, parsing },
        split: { settings: { deep_split: true }, parsing },
        lumos_assumptions: {
          estimated_extract_fields_per_page: 10,
          advanced_chart_counts_by_endpoint: {
            extract: { likely: 10, maximum: 20 },
            split: { likely: 10, maximum: 20 },
          },
          prompted_blocks_or_custom_regions: { extract: true, split: true },
        },
      },
      processing_context: { extract_input: "jobid", split_input: "jobid" },
    }),
  );

  close(estimate.low, 60, "low");
  close(estimate.likely, 60, "likely");
  close(estimate.high, 60, "high");
  assert.equal(estimate.parsingAddOns.extract.input, "jobid");
  assert.equal(estimate.parsingAddOns.split.input, "jobid");
  assert.equal(estimate.parsingAddOns.extract.ocr_pages, 0);
  assert.equal(estimate.parsingAddOns.split.prompted_pages, 0);
  assert.equal(estimate.estimateComplete, true);
});

test("jobid reuse clears an imported missing-chart-count exclusion", async () => {
  const { estimatePipeline, normalizeRequest } = await importPricing();
  const estimate = estimatePipeline(
    normalizeRequest({
      documents,
      pipeline: {
        extract: {
          settings: {},
          parsing: {
            enhance: {
              agentic: [{ scope: "figure", advanced_chart_agent: true }],
            },
          },
        },
        lumos_assumptions: {
          estimated_extract_fields_per_page: 10,
          unpriced_cost_factors: ["extract.advanced_chart_count"],
        },
      },
      processing_context: { extract_input: "jobid" },
    }),
  );

  close(estimate.low, 20, "low");
  close(estimate.likely, 20, "likely");
  close(estimate.high, 20, "high");
  assert.equal(estimate.estimateComplete, true);
  assert.deepEqual(estimate.unpricedCostFactors, []);
});

test("missing endpoint chart counts retain the known subtotal and mark it incomplete", async () => {
  const { estimatePipeline, normalizeRequest } = await importPricing();
  const estimate = estimatePipeline(
    normalizeRequest({
      documents,
      pipeline: {
        extract: {
          settings: {},
          parsing: {
            enhance: { agentic: [{ scope: "figure", advanced_chart_agent: true }] },
          },
        },
        lumos_assumptions: { estimated_extract_fields_per_page: 10 },
      },
    }),
  );

  assert.equal(estimate.extractLow, 20);
  assert.equal(estimate.extractLikely, 20);
  assert.equal(estimate.extractHigh, 20);
  assert.equal(estimate.estimateComplete, false);
  assert.deepEqual(estimate.unpricedCostFactors, ["extract.advanced_chart_count"]);
});

test("the estimate API exposes add-on costs, usage, and jobid request context", async () => {
  const pipeline = {
    extract: {
      settings: {},
      parsing: {
        settings: { return_ocr_data: true },
        enhance: {
          agentic: [{ scope: "figure", advanced_chart_agent: true }],
        },
      },
    },
    lumos_assumptions: {
      estimated_extract_fields_per_page: 10,
      prompted_blocks_or_custom_regions: { extract: true },
      advanced_chart_counts_by_endpoint: {
        extract: { likely: 10, maximum: 20 },
      },
    },
  };
  const response = await apiRequest({
    documents,
    pipeline,
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.estimate, {
    low_usd: 27,
    likely_usd: 27.6,
    high_usd: 28.2,
    currency: "USD",
  });
  assert.equal(result.breakdown.parsing_add_ons.extract.ocr_usd, 2);
  assert.equal(result.breakdown.parsing_add_ons.extract.prompted_usd, 5);
  assert.equal(result.breakdown.parsing_add_ons.extract.chart_likely_usd, 0.6);
  assert.equal(result.breakdown.parsing_add_ons.extract.chart_high_usd, 1.2);
  assert.equal(result.usage.ocr_pages.extract, 1_000);
  assert.equal(result.usage.prompted_pages.extract, 1_000);
  assert.deepEqual(result.usage.charts.extract, { low: 0, likely: 10, high: 20 });

  const reused = await apiRequest({
    documents,
    pipeline,
    processing_context: { extract_input: "jobid" },
  });
  assert.equal(reused.status, 200);
  const reusedResult = await reused.json();
  assert.deepEqual(reusedResult.estimate, {
    low_usd: 20,
    likely_usd: 20,
    high_usd: 20,
    currency: "USD",
  });
  assert.equal(reusedResult.estimate.likely_usd, 20);
  assert.equal(reusedResult.breakdown.parsing_add_ons.extract.input, "jobid");
  assert.equal(reusedResult.usage.ocr_pages.extract, 0);
  assert.equal(reusedResult.usage.prompted_pages.extract, 0);
  assert.deepEqual(reusedResult.usage.charts.extract, { low: 0, likely: 0, high: 0 });
});

test("processing context remains strict and cannot target a disabled endpoint", async () => {
  const invalidValue = await apiRequest({
    documents,
    pipeline: { extract: { settings: {} }, lumos_assumptions: { estimated_extract_fields_per_page: 10 } },
    processing_context: { extract_input: "cached" },
  });
  assert.equal(invalidValue.status, 400);
  assert.match((await invalidValue.json()).error, /document.*jobid/i);

  const disabled = await apiRequest({
    documents,
    pipeline: { parse: {} },
    processing_context: { extract_input: "jobid" },
  });
  assert.equal(disabled.status, 400);
  assert.match((await disabled.json()).error, /requires Extract to be enabled/i);
});
