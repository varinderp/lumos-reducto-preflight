import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function loadTypeScriptModule(relativePath) {
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

async function loadManualPipeline() {
  return loadTypeScriptModule("../lib/manual-pipeline.ts");
}

function clone(value) {
  return structuredClone(value);
}

test("the inactive builder example generates a complete Standard Extract profile", async () => {
  const { DEFAULT_MANUAL_PIPELINE_DRAFT, manualDraftToPipeline } = await loadManualPipeline();
  const result = manualDraftToPipeline(clone(DEFAULT_MANUAL_PIPELINE_DRAFT));

  assert.equal(result.ok, true);
  assert.deepEqual(result.pipeline.parse, null);
  assert.deepEqual(result.pipeline.classify, null);
  assert.deepEqual(result.pipeline.extract, {
    settings: {
      deep_extract: false,
      optimize_for_latency: false,
      include_images: false,
    },
  });
  assert.deepEqual(result.pipeline.split, null);
  assert.deepEqual(result.pipeline.edit, null);
  assert.equal(result.pipeline.lumos_assumptions.conditional_extract_routing, false);
  assert.equal(result.pipeline.lumos_assumptions.estimated_extract_fields_per_page, 24);
  assert.equal(DEFAULT_MANUAL_PIPELINE_DRAFT.extract.mode, "standard");
  assert.equal(DEFAULT_MANUAL_PIPELINE_DRAFT.parse.includedDownstream, false);
  assert.equal(DEFAULT_MANUAL_PIPELINE_DRAFT.assumptions.extractFieldsPerPage, "24");
  assert.deepEqual(result.configurations.extract, {
    settings: {
      deep_extract: false,
      include_images: false,
      optimize_for_latency: false,
    },
  });
});

test("the builder requires at least one operation", async () => {
  const { DEFAULT_MANUAL_PIPELINE_DRAFT, manualDraftToPipeline } = await loadManualPipeline();
  const draft = clone(DEFAULT_MANUAL_PIPELINE_DRAFT);
  draft.extract.mode = "off";

  const result = manualDraftToPipeline(draft);
  assert.equal(result.ok, false);
  assert.match(result.errors.operations, /Choose at least one endpoint/);
});

test("standalone Parse maps ranges, agentic, batch, chart counts, and percentages", async () => {
  const { DEFAULT_MANUAL_PIPELINE_DRAFT, manualDraftToPipeline } = await loadManualPipeline();
  const draft = clone(DEFAULT_MANUAL_PIPELINE_DRAFT);
  Object.assign(draft.parse, {
    enabled: true,
    mode: "agentic",
    agenticScopes: { text: true, table: true, figure: true },
    batch: true,
    advancedChart: true,
  });
  Object.assign(draft.assumptions, {
    complexSharePercent: "60",
    chartCountsEnabled: true,
    likelyChartCount: "3",
    maximumChartCount: "7",
  });
  draft.extract.mode = "off";
  draft.parse.pageSelection = {
    mode: "selected",
    ranges: [
      { start: "1", end: "4" },
      { start: "9", end: "9" },
    ],
  };

  const result = manualDraftToPipeline(draft);
  assert.equal(result.ok, true);
  assert.deepEqual(result.pipeline.parse.settings.page_range, [
    { start: 1, end: 4 },
    { start: 9, end: 9 },
  ]);
  assert.deepEqual(result.pipeline.parse.enhance.agentic, [
    { scope: "text" },
    { scope: "table" },
    { scope: "figure", advanced_chart_agent: true },
  ]);
  assert.equal(result.pipeline.parse.queue_priority, "batch");
  assert.equal(result.pipeline.lumos_assumptions.likely_complex_parse_share, 0.6);
  assert.deepEqual(result.pipeline.lumos_assumptions.advanced_chart_counts, {
    likely: 3,
    maximum: 7,
  });
  assert.deepEqual(result.configurations.parse.settings.page_range, [
    { start: 1, end: 4 },
    { start: 9, end: 9 },
  ]);
  assert.deepEqual(result.configurations.parse.enhance.agentic, [
    { scope: "text" },
    { scope: "table" },
    { scope: "figure", advanced_chart_agent: true },
  ]);
});

test("the visual builder rejects standalone Parse with Extract or Split without mutating draft values", async () => {
  const { DEFAULT_MANUAL_PIPELINE_DRAFT, manualDraftToPipeline } = await loadManualPipeline();
  const draft = clone(DEFAULT_MANUAL_PIPELINE_DRAFT);
  Object.assign(draft.parse, {
    enabled: true,
    mode: "agentic",
    agenticScopes: { text: true, table: false, figure: true },
    batch: true,
    advancedChart: true,
  });
  draft.extract.mode = "deep";
  draft.split.mode = "standard";
  Object.assign(draft.assumptions, {
    chartCountsEnabled: true,
    likelyChartCount: "4",
    maximumChartCount: "8",
  });
  draft.parse.pageSelection = {
    mode: "selected",
    ranges: [{ start: "2", end: "6" }],
  };
  draft.extract.pageSelection = {
    mode: "selected",
    ranges: [{ start: "20", end: "30" }],
  };
  draft.split.pageSelection = {
    mode: "selected",
    ranges: [{ start: "40", end: "50" }],
  };
  const before = clone(draft);

  const result = manualDraftToPipeline(draft);
  assert.equal(result.ok, false);
  assert.match(result.errors["parse.enabled"], /Standalone Parse.*Extract or Split/i);
  assert.deepEqual(draft, before);
});

test("standalone Parse can coexist with additive Classify and Edit", async () => {
  const { DEFAULT_MANUAL_PIPELINE_DRAFT, manualDraftToPipeline } = await loadManualPipeline();
  const draft = clone(DEFAULT_MANUAL_PIPELINE_DRAFT);
  draft.parse.enabled = true;
  draft.extract.mode = "off";
  draft.classify.enabled = true;
  draft.edit.enabled = true;
  draft.edit.fullyPrefilledPages = "2";

  const result = manualDraftToPipeline(draft, 10);
  assert.equal(result.ok, true);
  assert.deepEqual(result.pipeline.parse, {});
  assert.deepEqual(result.pipeline.classify, { page_range: { start: 1, end: 5 } });
  assert.deepEqual(result.pipeline.edit, {});
  assert.equal(result.pipeline.extract, null);
  assert.equal(result.pipeline.split, null);
  assert.equal(result.pipeline.lumos_assumptions.known_fully_prefilled_edit_pages, 2);
});

test("Classify, conditional Extract, and Edit map every visible assumption", async () => {
  const { DEFAULT_MANUAL_PIPELINE_DRAFT, manualDraftToPipeline } = await loadManualPipeline();
  const draft = clone(DEFAULT_MANUAL_PIPELINE_DRAFT);
  Object.assign(draft.classify, { enabled: true, start: "2", end: "8" });
  Object.assign(draft.extract, {
    mode: "conditional",
    optimizeForLatency: true,
    includeImages: true,
  });
  Object.assign(draft.edit, { enabled: true, fullyPrefilledPages: "6" });
  Object.assign(draft.assumptions, {
    deepSharePercent: "35.5",
    extractFieldsPerPage: "101",
    unpricedCostFactors: ["future.rate", "future.rate"],
  });

  const result = manualDraftToPipeline(draft, 20);
  assert.equal(result.ok, true);
  assert.deepEqual(result.pipeline.classify.page_range, { start: 2, end: 8 });
  assert.equal(result.pipeline.extract.settings.deep_extract, false);
  assert.equal(result.pipeline.extract.settings.optimize_for_latency, true);
  assert.equal(result.pipeline.extract.settings.include_images, true);
  assert.equal(result.pipeline.lumos_assumptions.conditional_extract_routing, true);
  assert.equal(result.pipeline.lumos_assumptions.likely_deep_extract_share, 0.355);
  assert.equal(result.pipeline.lumos_assumptions.estimated_extract_fields_per_page, 101);
  assert.equal(result.pipeline.lumos_assumptions.known_fully_prefilled_edit_pages, 6);
  assert.deepEqual(result.pipeline.lumos_assumptions.unpriced_cost_factors, ["future.rate"]);
});

test("builder validation uses plain-language field errors", async () => {
  const { DEFAULT_MANUAL_PIPELINE_DRAFT, manualDraftToPipeline } = await loadManualPipeline();
  const draft = clone(DEFAULT_MANUAL_PIPELINE_DRAFT);
  Object.assign(draft.parse, { enabled: true, advancedChart: true });
  draft.extract.mode = "off";
  Object.assign(draft.assumptions, {
    complexSharePercent: "120",
    chartCountsEnabled: true,
    likelyChartCount: "8",
    maximumChartCount: "2",
  });
  Object.assign(draft.classify, { enabled: true, start: "1", end: "11" });
  Object.assign(draft.edit, { enabled: true, fullyPrefilledPages: "21" });
  draft.parse.pageSelection = {
    mode: "selected",
    ranges: [{ start: "7", end: "3" }],
  };

  const result = manualDraftToPipeline(draft, 20);
  assert.equal(result.ok, false);
  assert.match(result.errors["parse.pageSelection"], /selected page ranges/i);
  assert.match(result.errors["assumptions.complexSharePercent"], /0% to 100%/);
  assert.match(result.errors["assumptions.maximumChartCount"], /at least the likely count/);
  assert.match(result.errors["classify.end"], /up to 10 context pages/);
  assert.match(result.errors["edit.fullyPrefilledPages"], /uploaded page total/);
  assert.doesNotMatch(Object.values(result.errors).join(" "), /pipeline\.|object or null/i);
});

test("validation errors map to the endpoint tab that can resolve them", async () => {
  const { manualErrorEndpoint } = await loadManualPipeline();

  assert.equal(manualErrorEndpoint("parse.pageSelection.ranges.0.start"), "parse");
  assert.equal(manualErrorEndpoint("assumptions.complexSharePercent"), "parse");
  assert.equal(manualErrorEndpoint("assumptions.maximumChartCount"), "parse");
  assert.equal(manualErrorEndpoint("classify.end"), "classify");
  assert.equal(manualErrorEndpoint("extract.pageSelection"), "extract");
  assert.equal(manualErrorEndpoint("assumptions.deepSharePercent"), "extract");
  assert.equal(manualErrorEndpoint("split.pageSelection"), "split");
  assert.equal(manualErrorEndpoint("edit.fullyPrefilledPages"), "edit");
  assert.equal(manualErrorEndpoint("operations"), null);
});

test("Agentic Parse requires a scope unless Advanced Chart supplies Figure", async () => {
  const { DEFAULT_MANUAL_PIPELINE_DRAFT, manualDraftToPipeline } = await loadManualPipeline();
  const draft = clone(DEFAULT_MANUAL_PIPELINE_DRAFT);
  draft.extract.mode = "off";
  draft.parse.enabled = true;
  draft.parse.mode = "agentic";

  const missingScope = manualDraftToPipeline(draft);
  assert.equal(missingScope.ok, false);
  assert.match(missingScope.errors["parse.agenticScopes"], /Text, Table, or Figure/);

  draft.parse.advancedChart = true;
  const chartSuppliesFigure = manualDraftToPipeline(draft);
  assert.equal(chartSuppliesFigure.ok, true);
  assert.deepEqual(chartSuppliesFigure.pipeline.parse.enhance.agentic, [
    { scope: "figure", advanced_chart_agent: true },
  ]);
});

test("an imported profile hydrates and reapplies without losing independent ranges", async () => {
  const { manualDraftToPipeline, pipelineToManualDraft } = await loadManualPipeline();
  const imported = {
    parse: {},
    classify: { page_range: { start: 1, end: 4 } },
    extract: {
      settings: {
        deep_extract: true,
        optimize_for_latency: true,
        include_images: true,
        page_range: { start: 2, end: 5 },
      },
    },
    split: {
      settings: { deep_split: false },
      parsing: { settings: { page_range: { start: 8, end: 10 } } },
    },
    edit: {},
    lumos_assumptions: {
      conditional_extract_routing: false,
      estimated_extract_fields_per_page: 40,
      known_fully_prefilled_edit_pages: 2,
      unpriced_cost_factors: ["extract.include_images"],
    },
  };

  const draft = pipelineToManualDraft(imported);
  assert.equal(draft.parse.enabled, false);
  assert.equal(draft.parse.includedDownstream, true);
  assert.equal(draft.extract.pageSelection.ranges[0].start, "2");
  assert.equal(draft.split.pageSelection.ranges[0].start, "8");
  assert.deepEqual(draft.assumptions.unpricedCostFactors, ["extract.include_images"]);

  const reapplied = manualDraftToPipeline(draft, 20);
  assert.equal(reapplied.ok, true);
  assert.deepEqual(reapplied.pipeline.extract.settings.page_range, { start: 2, end: 5 });
  assert.deepEqual(reapplied.pipeline.split.parsing.settings.page_range, {
    start: 8,
    end: 10,
  });
  assert.equal(reapplied.pipeline.lumos_assumptions.unpriced_cost_factors, undefined);
});

test("review preserves imported Reducto settings while normalizing cost paths", async () => {
  const { manualDraftToPipeline, pipelineToManualDraft } = await loadManualPipeline();
  const pipeline = {
    parse: {
      enhance: {
        agentic: [
          { scope: "text" },
          { scope: "table", mode: "auto" },
          { scope: "figure", advanced_chart_agent: true },
        ],
      },
    },
    classify: { page_range: { start: 1, end: 4 } },
    extract: {
      settings: {
        deep_extract: true,
        optimize_for_latency: true,
        include_images: false,
        page_range: { start: 2, end: 6 },
      },
    },
    split: {
      settings: { deep_split: true },
      parsing: { settings: { page_range: { start: 8, end: 12 } } },
    },
    edit: {},
    lumos_assumptions: {
      estimated_extract_fields_per_page: 12,
      known_fully_prefilled_edit_pages: 1,
    },
  };
  const rawConfigurations = {
    parse: {
      enhance: {
        agentic: [
          { scope: "text", prompt: "Read faded text" },
          { scope: "table", mode: "auto" },
          { scope: "figure", advanced_chart_agent: true },
        ],
        summarize_figures: true,
      },
      formatting: { table_output_format: "html" },
      settings: { page_range: { start: 90, end: 99 }, timeout: 900 },
    },
    classify: {
      classification_schema: [{ name: "policy", description: "Insurance policy" }],
      page_range: { start: 1, end: 4 },
    },
    extract: {
      instructions: {
        schema: { type: "object", properties: { name: { type: "string" } } },
      },
      settings: {
        deep_extract: true,
        include_images: false,
        optimize_for_latency: true,
        page_range: { start: 90, end: 99 },
      },
      parsing: {
        formatting: { add_page_markers: true },
        settings: { page_range: { start: 2, end: 6 } },
      },
    },
    split: {
      split_description: [{ name: "Definitions", description: "Defined terms" }],
      deep_split: true,
      split_options: { table_cutoff: "truncate" },
      parsing: { settings: { page_range: { start: 8, end: 12 } } },
    },
    edit: { edit_instructions: "Fill the form" },
  };

  const draft = pipelineToManualDraft(pipeline, rawConfigurations);
  rawConfigurations.parse.formatting.table_output_format = "markdown";
  assert.equal(draft.importedConfigurations.parse.formatting.table_output_format, "html");
  assert.deepEqual(draft.parse.agenticScopes, { text: true, table: true, figure: true });
  assert.equal(draft.parse.enabled, false);
  assert.equal(draft.parse.includedDownstream, true);

  const reapplied = manualDraftToPipeline(draft, 20);
  assert.equal(reapplied.ok, true);
  assert.equal(reapplied.configurations.parse.formatting.table_output_format, "html");
  assert.deepEqual(reapplied.configurations.parse.settings.page_range, {
    start: 90,
    end: 99,
  });
  assert.equal(reapplied.configurations.parse.settings.timeout, 900);
  assert.equal(
    reapplied.configurations.parse.enhance.agentic[0].prompt,
    "Read faded text",
  );
  assert.deepEqual(reapplied.configurations.extract.parsing.settings.page_range, {
    start: 2,
    end: 6,
  });
  assert.equal(reapplied.configurations.extract.settings.page_range, undefined);
  assert.equal(
    reapplied.configurations.extract.parsing.formatting.add_page_markers,
    true,
  );
  assert.deepEqual(reapplied.configurations.split.parsing.settings.page_range, {
    start: 8,
    end: 12,
  });
  assert.equal(reapplied.configurations.split.deep_split, undefined);
  assert.equal(reapplied.configurations.split.settings.deep_split, true);
  assert.deepEqual(reapplied.configurations.split.split_description, [
    { name: "Definitions", description: "Defined terms" },
  ]);
  assert.equal(reapplied.configurations.edit.edit_instructions, "Fill the form");
});

test("an older bundled Parse range fills only missing downstream ranges", async () => {
  const { manualDraftToPipeline, pipelineToManualDraft } = await loadManualPipeline();
  const imported = {
    parse: { settings: { page_range: { start: 2, end: 6 } } },
    extract: { settings: { deep_extract: false } },
    split: {
      settings: { deep_split: true },
      parsing: { settings: { page_range: { start: 9, end: 12 } } },
    },
  };

  const draft = pipelineToManualDraft(imported);
  assert.equal(draft.parse.enabled, false);
  assert.equal(draft.parse.includedDownstream, true);
  assert.equal(draft.parse.pageSelection.mode, "all");
  assert.deepEqual(draft.extract.pageSelection.ranges.map(({ start, end }) => ({ start, end })), [
    { start: "2", end: "6" },
  ]);
  assert.deepEqual(draft.split.pageSelection.ranges.map(({ start, end }) => ({ start, end })), [
    { start: "9", end: "12" },
  ]);

  const reapplied = manualDraftToPipeline(draft);
  assert.equal(reapplied.ok, true);
  assert.deepEqual(reapplied.pipeline.parse, {});
  assert.deepEqual(reapplied.pipeline.extract.settings.page_range, { start: 2, end: 6 });
  assert.deepEqual(reapplied.pipeline.split.parsing.settings.page_range, {
    start: 9,
    end: 12,
  });
});

test("an older shared bundled range keeps the same downstream priced pages after reapplication", async () => {
  const { manualDraftToPipeline, pipelineToManualDraft } = await loadManualPipeline();
  const { estimatePipeline, normalizeRequest } = await loadTypeScriptModule("../lib/pricing.ts");
  const imported = {
    parse: { settings: { page_range: { start: 2, end: 6 } } },
    extract: { settings: { deep_extract: false } },
    split: { settings: { deep_split: true } },
    lumos_assumptions: { estimated_extract_fields_per_page: 24 },
  };
  const reapplied = manualDraftToPipeline(pipelineToManualDraft(imported));
  assert.equal(reapplied.ok, true);

  const documents = [{ name: "room.pdf", pages: 20 }];
  const before = estimatePipeline(normalizeRequest({ documents, pipeline: imported }));
  const after = estimatePipeline(normalizeRequest({ documents, pipeline: reapplied.pipeline }));

  assert.deepEqual(
    {
      extractPages: after.extractPages,
      splitPages: after.splitPages,
      low: after.low,
      likely: after.likely,
      high: after.high,
    },
    {
      extractPages: before.extractPages,
      splitPages: before.splitPages,
      low: before.low,
      likely: before.likely,
      high: before.high,
    },
  );
});

test("an imported downstream Parse marker stays dormant without losing its saved configuration", async () => {
  const { manualDraftToPipeline, pipelineToManualDraft } = await loadManualPipeline();
  const configurations = {
    parse: {
      formatting: { table_output_format: "html" },
      settings: { page_range: { start: 2, end: 6 } },
    },
    classify: null,
    extract: { settings: { deep_extract: false } },
    split: null,
    edit: null,
  };
  const draft = pipelineToManualDraft(
    {
      parse: {},
      extract: { settings: { deep_extract: false, page_range: { start: 2, end: 6 } } },
      lumos_assumptions: { estimated_extract_fields_per_page: 12 },
    },
    configurations,
  );

  draft.extract.mode = "off";
  draft.classify.enabled = true;
  const dormant = manualDraftToPipeline(draft);
  assert.equal(dormant.ok, true);
  assert.equal(dormant.pipeline.parse, null);
  assert.equal(dormant.configurations.parse, null);
  assert.equal(draft.parse.includedDownstream, true);
  assert.deepEqual(draft.importedConfigurations.parse, configurations.parse);

  draft.extract.mode = "standard";
  const restored = manualDraftToPipeline(draft);
  assert.equal(restored.ok, true);
  assert.deepEqual(restored.pipeline.parse, {});
  assert.deepEqual(restored.configurations.parse, configurations.parse);
});

test("resolved imported exclusions clear while opaque exclusions remain", async () => {
  const { manualDraftToPipeline, pipelineToManualDraft } = await loadManualPipeline();
  const extractDraft = pipelineToManualDraft({
    extract: { settings: { include_images: true } },
    lumos_assumptions: {
      unpriced_cost_factors: [
        "extract.include_images",
        "extract.field_density",
        "customer.unpublished_feature",
      ],
    },
  });
  extractDraft.extract.includeImages = false;
  extractDraft.assumptions.extractFieldsPerPage = "24";

  const resolvedExtract = manualDraftToPipeline(extractDraft);
  assert.equal(resolvedExtract.ok, true);
  assert.deepEqual(resolvedExtract.pipeline.lumos_assumptions.unpriced_cost_factors, [
    "customer.unpublished_feature",
  ]);

  const chartDraft = pipelineToManualDraft({
    parse: {
      enhance: { agentic: [{ scope: "figure", advanced_chart_agent: true }] },
    },
    lumos_assumptions: {
      unpriced_cost_factors: ["parse.advanced_chart_count"],
    },
  });
  chartDraft.assumptions.chartCountsEnabled = true;
  chartDraft.assumptions.likelyChartCount = "2";
  chartDraft.assumptions.maximumChartCount = "4";

  const resolvedChart = manualDraftToPipeline(chartDraft);
  assert.equal(resolvedChart.ok, true);
  assert.equal(
    resolvedChart.pipeline.lumos_assumptions.unpriced_cost_factors,
    undefined,
  );
});

test("reviewing imported exclusions preserves incomplete estimate behavior", async () => {
  const { manualDraftToPipeline, pipelineToManualDraft } = await loadManualPipeline();
  const { estimatePipeline, normalizeRequest } = await loadTypeScriptModule("../lib/pricing.ts");
  const imported = {
    extract: {
      settings: {
        deep_extract: false,
        include_images: true,
      },
    },
    lumos_assumptions: {
      estimated_extract_fields_per_page: 101,
      unpriced_cost_factors: [
        "extract.include_images",
        "extract.field_density",
        "customer.contract_component",
      ],
    },
  };

  const reapplied = manualDraftToPipeline(pipelineToManualDraft(imported));
  assert.equal(reapplied.ok, true);
  const estimate = estimatePipeline(
    normalizeRequest({
      documents: [{ name: "room.pdf", pages: 5 }],
      pipeline: reapplied.pipeline,
    }),
  );

  assert.equal(estimate.estimateComplete, false);
  assert.deepEqual(estimate.unpricedCostFactors.sort(), [
    "customer.contract_component",
    "extract.field_density",
    "extract.include_images",
  ]);
});

test("an imported unbounded schema cannot become complete merely by opening and reapplying it", async () => {
  const { manualDraftToPipeline, pipelineToManualDraft } = await loadManualPipeline();
  const { estimatePipeline, normalizeRequest } = await loadTypeScriptModule("../lib/pricing.ts");
  const imported = {
    extract: { settings: { deep_extract: false } },
    lumos_assumptions: {
      estimated_extract_fields_per_page: 1,
      unpriced_cost_factors: ["extract.field_density"],
    },
  };

  const draft = pipelineToManualDraft(imported);
  assert.equal(draft.assumptions.extractFieldsPerPage, "");
  const reapplied = manualDraftToPipeline(draft);
  assert.equal(reapplied.ok, true);

  const estimate = estimatePipeline(
    normalizeRequest({
      documents: [{ name: "array-output.pdf", pages: 5 }],
      pipeline: reapplied.pipeline,
    }),
  );
  assert.equal(estimate.estimateComplete, false);
  assert.deepEqual(estimate.unpricedCostFactors, ["extract.field_density"]);
});

test("bundled nested Parse scopes hydrate while the original endpoint config remains intact", async () => {
  const { manualDraftToPipeline, pipelineToManualDraft } = await loadManualPipeline();
  const configurations = {
    parse: null,
    classify: null,
    extract: {
      instructions: { schema: { type: "object", properties: { Name: { type: "string" } } } },
      parsing: {
        enhance: {
          agentic: [
            { scope: "figure", advanced_chart_agent: true },
            { scope: "table", mode: "auto", prompt: "Read every table" },
          ],
        },
      },
      settings: { deep_extract: false },
    },
    split: null,
    edit: null,
  };
  const pipeline = {
    parse: {},
    extract: { settings: { deep_extract: false } },
    lumos_assumptions: { estimated_extract_fields_per_page: 1 },
  };

  const draft = pipelineToManualDraft(pipeline, configurations);
  assert.equal(draft.parse.enabled, false);
  assert.equal(draft.parse.includedDownstream, true);
  assert.equal(draft.parse.mode, "agentic");
  assert.deepEqual(draft.parse.agenticScopes, { text: false, table: true, figure: true });
  assert.equal(draft.parse.advancedChart, true);

  const reapplied = manualDraftToPipeline(draft);
  assert.equal(reapplied.ok, true);
  assert.deepEqual(
    reapplied.configurations.extract.parsing.enhance.agentic,
    configurations.extract.parsing.enhance.agentic,
  );
  assert.deepEqual(reapplied.pipeline.parse, {});

  draft.parse.mode = "standard";
  draft.parse.advancedChart = false;
  draft.parse.agenticScopes = { text: false, table: false, figure: false };
  const disabled = manualDraftToPipeline(draft);
  assert.equal(disabled.ok, true);
  assert.deepEqual(disabled.configurations.extract.parsing.enhance.agentic, []);
});

test("review preserves duplicate agentic entries, explicit auto priority, and __proto__ schema fields", async () => {
  const { manualDraftToPipeline, pipelineToManualDraft } = await loadManualPipeline();
  const extractConfig = JSON.parse(`{
    "instructions": {
      "schema": {
        "type": "object",
        "properties": {"__proto__": {"type": "string"}}
      }
    },
    "settings": {"deep_extract": false}
  }`);
  const configurations = {
    parse: {
      enhance: {
        agentic: [
          { scope: "text", prompt: "First pass" },
          { scope: "text", mode: "auto", prompt: "Second pass" },
        ],
      },
      queue_priority: "auto",
    },
    classify: null,
    extract: extractConfig,
    split: null,
    edit: null,
  };
  const pipeline = {
    parse: { enhance: { agentic: [{ scope: "text" }, { scope: "text", mode: "auto" }] } },
    lumos_assumptions: { likely_complex_parse_share: 0.5 },
  };

  const standaloneDraft = pipelineToManualDraft(pipeline, {
    ...configurations,
    extract: null,
  });
  const standalone = manualDraftToPipeline(standaloneDraft);
  assert.equal(standalone.ok, true);
  assert.equal(standalone.configurations.parse.queue_priority, "auto");
  assert.deepEqual(
    standalone.configurations.parse.enhance.agentic.map((entry) => entry.prompt),
    ["First pass", "Second pass"],
  );

  const extractDraft = pipelineToManualDraft(
    {
      extract: { settings: { deep_extract: false } },
      lumos_assumptions: { estimated_extract_fields_per_page: 1 },
    },
    { ...configurations, parse: null },
  );
  const extract = manualDraftToPipeline(extractDraft);
  assert.equal(extract.ok, true);
  const properties = extract.configurations.extract.instructions.schema.properties;
  assert.equal(Object.hasOwn(properties, "__proto__"), true);
  assert.deepEqual(properties.__proto__, { type: "string" });
});

test("legacy Advanced Chart aliases remain incomplete after review and reapplication", async () => {
  const { manualDraftToPipeline, pipelineToManualDraft } = await loadManualPipeline();
  const { estimatePipeline, normalizeRequest } = await loadTypeScriptModule("../lib/pricing.ts");
  const configurations = {
    parse: {
      enhance: { agentic: [{ scope: "figure", chart_agent: true }] },
    },
    classify: null,
    extract: null,
    split: null,
    edit: null,
  };
  const pipeline = {
    parse: {
      enhance: { agentic: [{ scope: "figure", advanced_chart_agent: true }] },
    },
    lumos_assumptions: {
      likely_complex_parse_share: 0.5,
      unpriced_cost_factors: ["parse.advanced_chart_count"],
    },
  };

  const draft = pipelineToManualDraft(pipeline, configurations);
  assert.equal(draft.parse.enabled, true);
  assert.equal(draft.parse.includedDownstream, false);
  assert.equal(draft.parse.advancedChart, true);
  const reapplied = manualDraftToPipeline(draft);
  assert.equal(reapplied.ok, true);
  assert.equal(
    reapplied.pipeline.parse.enhance.agentic.some(
      (entry) => entry.scope === "figure" && entry.advanced_chart_agent === true,
    ),
    true,
  );
  const estimate = estimatePipeline(
    normalizeRequest({
      documents: [{ name: "charts.pdf", pages: 5 }],
      pipeline: reapplied.pipeline,
    }),
  );
  assert.equal(estimate.estimateComplete, false);
  assert.deepEqual(estimate.unpricedCostFactors, ["parse.advanced_chart_count"]);

  const topLevelDraft = pipelineToManualDraft(
    {
      parse: {
        enhance: {
          agentic: [
            { scope: "text" },
            { scope: "figure", advanced_chart_agent: true },
          ],
        },
      },
      lumos_assumptions: {
        likely_complex_parse_share: 0.5,
        unpriced_cost_factors: ["parse.advanced_chart_count"],
      },
    },
    {
      parse: {
        enhance: {
          agentic: [{ scope: "text" }],
          advanced_chart_agent: true,
        },
      },
      classify: null,
      extract: null,
      split: null,
      edit: null,
    },
  );
  assert.equal(topLevelDraft.parse.advancedChart, true);
  assert.equal(topLevelDraft.parse.agenticScopes.figure, true);
  const topLevelReapplied = manualDraftToPipeline(topLevelDraft);
  assert.equal(topLevelReapplied.ok, true);
  const topLevelEstimate = estimatePipeline(
    normalizeRequest({
      documents: [{ name: "top-level-chart.pdf", pages: 5 }],
      pipeline: topLevelReapplied.pipeline,
    }),
  );
  assert.equal(topLevelEstimate.estimateComplete, false);
  assert.deepEqual(topLevelEstimate.unpricedCostFactors, ["parse.advanced_chart_count"]);

  topLevelDraft.parse.mode = "standard";
  topLevelDraft.parse.agenticScopes = { text: false, table: false, figure: false };
  topLevelDraft.parse.advancedChart = false;
  const topLevelDisabled = manualDraftToPipeline(topLevelDraft);
  assert.equal(topLevelDisabled.ok, true);
  assert.deepEqual(topLevelDisabled.configurations.parse.enhance.agentic, []);
  assert.equal(
    Object.hasOwn(topLevelDisabled.configurations.parse.enhance, "advanced_chart_agent"),
    false,
  );
});

test("unchanged divergent nested Parse configs and bundled auto priority remain owner-local", async () => {
  const { manualDraftToPipeline, pipelineToManualDraft } = await loadManualPipeline();
  const configurations = {
    parse: { queue_priority: "auto" },
    classify: null,
    extract: {
      parsing: { enhance: { agentic: [{ scope: "text", prompt: "Extract text" }] } },
      settings: { deep_extract: false },
    },
    split: {
      parsing: { enhance: { agentic: [{ scope: "figure", prompt: "Split figures" }] } },
      settings: { deep_split: false },
    },
    edit: null,
  };
  const pipeline = {
    parse: {},
    extract: { settings: { deep_extract: false } },
    split: { settings: { deep_split: false } },
    lumos_assumptions: { estimated_extract_fields_per_page: 10 },
  };

  const draft = pipelineToManualDraft(pipeline, configurations);
  assert.equal(draft.parse.enabled, false);
  assert.equal(draft.parse.includedDownstream, true);
  const reapplied = manualDraftToPipeline(draft);
  assert.equal(reapplied.ok, true);
  assert.equal(reapplied.configurations.parse.queue_priority, "auto");
  assert.deepEqual(
    reapplied.configurations.extract.parsing.enhance.agentic,
    configurations.extract.parsing.enhance.agentic,
  );
  assert.deepEqual(
    reapplied.configurations.split.parsing.enhance.agentic,
    configurations.split.parsing.enhance.agentic,
  );
});
