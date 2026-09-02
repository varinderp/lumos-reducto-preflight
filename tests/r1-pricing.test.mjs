import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function importTypeScriptModule(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });

  return import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`
  );
}

async function apiRequest(payload) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("r1-test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/api/estimate", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        host: "lumos.example",
      },
      body: JSON.stringify(payload),
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

const documents = [{ name: "data-room.pdf", pages: 1_000 }];

function assertClose(actual, expected, label) {
  assert.ok(
    Math.abs(actual - expected) < 1e-12,
    `${label}: expected ${expected}, received ${actual}`,
  );
}

test("missing and explicit Legacy models preserve pricing and the Legacy rate card", async () => {
  const { estimatePipeline, normalizeRequest, RATE_CARD } =
    await importTypeScriptModule("../lib/pricing.ts");
  const assumptions = { likely_complex_parse_share: 0.35 };
  const missingModel = {
    documents,
    pipeline: {
      parse: {},
      lumos_assumptions: assumptions,
    },
  };
  const explicitLegacy = {
    documents,
    pipeline: {
      parse: { settings: { model: "legacy" } },
      lumos_assumptions: assumptions,
    },
  };

  const missingEstimate = estimatePipeline(normalizeRequest(missingModel));
  const explicitEstimate = estimatePipeline(normalizeRequest(explicitLegacy));
  assert.deepEqual(explicitEstimate, missingEstimate);
  assert.equal(missingEstimate.parseLow, 15);
  assertClose(missingEstimate.parseLikely, 20.25, "Legacy likely estimate");
  assert.equal(missingEstimate.parseHigh, 30);

  for (const payload of [missingModel, explicitLegacy]) {
    const response = await apiRequest(payload);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.rate_card, RATE_CARD);
    assert.deepEqual(result.estimate, {
      low_usd: 15,
      likely_usd: 20.25,
      high_usd: 30,
      currency: "USD",
    });
  }
});

test("r-1 prices processed pages at $10 per 1,000 and honors page ranges and Batch", async () => {
  const { estimatePipeline, normalizeRequest } =
    await importTypeScriptModule("../lib/pricing.ts");
  const fullEstimate = estimatePipeline(
    normalizeRequest({
      documents: [{ name: "data-room.pdf", pages: 4_000 }],
      pipeline: {
        parse: { settings: { model: "r-1" } },
      },
    }),
  );
  assert.equal(fullEstimate.parsePages, 4_000);
  assert.equal(fullEstimate.parseLow, 40);
  assert.equal(fullEstimate.parseLikely, 40);
  assert.equal(fullEstimate.parseHigh, 40);
  assert.equal(fullEstimate.estimateComplete, true);

  const rangedBatchEstimate = estimatePipeline(
    normalizeRequest({
      documents: [
        { name: "first.pdf", pages: 10 },
        { name: "second.pdf", pages: 10 },
      ],
      pipeline: {
        parse: {
          settings: { model: "r-1", page_range: { start: 2, end: 6 } },
          queue_priority: "batch",
        },
      },
    }),
  );
  assert.equal(rangedBatchEstimate.parsePages, 10);
  assert.equal(rangedBatchEstimate.parseBatchDiscount, 0.2);
  assertClose(rangedBatchEstimate.parseLow, 0.08, "r-1 Batch low estimate");
  assertClose(rangedBatchEstimate.parseLikely, 0.08, "r-1 Batch likely estimate");
  assertClose(rangedBatchEstimate.parseHigh, 0.08, "r-1 Batch high estimate");
});

test("r-1 ignores Legacy complexity and Agentic multipliers while pricing prompts separately", async () => {
  const { estimatePipeline, normalizeRequest } =
    await importTypeScriptModule("../lib/pricing.ts");
  const estimate = estimatePipeline(
    normalizeRequest({
      documents,
      pipeline: {
        parse: {
          settings: { model: "r-1" },
          enhance: {
            agentic: [{ scope: "text", prompt: "Describe every section." }],
          },
        },
        lumos_assumptions: { likely_complex_parse_share: 1 },
      },
    }),
  );

  assert.equal(estimate.parseLikelyComplexShare, 0);
  assert.equal(estimate.parseCostMultiplier, 1);
  assert.equal(estimate.parseLow, 15);
  assert.equal(estimate.parseLikely, 15);
  assert.equal(estimate.parseHigh, 15);
  assert.equal(estimate.estimateComplete, true);
  assert.deepEqual(estimate.unpricedCostFactors, []);
  assert.equal(estimate.parsingAddOns.parse.prompted_pages, 1_000);
  assert.equal(estimate.parsingAddOns.parse.prompted_usd, 5);
});

test("r-1 uses the published OCR, prompt, and Advanced Chart add-on rates", async () => {
  const { estimatePipeline, normalizeRequest } =
    await importTypeScriptModule("../lib/pricing.ts");
  const cases = [
    {
      name: "custom prompt",
      parse: {
        settings: { model: "r-1" },
        enhance: { agentic: [{ scope: "table", prompt: "Normalize the table." }] },
      },
      expected: [15, 15, 15],
    },
    {
      name: "OCR return",
      parse: { settings: { model: "r-1", return_ocr_data: true } },
      expected: [12, 12, 12],
    },
    {
      name: "Advanced Chart",
      parse: {
        settings: { model: "r-1" },
        enhance: {
          agentic: [{ scope: "figure", advanced_chart_agent: true }],
        },
      },
      assumptions: { advanced_chart_counts: { likely: 10, maximum: 20 } },
      expected: [10, 10.6, 11.2],
    },
  ];

  for (const testCase of cases) {
    const input = normalizeRequest({
      documents,
      pipeline: {
        parse: testCase.parse,
        ...(testCase.assumptions
          ? { lumos_assumptions: testCase.assumptions }
          : {}),
      },
    });
    const estimate = estimatePipeline(input);
    assertClose(estimate.parseLow, testCase.expected[0], `${testCase.name} low`);
    assertClose(estimate.parseLikely, testCase.expected[1], `${testCase.name} likely`);
    assertClose(estimate.parseHigh, testCase.expected[2], `${testCase.name} high`);
    assert.equal(estimate.estimateComplete, true, `${testCase.name} completeness`);
    assert.deepEqual(estimate.unpricedCostFactors, []);
  }
});

test("r-1 rejects promptless non-chart Agentic scopes with actionable guidance", async () => {
  const payload = {
    documents,
    pipeline: {
      parse: {
        settings: { model: "r-1" },
        enhance: { agentic: [{ scope: "text" }] },
      },
    },
  };

  const response = await apiRequest(payload);
  assert.equal(response.status, 400);
  const result = await response.json();
  assert.match(result.error, /r-1 Agentic scopes without prompts/i);
  assert.match(result.error, /add a prompt/i);
  assert.match(result.error, /remove the scope/i);
  assert.match(result.error, /select Legacy Parse/i);
});

test("the public API accepts copied r-1 profiles and returns the r-1 Beta card", async () => {
  const { R1_RATE_CARD } = await importTypeScriptModule("../lib/pricing.ts");
  const copiedProfile = JSON.parse(
    JSON.stringify({
      parse: {
        settings: { model: "r-1", page_range: { start: 1, end: 250 } },
        queue_priority: "batch",
      },
      classify: null,
      extract: null,
      split: null,
      edit: null,
      lumos_assumptions: {},
    }),
  );
  const response = await apiRequest({
    documents,
    pipeline: copiedProfile,
    policy: { max_total_usd: 10 },
  });
  assert.equal(response.status, 200);
  const result = await response.json();

  assert.equal(result.rate_card, R1_RATE_CARD);
  assert.deepEqual(result.estimate, {
    low_usd: 2,
    likely_usd: 2,
    high_usd: 2,
    currency: "USD",
  });
  assert.equal(result.usage.parse_pages_priced, 250);
  assert.equal(result.usage.parse_cost_multiplier, 1);
  assert.equal(result.usage.parse_batch_discount, 0.2);
  assert.deepEqual(result.assumptions_used, {});
  assert.equal(result.estimate_complete, true);
  assert.deepEqual(result.unpriced_cost_factors, []);
});
