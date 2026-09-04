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

async function apiRequest(payload) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set(
    "spreadsheet-test",
    `${process.pid}-${Date.now()}-${Math.random()}`,
  );
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

function close(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${label}: ${actual} !== ${expected}`);
}

test("spreadsheet clustering converts cells to prorated credits and dollars exactly", async () => {
  const { estimatePipeline, normalizeRequest } = await importPricing();
  const cases = [
    { clustering: undefined, cells: 100_000, credits: 100, usd: 1 },
    { clustering: "accurate", cells: 1_500, credits: 1.5, usd: 0.015 },
    { clustering: "fast", cells: 100_000, credits: 20, usd: 0.2 },
    { clustering: "disabled", cells: 100_000, credits: 20, usd: 0.2 },
    { clustering: "accurate", cells: 0, credits: 0, usd: 0 },
  ];

  for (const item of cases) {
    const estimate = estimatePipeline(
      normalizeRequest({
        documents: [{ name: "model.xlsx", estimated_non_empty_cells: item.cells }],
        pipeline: {
          parse: {
            ...(item.clustering
              ? { spreadsheet: { clustering: item.clustering } }
              : {}),
          },
        },
      }),
    );
    close(estimate.spreadsheetCredits, item.credits, `${item.clustering ?? "default"} credits`);
    close(estimate.spreadsheetCost, item.usd, `${item.clustering ?? "default"} cost`);
    close(estimate.low, item.usd, `${item.clustering ?? "default"} low`);
    close(estimate.likely, item.usd, `${item.clustering ?? "default"} likely`);
    close(estimate.high, item.usd, `${item.clustering ?? "default"} high`);
    assert.equal(estimate.totalPages, 0);
    assert.equal(estimate.estimateComplete, true);
    assert.equal(estimate.spreadsheetBaseEndpoint, "parse");
  }
});

test("all supported spreadsheet extensions and URL suffixes use cell pricing", async () => {
  const { normalizeRequest } = await importPricing();
  const names = [
    "book.xls",
    "BOOK.XLSX?download=1",
    "https://files.example.com/book.XLSM#sheet",
    "book.xltx",
    "BOOK.XLTM",
    "export.CSV?token=abc",
    "archive.QPW#download",
  ];

  for (const name of names) {
    const normalized = normalizeRequest({
      documents: [{ name, estimated_non_empty_cells: 10 }],
      pipeline: { parse: {} },
    });
    assert.equal(normalized.documents[0].isSpreadsheet, true, name);
    assert.equal(normalized.documents[0].pages, 0, name);
  }

  const ordinary = normalizeRequest({
    documents: [{ name: "report.pdf?attachment=budget.xlsx", pages: 2 }],
    pipeline: { parse: {} },
  });
  assert.equal(ordinary.documents[0].isSpreadsheet, false);
  assert.equal(ordinary.documents[0].isPdf, true);
});

test("spreadsheet cell counts and settings reject unsafe or ambiguous values", async () => {
  const { normalizeRequest } = await importPricing();
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "1000", "", null]) {
    assert.throws(
      () =>
        normalizeRequest({
          documents: [{ name: "model.xlsx", estimated_non_empty_cells: value }],
          pipeline: { parse: {} },
        }),
      /estimated_non_empty_cells.*finite number|estimated_non_empty_cells.*whole number/i,
      String(value),
    );
  }
  assert.throws(
    () =>
      normalizeRequest({
        documents: [{ name: "model.xlsx", pages: 1 }],
        pipeline: { parse: {} },
      }),
    /unsupported field: pages/i,
  );
  assert.throws(
    () =>
      normalizeRequest({
        documents: [{ name: "contract.pdf", pages: 1, estimated_non_empty_cells: 10 }],
        pipeline: { parse: {} },
      }),
    /unsupported field: estimated_non_empty_cells/i,
  );
  assert.throws(
    () =>
      normalizeRequest({
        documents: [
          { name: "one.xlsx", estimated_non_empty_cells: Number.MAX_SAFE_INTEGER },
          { name: "two.csv", estimated_non_empty_cells: 1 },
        ],
        pipeline: { parse: {} },
      }),
    /combined spreadsheet cell count is too large/i,
  );

  for (const spreadsheet of [
    { clustering: "turbo" },
    { max_cell_count: -1 },
    { max_cell_count: 1.5 },
    { max_cell_count: Number.MAX_SAFE_INTEGER + 1 },
    { clustering: "accurate", future_option: true },
  ]) {
    assert.throws(
      () =>
        normalizeRequest({
          documents: [{ name: "model.xlsx", estimated_non_empty_cells: 10 }],
          pipeline: { parse: { spreadsheet } },
        }),
      /clustering|max_cell_count|unsupported field/i,
    );
  }
});

test("max_cell_count is a safety cap and never substitutes for an estimate", async () => {
  const { estimatePipeline, normalizeRequest } = await importPricing();
  const atLimit = estimatePipeline(
    normalizeRequest({
      documents: [{ name: "model.xlsx", estimated_non_empty_cells: 100_000 }],
      pipeline: { parse: { spreadsheet: { max_cell_count: 100_000 } } },
    }),
  );
  assert.equal(atLimit.spreadsheetCost, 1);
  assert.equal(atLimit.estimateComplete, true);

  assert.throws(
    () =>
      normalizeRequest({
        documents: [{ name: "model.xlsx", estimated_non_empty_cells: 100_001 }],
        pipeline: { parse: { spreadsheet: { max_cell_count: 100_000 } } },
      }),
    /exceeding spreadsheet\.max_cell_count \(100000\)/i,
  );

  const missing = estimatePipeline(
    normalizeRequest({
      documents: [{ name: "model.xlsx" }],
      pipeline: { parse: { spreadsheet: { max_cell_count: 100_000 } } },
    }),
  );
  assert.equal(missing.spreadsheetCellsEstimated, 0);
  assert.equal(missing.spreadsheetCredits, 0);
  assert.equal(missing.spreadsheetCost, 0);
  assert.equal(missing.estimateComplete, false);
  assert.deepEqual(missing.unpricedCostFactors, ["spreadsheet.non_empty_cell_count"]);
});

test("mixed Legacy Parse batches price ordinary pages and spreadsheet cells independently", async () => {
  const { estimatePipeline, normalizeRequest } = await importPricing();
  const estimate = estimatePipeline(
    normalizeRequest({
      documents: [
        { name: "contract.pdf", pages: 100 },
        { name: "model.xlsx", estimated_non_empty_cells: 100_000 },
      ],
      pipeline: {
        parse: {
          enhance: { agentic: [{ scope: "text" }] },
          queue_priority: "batch",
          spreadsheet: { clustering: "accurate" },
        },
        lumos_assumptions: { likely_complex_parse_share: 0.25 },
      },
    }),
  );

  assert.equal(estimate.parsePages, 100);
  assert.equal(estimate.spreadsheetCredits, 100);
  assert.equal(estimate.spreadsheetCost, 1);
  close(estimate.low, 3.4, "Agentic Batch low plus spreadsheet");
  close(estimate.likely, 4, "Agentic Batch likely plus spreadsheet");
  close(estimate.high, 5.8, "Agentic Batch high plus spreadsheet");
});

test("conditional latency Extract leaves spreadsheet cell pricing unmodified", async () => {
  const { estimatePipeline, normalizeRequest } = await importPricing();
  const estimate = estimatePipeline(
    normalizeRequest({
      documents: [
        { name: "contract.pdf", pages: 100 },
        { name: "model.xlsx", estimated_non_empty_cells: 100_000 },
      ],
      pipeline: {
        extract: {
          settings: { deep_extract: false, optimize_for_latency: true },
          parsing: { spreadsheet: { clustering: "accurate" } },
        },
        lumos_assumptions: {
          conditional_extract_routing: true,
          likely_deep_extract_share: 0.4,
          estimated_extract_fields_per_page: 24,
        },
      },
    }),
  );

  assert.equal(estimate.extractPages, 100);
  assert.equal(estimate.spreadsheetCost, 1);
  close(estimate.extractLow, 4, "conditional Extract low");
  close(estimate.extractLikely, 5.6, "conditional Extract likely");
  close(estimate.extractHigh, 8, "conditional Extract high");
  close(estimate.low, 5, "mixed low");
  close(estimate.likely, 6.6, "mixed likely");
  close(estimate.high, 9, "mixed high");
});

test("bundled Parse and Extract charge a spreadsheet base exactly once", async () => {
  const { estimatePipeline, normalizeRequest } = await importPricing();
  const estimate = estimatePipeline(
    normalizeRequest({
      documents: [{ name: "model.xlsx", estimated_non_empty_cells: 100_000 }],
      pipeline: {
        parse: { spreadsheet: { clustering: "accurate" } },
        extract: { settings: { deep_extract: true } },
      },
    }),
  );

  assert.equal(estimate.parseMode, "bundled");
  assert.equal(estimate.parseLow, 0);
  assert.equal(estimate.extractLow, 0);
  assert.equal(estimate.spreadsheetBaseEndpoint, "extract");
  assert.equal(estimate.spreadsheetCost, 1);
  assert.equal(estimate.low, 1);
  assert.equal(estimate.estimateComplete, true);
});

test("Split spreadsheet settings cannot change an Extract spreadsheet subtotal", async () => {
  const { estimatePipeline, normalizeRequest } = await importPricing();
  const estimate = estimatePipeline(
    normalizeRequest({
      documents: [{ name: "model.xlsx", estimated_non_empty_cells: 100_000 }],
      pipeline: {
        extract: {
          settings: { deep_extract: false },
          parsing: { spreadsheet: { clustering: "fast" } },
        },
        split: {
          settings: { deep_split: true },
          parsing: { spreadsheet: { clustering: "disabled" } },
        },
      },
    }),
  );

  assert.equal(estimate.spreadsheetClustering, "fast");
  assert.equal(estimate.spreadsheetCredits, 20);
  assert.equal(estimate.spreadsheetCost, 0.2);
  assert.equal(estimate.estimateComplete, false);
  assert.ok(estimate.unpricedCostFactors.includes("spreadsheet.split"));
});

test("missing counts keep known costs and choose review or deny at the budget boundary", async () => {
  const { estimatePipeline, normalizeRequest } = await importPricing();
  const request = {
    documents: [
      { name: "contract.pdf", pages: 100 },
      { name: "model.xlsx" },
    ],
    pipeline: {
      extract: { settings: { deep_extract: false } },
      lumos_assumptions: { estimated_extract_fields_per_page: 24 },
    },
  };

  const review = estimatePipeline(
    normalizeRequest({ ...request, policy: { max_total_usd: 2 } }),
  );
  assert.equal(review.low, 2);
  assert.equal(review.estimateComplete, false);
  assert.equal(review.decision, "review");

  const deny = estimatePipeline(
    normalizeRequest({ ...request, policy: { max_total_usd: 1.99 } }),
  );
  assert.equal(deny.low, 2);
  assert.equal(deny.decision, "deny");
});

test("spreadsheet-only endpoint and add-on work stays excluded from the known subtotal", async () => {
  const { estimatePipeline, normalizeRequest } = await importPricing();
  const baseRequest = {
    documents: [{ name: "model.xlsx", estimated_non_empty_cells: 100_000 }],
    pipeline: {
      classify: {},
      extract: {
        settings: { deep_extract: true, optimize_for_latency: true },
        parsing: {
          settings: { return_ocr_data: true },
          enhance: {
            agentic: [
              { scope: "text", prompt: "Read the custom region." },
              { scope: "figure", advanced_chart_agent: true },
            ],
          },
        },
      },
      split: { settings: { deep_split: true } },
      edit: {},
      lumos_assumptions: {
        advanced_chart_counts_by_endpoint: { extract: { likely: 10, maximum: 20 } },
      },
    },
  };

  const review = estimatePipeline(
    normalizeRequest({ ...baseRequest, policy: { max_total_usd: 1 } }),
  );
  assert.equal(review.low, 1);
  assert.equal(review.likely, 1);
  assert.equal(review.high, 1);
  assert.equal(review.decision, "review");
  assert.equal(review.estimateComplete, false);
  for (const factor of [
    "spreadsheet.classify",
    "spreadsheet.split",
    "spreadsheet.edit",
    "spreadsheet.extract.return_ocr_data",
    "spreadsheet.extract.prompted_processing",
    "spreadsheet.extract.advanced_chart",
  ]) {
    assert.ok(review.unpricedCostFactors.includes(factor), factor);
  }

  const deny = estimatePipeline(
    normalizeRequest({ ...baseRequest, policy: { max_total_usd: 0.99 } }),
  );
  assert.equal(deny.decision, "deny");
});

test("mixed chart assumptions apply only to ordinary documents", async () => {
  const { estimatePipeline, normalizeRequest } = await importPricing();
  const estimate = estimatePipeline(
    normalizeRequest({
      documents: [
        { name: "contract.pdf", pages: 10 },
        { name: "model.xlsx", estimated_non_empty_cells: 100_000 },
      ],
      pipeline: {
        extract: {
          settings: { deep_extract: false },
          parsing: {
            enhance: {
              agentic: [{ scope: "figure", advanced_chart_agent: true }],
            },
            spreadsheet: { clustering: "accurate" },
          },
        },
        lumos_assumptions: {
          estimated_extract_fields_per_page: 24,
          advanced_chart_counts_by_endpoint: {
            extract: { likely: 2, maximum: 3 },
          },
        },
      },
    }),
  );

  close(estimate.low, 1.2, "mixed chart low");
  close(estimate.likely, 1.32, "mixed chart likely");
  close(estimate.high, 1.38, "mixed chart high");
  assert.equal(estimate.estimateComplete, false);
  assert.deepEqual(estimate.parsingAddOns.extract.charts, {
    low: 0,
    likely: 2,
    high: 3,
  });
  assert.ok(
    estimate.unpricedCostFactors.includes("spreadsheet.extract.advanced_chart"),
  );
});

test("Extract jobid reuse keeps its spreadsheet base but does not rebill parsing add-ons", async () => {
  const { estimatePipeline, normalizeRequest } = await importPricing();
  const estimate = estimatePipeline(
    normalizeRequest({
      documents: [{ name: "model.xlsx", estimated_non_empty_cells: 100_000 }],
      pipeline: {
        extract: {
          parsing: {
            settings: { return_ocr_data: true },
            enhance: {
              agentic: [
                { scope: "text", prompt: "Find a custom region." },
                { scope: "figure", advanced_chart_agent: true },
              ],
            },
            spreadsheet: { clustering: "accurate" },
          },
        },
        lumos_assumptions: {
          advanced_chart_counts_by_endpoint: {
            extract: { likely: 10, maximum: 20 },
          },
        },
      },
      processing_context: { extract_input: "jobid" },
    }),
  );

  assert.equal(estimate.spreadsheetBaseEndpoint, "extract");
  assert.equal(estimate.spreadsheetCost, 1);
  assert.equal(estimate.low, 1);
  assert.equal(estimate.likely, 1);
  assert.equal(estimate.high, 1);
  assert.equal(estimate.estimateComplete, true);
  assert.deepEqual(estimate.parsingAddOns.extract.charts, {
    low: 0,
    likely: 0,
    high: 0,
  });
});

test("Split jobid reuse excludes only the unpriced Split contribution", async () => {
  const { estimatePipeline, normalizeRequest } = await importPricing();
  const estimate = estimatePipeline(
    normalizeRequest({
      documents: [{ name: "model.xlsx", estimated_non_empty_cells: 100_000 }],
      pipeline: {
        split: {
          settings: { deep_split: false },
          parsing: {
            settings: { return_ocr_data: true },
            spreadsheet: { clustering: "fast" },
          },
        },
      },
      processing_context: { split_input: "jobid" },
    }),
  );

  assert.equal(estimate.spreadsheetCost, 0);
  assert.equal(estimate.estimateComplete, false);
  assert.deepEqual(estimate.unpricedCostFactors, ["spreadsheet.split"]);
  assert.equal(estimate.decision, "review");
});

test("custom simulator rates can override spreadsheet credits without changing defaults", async () => {
  const { DEFAULT_PRICING_UNIT_RATES, estimatePipeline, normalizeRequest } =
    await importPricing();
  const normalized = normalizeRequest({
    documents: [{ name: "model.xlsx", estimated_non_empty_cells: 100_000 }],
    pipeline: { extract: { parsing: { spreadsheet: { clustering: "accurate" } } } },
  });
  const custom = estimatePipeline(normalized, {
    ...DEFAULT_PRICING_UNIT_RATES,
    spreadsheetCredit: 0.025,
  });
  const defaults = estimatePipeline(normalized);
  assert.equal(custom.spreadsheetCost, 2.5);
  assert.equal(defaults.spreadsheetCost, 1);

  const legacyCustomRates = Object.fromEntries(
    Object.entries(DEFAULT_PRICING_UNIT_RATES).filter(
      ([key]) => key !== "spreadsheetCredit",
    ),
  );
  const ordinary = estimatePipeline(
    normalizeRequest({
      documents: [{ name: "contract.pdf", pages: 10 }],
      pipeline: { parse: {} },
    }),
    legacyCustomRates,
  );
  assert.equal(Number.isFinite(ordinary.low), true);
});

test("API responses expose spreadsheet basis and usage only for spreadsheet requests", async () => {
  const spreadsheetResponse = await apiRequest({
    documents: [{ name: "model.xlsx", estimated_non_empty_cells: 1_500 }],
    pipeline: {
      extract: {
        settings: { deep_extract: false },
        parsing: { spreadsheet: { clustering: "accurate", max_cell_count: 2_000 } },
      },
    },
  });
  assert.equal(spreadsheetResponse.status, 200);
  const spreadsheet = await spreadsheetResponse.json();
  assert.deepEqual(spreadsheet.estimate, {
    low_usd: 0.015,
    likely_usd: 0.015,
    high_usd: 0.015,
    currency: "USD",
  });
  assert.equal(spreadsheet.breakdown.spreadsheet_usd, 0.015);
  assert.deepEqual(spreadsheet.usage.spreadsheets, {
    documents: 1,
    estimated_non_empty_cells: 1_500,
    documents_missing_cell_count: 0,
    credits: 1.5,
    clustering: "accurate",
    max_cell_count: 2_000,
    base_endpoint: "extract",
  });
  assert.deepEqual(spreadsheet.spreadsheet_rate_basis, {
    usd_per_credit: 0.01,
    basis: "lumos_default",
    note: "Consult your Reducto rate card.",
  });
  assert.equal(spreadsheet.estimate_complete, true);

  const ordinaryResponse = await apiRequest({
    documents: [{ name: "contract.pdf", pages: 10 }],
    pipeline: { extract: { settings: { deep_extract: false } } },
  });
  assert.equal(ordinaryResponse.status, 200);
  const ordinary = await ordinaryResponse.json();
  assert.equal(Object.hasOwn(ordinary.breakdown, "spreadsheet_usd"), false);
  assert.equal(Object.hasOwn(ordinary.usage, "spreadsheets"), false);
  assert.equal(Object.hasOwn(ordinary, "spreadsheet_rate_basis"), false);
});

test("API keeps known spreadsheet subtotals visible across review and deny", async () => {
  const request = {
    documents: [
      { name: "contract.pdf", pages: 100 },
      { name: "known.xlsx", estimated_non_empty_cells: 100_000 },
      { name: "unknown.csv" },
    ],
    pipeline: {
      extract: {
        settings: { deep_extract: false },
        parsing: { spreadsheet: { clustering: "accurate" } },
      },
      lumos_assumptions: { estimated_extract_fields_per_page: 24 },
    },
  };

  const reviewResponse = await apiRequest({
    ...request,
    policy: { max_total_usd: 3 },
  });
  assert.equal(reviewResponse.status, 200);
  const review = await reviewResponse.json();
  assert.equal(review.estimate.low_usd, 3);
  assert.equal(review.breakdown.spreadsheet_usd, 1);
  assert.equal(review.decision, "review");
  assert.equal(review.estimate_complete, false);
  assert.ok(review.unpriced_cost_factors.includes("spreadsheet.non_empty_cell_count"));
  assert.deepEqual(review.usage.spreadsheets, {
    documents: 2,
    estimated_non_empty_cells: 100_000,
    documents_missing_cell_count: 1,
    credits: 100,
    clustering: "accurate",
    max_cell_count: null,
    base_endpoint: "extract",
  });

  const denyResponse = await apiRequest({
    ...request,
    policy: { max_total_usd: 2.99 },
  });
  assert.equal(denyResponse.status, 200);
  const deny = await denyResponse.json();
  assert.equal(deny.estimate.low_usd, 3);
  assert.equal(deny.decision, "deny");
  assert.equal(deny.estimate_complete, false);
});

test("paid verification rejects spreadsheet files before any upload", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set(
    "spreadsheet-verification-test",
    `${process.pid}-${Date.now()}-${Math.random()}`,
  );
  const { default: worker } = await import(workerUrl.href);
  const form = new FormData();
  form.append("api_key", "test-key");
  form.append("pipeline_id", "test-pipeline");
  form.append("confirmed", "true");
  form.append("files", new Blob(["not-a-real-workbook"]), "model.XLSX");
  const response = await worker.fetch(
    new Request("http://localhost/api/reducto", { method: "POST", body: form }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error:
      "Spreadsheet verification is unavailable because Lumos does not upload workbook contents.",
  });
});
