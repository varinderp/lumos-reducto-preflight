import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function request(path = "/", init = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html", host: "lumos.example", ...init.headers },
      ...init,
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

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

const SOLUTION_PARAGRAPHS = [
  "Lumos estimates the cost of a Reducto job before it runs by looking at the document, how it will be processed, and the applicable Reducto pricing.",
  "When the cost can be determined upfront, Lumos returns a single estimate. When part of the cost depends on what Reducto discovers during processing, or on a processing path that has not yet been chosen, Lumos returns a low, likely, and high estimate. If any part of the price cannot be calculated, Lumos still shows the known cost and clearly identifies what is excluded.",
  "Lumos does not run the Reducto pipeline to create an estimate, so no Reducto processing fee is incurred. In the simulator, document details are read locally in your browser. Through the API, your application can send the same information directly.",
  "With the estimate available before processing begins, teams can add an approve-or-stop check to their workflow, helping protect budgets and make costs more predictable for both the business and its users.",
];

const REPLACED_SOLUTION_FRAGMENTS = [
  "Lumos combines document metadata, such as file type and page count",
  "Lumos returns one estimate when the configured processing mode is fixed",
  "Reducto determines the Standard and Complex page mix during processing",
  "With the estimate available early, teams can add an approve-or-stop check to their business logic",
];

const RATE_CARD_DEFAULTS = {
  parseStandard: "15",
  parseComplex: "30",
  advancedChart: "0.06",
  classify: "7.5",
  extract: "20",
  deepExtract: "40",
  split: "20",
  deepSplit: "40",
  edit: "60",
  editPrefilled: "15",
};

function extractSolutionParagraphs(content, figureMarker) {
  const start = content.indexOf("<h2>Solution</h2>");
  const end = content.indexOf(figureMarker, start);
  assert.notEqual(start, -1, "Solution heading is present");
  assert.notEqual(end, -1, "Solution figure is preserved");

  return [...content.slice(start, end).matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g)].map(
    ([, paragraph]) =>
      paragraph
        .replace(/<[^>]+>/g, "")
        .replaceAll("&apos;", "'")
        .replaceAll("&#x27;", "'")
        .replaceAll("&amp;", "&")
        .replace(/\s+/g, " ")
        .trim(),
  );
}

function assertClose(actual, expected, label) {
  assert.ok(
    Math.abs(actual - expected) < 1e-12,
    `${label}: expected ${expected}, received ${actual}`,
  );
}

test("server-renders the Lumos simulator and API", async () => {
  const response = await request();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /Lumos/);
  assert.match(html, /Estimate Reducto costs before processing begins\./);
  assert.match(html, /<h2>Problem<\/h2>/);
  assert.doesNotMatch(html, /href="#problem"/);
  assert.match(html, /Reducto turns unstructured documents into structured, usable data/);
  assert.match(html, /amount of work, the endpoints and configurations used/);
  assert.match(html, /help teams use resources more efficiently and transparently/);
  assert.match(html, /href="\/waiver-redacted\.png"/);
  assert.match(html, /<strong>protect budgets<\/strong>/);
  assert.match(html, /<sup class="evidence-marker">1<\/sup>/);
  assert.match(html, /aria-describedby="budget-evidence-note"/);
  assert.match(
    html,
    /<p id="budget-evidence-note" class="evidence-footnote"><sup>1<\/sup> Actual screenshot from 2025 requesting a refund due to overusage\.<\/p>/,
  );
  assert.ok(
    html.indexOf('id="budget-evidence-note"') < html.indexOf("<h2>Solution</h2>"),
    "the screenshot note appears before Solution",
  );
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /id="budget-example"/);
  assert.match(html, /Unexpected usage and waiver request/);
  assert.match(html, /aria-describedby="budget-example-description"/);
  assert.doesNotMatch(html, /may classify each document and route different document categories/);
  assert.deepEqual(
    extractSolutionParagraphs(html, '<figure class="solution-figure">'),
    SOLUTION_PARAGRAPHS,
  );
  for (const fragment of REPLACED_SOLUTION_FRAGMENTS) {
    assert.doesNotMatch(html, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(html, /reducto-lumos\.jpg/);
  assert.match(html, /How to use/);
  assert.doesNotMatch(html, /After processing, Reducto returns billing tags/);
  assert.doesNotMatch(html, /billable_spreadsheet_pages|docx_native_page|chart_agent/);
  assert.match(html, /Set up manually/);
  for (const endpoint of ["parse", "classify", "extract", "split", "edit"]) {
    assert.match(
      html,
      new RegExp(
        `role="tab" id="${endpoint}-endpoint-tab" aria-controls="${endpoint}-endpoint-panel"`,
      ),
    );
  }
  assert.match(html, /aria-label="Reducto endpoints" aria-orientation="horizontal"/);
  assert.match(html, /id="extract-endpoint-tab"[^>]*aria-selected="true"/);
  assert.match(html, /<span>Extract<\/span><small class="endpoint-tab-status on">On<\/small>/);
  assert.match(html, /<span>Parse \(standalone\)<\/span><small class="endpoint-tab-status">Off<\/small>/);
  assert.match(html, /class="pipeline-configurator"/);
  assert.match(html, /class="endpoint-panel-scroll"/);
  assert.doesNotMatch(html, /<h5>Reducto settings<\/h5>|<h5>Lumos assumptions<\/h5>/);
  assert.match(html, /<h5>Additional inputs<\/h5>/);
  assert.match(html, /<footer class="configurator-footer">[\s\S]*?Apply configuration[\s\S]*?<\/footer>/);
  assert.doesNotMatch(html, /builder-step-[1-6]|Endpoint path|Processing mode|Amount processed|Pricing settings/);
  assert.match(html, />Page Range</);
  assert.doesNotMatch(html, /Shared pages to process|shares that range|using the selected Parse pages/);
  assert.match(html, />Simulator</);
  assert.match(html, />API</);
  const simulatorStart = html.indexOf('<section id="simulator">');
  const apiStart = html.indexOf('<section id="api">', simulatorStart);
  assert.ok(simulatorStart > -1 && apiStart > simulatorStart);
  const simulatorHtml = html.slice(simulatorStart, apiStart);
  const renderedApiHtml = html.slice(apiStart, html.indexOf('<section id="verify">', apiStart));
  assert.doesNotMatch(renderedApiHtml, /canonical/i);
  const simulatorHeadings = [
    "<h3>1. Documents</h3>",
    "<h3>2. Pipeline configuration</h3>",
    "<h3>3. Policy</h3>",
    "<h3>4. Estimate</h3>",
  ];
  let priorHeading = -1;
  for (const heading of simulatorHeadings) {
    const headingIndex = simulatorHtml.indexOf(heading);
    assert.ok(headingIndex > priorHeading, `${heading} appears in order`);
    priorHeading = headingIndex;
  }
  assert.doesNotMatch(
    simulatorHtml,
    /The simulator keeps your files and estimates|Spreadsheet calculations are currently unsupported/,
  );
  assert.match(html, /Awaiting documents/);
  assert.match(html, />or try an example</);
  assert.doesNotMatch(html, /Load 15-document example/);
  assert.match(html, /<h3>4\. Estimate<\/h3>[\s\S]*?Apply a pipeline configuration to estimate these documents/);
  assert.doesNotMatch(html, /Default rate card \(custom\)/);
  const policyStart = simulatorHtml.indexOf("<h3>3. Policy</h3>");
  const estimateStart = simulatorHtml.indexOf("<h3>4. Estimate</h3>", policyStart);
  const policyHtml = simulatorHtml.slice(policyStart, estimateStart);
  const estimateHtml = simulatorHtml.slice(estimateStart);
  assert.match(policyHtml, /Maximum cost, USD/);
  assert.match(policyHtml, /aria-haspopup="dialog"/);
  assert.match(policyHtml, />Default rate card<\/button>/);
  assert.doesNotMatch(estimateHtml, /aria-controls="rate-card-dialog"/);
  assert.equal(simulatorHtml.match(/aria-controls="rate-card-dialog"/g)?.length, 1);
  assert.match(html, /<dialog id="rate-card-dialog"/);
  assert.match(html, /aria-labelledby="rate-card-title"/);
  assert.match(html, /aria-describedby="rate-card-description"/);
  assert.match(html, /id="rate-card-title">Default rate card<\/h3>/);
  assert.match(
    html,
    /Modifications to the default rates below affect the simulator only and remain in\s+this browser session\./,
  );
  for (const [key, value] of Object.entries(RATE_CARD_DEFAULTS)) {
    const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(html, new RegExp(`id="rate-${key}"[^>]*value="${escapedValue}"`));
  }
  for (const label of [
    "Standard Parse",
    "Complex Parse",
    "Advanced Chart",
    "Classify",
    "Standard Extract",
    "Deep Extract",
    "Split",
    "Deep Split",
    "Edit",
    "Fully prefilled Edit",
  ]) {
    assert.match(html, new RegExp(`>${label}<`));
  }
  assert.match(html, /Agentic Parse[\s\S]*?2[\s\S]*?×/);
  assert.match(html, /Latency priority[\s\S]*?2[\s\S]*?×/);
  assert.match(html, /Batch Parse[\s\S]*?20[\s\S]*?% discount/);
  assert.match(html, /aria-label="Close rate card"/);
  assert.match(html, />Reset to public rates<\/button>/);
  assert.match(html, />\s*Cancel\s*<\/button>/);
  assert.match(html, />Apply rates<\/button>/);
  assert.match(html, /<h3>2\. Pipeline configuration<\/h3>/);
  assert.match(html, /Set up manually/);
  assert.match(html, /Import from Reducto/);
  assert.match(
    html,
    /Use Reducto-style settings to build the estimate configuration, or import the JSON from\s+your Reducto pipeline\./,
  );
  assert.match(
    html,
    /Standard Extract is selected as an example\. Apply the configuration to use it\./,
  );
  assert.match(html, />Apply configuration<\/button>/);
  assert.match(html, /Apply a pipeline configuration to estimate these documents/);
  assert.doesNotMatch(html, /Apply a pipeline configuration to generate the request and response/);
  assert.doesNotMatch(html, /<button[^>]*>\s*Copy Lumos profile\s*<\/button>/);
  assert.doesNotMatch(html, /View this simulator(?:&#x27;|&apos;|’|')s API request and response/);
  assert.match(html, /<h3><code>POST (?:<!-- -->)?\/api\/estimate<\/code><\/h3>/);
  assert.doesNotMatch(html, /<h3>Configure once<\/h3>|<h3>For each upload<\/h3>|<h3>Handle the result<\/h3>/);
  assert.doesNotMatch(html, /Build or import the pricing configuration|Store that JSON in your application/);
  assert.match(html, /<th>Request field<\/th>[\s\S]*?<th>Use<\/th>/);
  assert.match(
    html,
    /<code>documents<\/code>[\s\S]*?Required\. An array of document <strong>metadata<\/strong> \(<code>name<\/code>, <code>pages<\/code>\)\.\s*Do not send file contents\.[\s\S]*?<\/tr>/i,
  );
  assert.match(
    html,
    /<code>pipeline<\/code>[\s\S]*?Required\. The Lumos profile generated by the simulator, whether the configuration was created manually or imported from Reducto\.[\s\S]*?<\/tr>/i,
  );
  assert.match(
    html,
    /<code>policy\.max_total_usd<\/code>[\s\S]*?Optional\. Maximum acceptable job cost in USD\. Defaults to <code>10<\/code>\.[\s\S]*?<\/tr>/i,
  );
  assert.doesNotMatch(html, /Required\. Original filenames and page counts\./);
  assert.doesNotMatch(html, /Required\. The copied Lumos profile, stored by your application\./);
  assert.match(html, /const documents = \[[\s\S]*?name: &quot;agreement\.pdf&quot;,[\s\S]*?pages: 42/);
  assert.match(html, /const pipeline = await loadSavedLumosProfile\(\)/);
  assert.doesNotMatch(html, /Lumos receives metadata, not files/i);
  assert.match(html, /estimate[\s\S]*?breakdown[\s\S]*?usage[\s\S]*?<code>allow<\/code>[\s\S]*?<code>review<\/code>[\s\S]*?<code>deny<\/code>/i);
  assert.match(html, /authenticated server-to-server integration/);
  assert.match(html, /Verify with Reducto/);
  assert.match(html, /Created by/);
  assert.match(html, /varindersaini\.com/);
  assert.match(html, /v0\.1\.31/);
  assert.doesNotMatch(html, />Paste Reducto JSON config</);
  assert.match(html, /<footer>[\s\S]*?Sources:/);
  assert.doesNotMatch(html, /<footer>[\s\S]*?Lumos uses Reducto/);
  assert.doesNotMatch(html, /<footer>[\s\S]*?your own rate card/);
  assert.match(html, /href="https:\/\/docs\.reducto\.ai\/reference\/credit-usage">pricing<\/a>/);
  assert.match(html, /href="https:\/\/docs\.reducto\.ai\/reference\/page-billing-breakdown">billing breakdown<\/a>/);
  assert.match(html, /href="https:\/\/docs\.reducto\.ai\/workflows\/pipeline-basics">pipeline basics<\/a>/);
  assert.doesNotMatch(html, /Lumos cost profile, not a Reducto request body/);
  assert.doesNotMatch(html, /Lumos inputs, not Reducto request fields/);
  assert.doesNotMatch(html, /Your site is taking shape|codex-preview/);
  await access(new URL("../public/waiver-redacted.png", import.meta.url));
  await assert.rejects(access(new URL("../public/waiver.png", import.meta.url)));
});

test("pricing exports the ten public unit rates and keeps fixed rules separate", async () => {
  const {
    DEFAULT_PRICING_UNIT_RATES,
    FIXED_PRICING_RULES,
    estimatePipeline,
    normalizeRequest,
  } = await importTypeScriptModule("../lib/pricing.ts");

  assert.deepEqual(DEFAULT_PRICING_UNIT_RATES, {
    parseStandard: 0.015,
    parseComplex: 0.03,
    advancedChart: 0.06,
    classify: 0.0075,
    extract: 0.02,
    deepExtract: 0.04,
    split: 0.02,
    deepSplit: 0.04,
    edit: 0.06,
    editPrefilled: 0.015,
  });
  assert.equal(Object.keys(DEFAULT_PRICING_UNIT_RATES).length, 10);
  assert.equal(Object.isFrozen(DEFAULT_PRICING_UNIT_RATES), true);
  assert.deepEqual(FIXED_PRICING_RULES, {
    agenticParseMultiplier: 2,
    extractLatencyMultiplier: 2,
    batchParseDiscount: 0.2,
  });
  assert.equal(Object.isFrozen(FIXED_PRICING_RULES), true);

  const defaultInput = normalizeRequest({
    documents: [{ name: "contract.pdf", pages: 10 }],
    pipeline: {
      extract: { settings: { deep_extract: false } },
      lumos_assumptions: { estimated_extract_fields_per_page: 1 },
    },
  });
  assert.deepEqual(
    estimatePipeline(defaultInput),
    estimatePipeline(defaultInput, DEFAULT_PRICING_UNIT_RATES),
  );

  const agenticBatchInput = normalizeRequest({
    documents: [{ name: "charts.pdf", pages: 10 }],
    pipeline: {
      parse: {
        enhance: { agentic: [{ scope: "text" }] },
        queue_priority: "batch",
      },
    },
  });
  assert.equal(
    agenticBatchInput.pipeline.parseCostMultiplier,
    FIXED_PRICING_RULES.agenticParseMultiplier,
  );
  assert.equal(
    agenticBatchInput.pipeline.parseBatchDiscount,
    FIXED_PRICING_RULES.batchParseDiscount,
  );

  const latencyInput = normalizeRequest({
    documents: [{ name: "contract.pdf", pages: 10 }],
    pipeline: {
      extract: { settings: { optimize_for_latency: true } },
      lumos_assumptions: { estimated_extract_fields_per_page: 1 },
    },
  });
  assert.equal(
    latencyInput.pipeline.extractCostMultiplier,
    FIXED_PRICING_RULES.extractLatencyMultiplier,
  );
});

test("Lumos profile copying serializes only the canonical pipeline", async () => {
  const { serializeLumosProfile } = await importTypeScriptModule("../lib/profile-copy.ts");
  const pipeline = {
    parse: null,
    classify: { page_range: { start: 1, end: 5 } },
    extract: { settings: { deep_extract: true } },
    split: null,
    edit: {},
    lumos_assumptions: { estimated_extract_fields_per_page: 24 },
  };

  const copied = serializeLumosProfile(pipeline);
  assert.equal(copied, JSON.stringify(pipeline, null, 2));
  assert.deepEqual(JSON.parse(copied), pipeline);
  assert.doesNotMatch(copied, /documents|max_total_usd|rate_card|pipeline_id/);
});

test("custom simulator rates affect every editable pricing product", async () => {
  const { DEFAULT_PRICING_UNIT_RATES, estimatePipeline, normalizeRequest } =
    await importTypeScriptModule("../lib/pricing.ts");
  const rates = {
    parseStandard: 0.101,
    parseComplex: 0.202,
    advancedChart: 0.909,
    classify: 1.01,
    extract: 0.303,
    deepExtract: 0.404,
    split: 0.505,
    deepSplit: 0.606,
    edit: 0.808,
    editPrefilled: 0.707,
  };

  const parseInput = normalizeRequest({
    documents: [{ name: "charts.pdf", pages: 10 }],
    pipeline: {
      parse: {
        enhance: {
          agentic: [{ scope: "figure", advanced_chart_agent: true }],
        },
      },
      lumos_assumptions: {
        likely_complex_parse_share: 0.25,
        advanced_chart_counts: { likely: 2, maximum: 3 },
      },
    },
  });
  const parseEstimate = estimatePipeline(parseInput, rates);
  assertClose(parseEstimate.parseLow, 10 * rates.parseStandard * 2, "Standard Parse");
  assertClose(
    parseEstimate.parseLikely,
    10 * (0.75 * rates.parseStandard + 0.25 * rates.parseComplex) * 2 +
      2 * rates.advancedChart,
    "likely Parse and chart rates",
  );
  assertClose(
    parseEstimate.parseHigh,
    10 * rates.parseComplex * 2 + 3 * rates.advancedChart,
    "Complex Parse and chart rates",
  );

  const classifyInput = normalizeRequest({
    documents: [{ name: "contract.pdf", pages: 10 }],
    pipeline: { classify: { page_range: { start: 1, end: 4 } } },
  });
  assertClose(
    estimatePipeline(classifyInput, rates).classifyCost,
    4 * rates.classify,
    "Classify",
  );

  const conditionalExtractInput = normalizeRequest({
    documents: [{ name: "contract.pdf", pages: 10 }],
    pipeline: {
      extract: { settings: { deep_extract: false } },
      lumos_assumptions: {
        conditional_extract_routing: true,
        likely_deep_extract_share: 0.25,
        estimated_extract_fields_per_page: 1,
      },
    },
  });
  const conditionalExtractEstimate = estimatePipeline(conditionalExtractInput, rates);
  assertClose(
    conditionalExtractEstimate.extractLow,
    10 * rates.extract,
    "Standard Extract",
  );
  assertClose(
    conditionalExtractEstimate.extractLikely,
    10 * (0.75 * rates.extract + 0.25 * rates.deepExtract),
    "conditional Extract",
  );
  assertClose(
    conditionalExtractEstimate.extractHigh,
    10 * rates.deepExtract,
    "Deep Extract",
  );

  const standardSplitInput = normalizeRequest({
    documents: [{ name: "packet.pdf", pages: 10 }],
    pipeline: { split: { settings: { deep_split: false } } },
    policy: { max_total_usd: 1 },
  });
  const standardSplitEstimate = estimatePipeline(standardSplitInput, rates);
  assertClose(standardSplitEstimate.splitCost, 10 * rates.split, "Split");
  assert.equal(estimatePipeline(standardSplitInput, DEFAULT_PRICING_UNIT_RATES).decision, "allow");
  assert.equal(standardSplitEstimate.decision, "deny");

  const deepSplitInput = normalizeRequest({
    documents: [{ name: "packet.pdf", pages: 10 }],
    pipeline: { split: { settings: { deep_split: true } } },
  });
  assertClose(
    estimatePipeline(deepSplitInput, rates).splitCost,
    10 * rates.deepSplit,
    "Deep Split",
  );

  const editInput = normalizeRequest({
    documents: [{ name: "form.pdf", pages: 10 }],
    pipeline: {
      edit: {},
      lumos_assumptions: { known_fully_prefilled_edit_pages: 4 },
    },
  });
  assertClose(
    estimatePipeline(editInput, rates).editCost,
    4 * rates.editPrefilled + 6 * rates.edit,
    "Edit and fully prefilled Edit",
  );
});

test("public estimate API rejects simulator-only rate-card fields", async () => {
  for (const field of ["rate_card", "pricing_unit_rates"]) {
    const response = await request("/api/estimate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        documents: [{ name: "contract.pdf", pages: 10 }],
        pipeline: { extract: { settings: { deep_extract: false } } },
        [field]: RATE_CARD_DEFAULTS,
      }),
    });
    assert.equal(response.status, 400, field);
    assert.match((await response.json()).error, new RegExp(`unsupported field: ${field}`, "i"));
  }
});

test("estimate API returns a conditional range and policy decision", async () => {
  const response = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documents: [{ name: "contract.pdf", pages: 18, assumed_extract_route: "unknown" }],
      pipeline: {
        classify: { page_range: { start: 1, end: 5 } },
        extract: { settings: { deep_extract: false } },
        lumos_assumptions: {
          conditional_extract_routing: true,
          likely_deep_extract_share: 0.27,
          estimated_extract_fields_per_page: 24,
        },
      },
      policy: { max_total_usd: 1 },
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.decision, "allow");
  assert.equal(result.estimate.low_usd, 0.3975);
  assert.equal(result.estimate.high_usd, 0.7575);
  assert.equal(result.has_range, true);
});

test("external API preserves optional per-document Extract route assumptions", async () => {
  const pipeline = {
    extract: { settings: { deep_extract: false } },
    lumos_assumptions: {
      conditional_extract_routing: true,
      likely_deep_extract_share: 0.5,
      estimated_extract_fields_per_page: 24,
    },
  };

  const estimateForRoute = async (assumedExtractRoute) => {
    const response = await request("/api/estimate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        documents: [
          {
            name: "contract.pdf",
            pages: 10,
            ...(assumedExtractRoute === undefined
              ? {}
              : { assumed_extract_route: assumedExtractRoute }),
          },
        ],
        pipeline,
      }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };

  const unknown = await estimateForRoute(undefined);
  assert.deepEqual(unknown.estimate, {
    low_usd: 0.2,
    likely_usd: 0.3,
    high_usd: 0.4,
    currency: "USD",
  });
  assert.equal(unknown.has_range, true);

  const standard = await estimateForRoute("standard");
  assert.equal(standard.estimate.low_usd, 0.2);
  assert.equal(standard.estimate.likely_usd, 0.2);
  assert.equal(standard.estimate.high_usd, 0.2);
  assert.equal(standard.has_range, false);

  const deep = await estimateForRoute("deep");
  assert.equal(deep.estimate.low_usd, 0.4);
  assert.equal(deep.estimate.likely_usd, 0.4);
  assert.equal(deep.estimate.high_usd, 0.4);
  assert.equal(deep.has_range, false);
});

test("source keeps the exact Solution copy and removes its predecessor", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.deepEqual(
    extractSolutionParagraphs(source, '<figure className="solution-figure">'),
    SOLUTION_PARAGRAPHS,
  );
  for (const fragment of REPLACED_SOLUTION_FRAGMENTS) {
    assert.equal(source.includes(fragment), false, fragment);
  }
  assert.match(source, /href=\{appPath\("\/reducto-lumos\.jpg"\)\}/);
  assert.match(source, /src=\{appPath\("\/reducto-lumos\.jpg"\)\}/);
});

test("budget evidence uses a numbered marker and note before Solution", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(source, /<strong>protect budgets<\/strong>\s*<sup className="evidence-marker">1<\/sup>/);
  assert.match(source, /aria-describedby="budget-evidence-note"/);
  assert.ok(
    source.indexOf('id="budget-evidence-note"') < source.indexOf("<h2>Solution</h2>"),
  );
  assert.match(styles, /\.evidence-marker\s*\{/);
  assert.match(styles, /\.evidence-footnote\s*\{/);
});

test("rate-card source preserves drafts, accessibility, used marks, and API isolation", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const compactSource = source.replace(/\s+/g, " ");
  const apiRequestStart = source.indexOf("const apiRequest = useMemo");
  const apiResponseStart = source.indexOf("const apiResponse = useMemo", apiRequestStart);
  assert.notEqual(apiRequestStart, -1);
  assert.notEqual(apiResponseStart, -1);
  const apiRequestSource = source.slice(apiRequestStart, apiResponseStart);

  assert.match(source, /DEFAULT_PRICING_UNIT_RATES/);
  assert.match(source, /FIXED_PRICING_RULES/);
  assert.match(source, /estimatePipeline\(normalized, appliedRates\)/);
  assert.match(source, /estimatePipeline\(normalized\)/);
  assert.match(
    source,
    /const apiEstimate = isCustomRateCard \? publicEstimateResult\.estimate : estimate/,
  );
  assert.match(
    source,
    /RATE_FIELD_KEYS\.every\(\(key\) => left\[key\] === right\[key\]\)/,
  );
  assert.doesNotMatch(source, /Math\.abs\(left\[key\] - right\[key\]\)/);
  assert.doesNotMatch(apiRequestSource, /appliedRates|rateDraft|pricing_unit_rates|rate_card/);
  assert.match(
    source,
    /The API preview uses public rates; simulator rate edits are excluded\./,
  );
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie/);

  assert.ok(
    compactSource.includes(
      'className="rate-card-link" aria-haspopup="dialog" aria-controls="rate-card-dialog"',
    ),
  );
  assert.ok(
    compactSource.includes(
      '{isCustomRateCard ? "Default rate card (custom)" : "Default rate card"}',
    ),
  );
  const policyStart = source.indexOf("<h3>3. Policy</h3>");
  const estimateStart = source.indexOf("<h3>4. Estimate</h3>", policyStart);
  assert.ok(policyStart > -1 && estimateStart > policyStart);
  const policySource = source.slice(policyStart, estimateStart);
  assert.match(policySource, /Maximum cost, USD/);
  assert.match(
    policySource,
    /<button[\s\S]*?className="rate-card-link"[\s\S]*?Default rate card[\s\S]*?<\/button>/,
  );
  assert.doesNotMatch(source.slice(estimateStart), /<h3>4\. Estimate<\/h3>[\s\S]*?aria-controls="rate-card-dialog"/);
  assert.equal(source.match(/className="rate-card-link"/g)?.length, 1);
  const scrollStart = source.indexOf('className="endpoint-panel-scroll"');
  const footerStart = source.indexOf('className="configurator-footer"');
  const applyStart = source.indexOf("Apply configuration", footerStart);
  const rateControlStart = source.indexOf('className="rate-card-link"', applyStart);
  assert.ok(scrollStart < footerStart && footerStart < applyStart && applyStart < rateControlStart);
  const configuratorFooter = source.slice(
    footerStart,
    source.indexOf("</footer>", footerStart) + "</footer>".length,
  );
  assert.match(configuratorFooter, />Apply configuration<\/button>/);
  assert.doesNotMatch(configuratorFooter, /Default rate card|rate-card-control|Status|Public\/default/);
  assert.match(styles, /\.pipeline-configurator\s*\{[\s\S]*?overflow:\s*hidden/);
  const endpointScrollRule = styles.match(/\.endpoint-panel-scroll\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  assert.match(endpointScrollRule, /overflow-y:\s*auto/);
  assert.doesNotMatch(endpointScrollRule, /overscroll-behavior:\s*contain/);
  assert.match(styles, /\.configurator-footer\s*\{[\s\S]*?flex:\s*0 0 auto/);
  assert.match(
    source,
    /Modifications to the default rates below affect the simulator only and remain in\s+this browser session\./,
  );
  assert.match(source, /<dialog[\s\S]*?id="rate-card-dialog"/);
  assert.match(source, /aria-labelledby="rate-card-title"/);
  assert.match(source, /aria-describedby="rate-card-description"/);
  assert.match(source, /aria-label="Close rate card"/);
  assert.match(source, /dialog\.addEventListener\("click", closeOnBackdrop\)/);
  assert.match(source, /if \(event\.target === dialog\) dialog\.close\(\)/);
  assert.match(source, /event\.key === "Escape"[\s\S]*?event\.currentTarget\.close\(\)/);
  assert.match(source, /function openRateCard\(\)[\s\S]*?setRateDraft\(\{ \.\.\.appliedRateDraft \}\)/);
  assert.match(source, /rateCardBody\.current\.scrollTop = 0/);
  assert.match(source, /function applyRateCard\(\)[\s\S]*?setAppliedRates\(\{ \.\.\.validation\.rates \}\)/);
  assert.match(source, /setAppliedRateDraft\(normalizedDraft\)/);
  assert.match(source, /displayValue > MAX_DISPLAY_RATE/);
  assert.match(source, /displayValue > 0 && unitRate === 0/);
  assert.match(
    source,
    /Reset to public rates[\s\S]*?Cancel[\s\S]*?Apply rates/,
  );
  assert.match(
    source,
    /function clearSession\(\)[\s\S]*?dialog\?\.open[\s\S]*?setAppliedRates\(\{ \.\.\.DEFAULT_PRICING_UNIT_RATES \}\)/,
  );
  assert.match(source, /role="alert"[\s\S]*?Review the highlighted rate card values/);
  assert.match(source, /className="used-label">Used<\/span>/);
  assert.match(source, /rates\.add\("parseStandard"\)[\s\S]*?rates\.add\("parseComplex"\)/);
  assert.match(source, /conditional_extract_routing[\s\S]*?rates\.add\("extract"\)[\s\S]*?rates\.add\("deepExtract"\)/);
  assert.match(source, /FIXED_PRICING_RULES\.agenticParseMultiplier/);
  assert.match(source, /FIXED_PRICING_RULES\.extractLatencyMultiplier/);
  assert.match(source, /FIXED_PRICING_RULES\.batchParseDiscount \* 100/);
  assert.match(
    source,
    /String\(rates\[field\.key\] \* \(field\.perThousand \? 1000 : 1\)\)/,
  );
  assert.match(
    source,
    /displayValue \/ \(field\.perThousand \? 1000 : 1\)/,
  );
});

test("browser estimator derives processing mode from an applied pipeline", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const compactSource = source.replace(/\s+/g, " ");
  assert.match(source, /estimate:\s*estimatePipeline\(normalized, appliedRates\)/);
  assert.match(source, /pipeline\.classify != null \? `Classify/);
  assert.match(source, /<th>Mode<\/th>/);
  assert.match(source, /simulatorModeLabel\(pipeline\)/);
  assert.doesNotMatch(source, /assumedExtractRoute|assumed_extract_route/);
  assert.match(source, /const hasEstimateRange = estimate != null && estimate\.low !== estimate\.high/);
  assert.match(source, /estimate\.estimateComplete \? "Estimate" : "Known estimate"/);
  assert.match(source, /function unpricedFactorLabel\(factor: string, advancedChartRate: string\)/);
  assert.match(
    source,
    /unpricedFactorLabel\(factor, appliedRateDraft\.advancedChart\)/,
  );
  assert.doesNotMatch(source, /Standard branch|Deep branch|Lumos route assumption/);
  assert.doesNotMatch(source, /aria-label="Manual pipeline configuration"/);
  assert.doesNotMatch(source, /DEFAULT_PIPELINE_TEXT|pipelineText/);
  assert.match(source, /aria-label="Reducto JSON configuration"/);
  assert.match(source, /<h3>2\. Pipeline configuration<\/h3>/);
  assert.match(source, />\s*Set up manually\s*<\/button>/);
  assert.match(source, />\s*Import from Reducto\s*<\/button>/);
  assert.equal(source.match(/>\s*Apply configuration\s*<\/button>/g)?.length, 2);
  assert.match(source, /<span className="aside" role="status">Configuration applied<\/span>/);
  assert.match(source, />\s*Review setup\s*<\/button>/);
  assert.match(
    source,
    /const MANUAL_ENDPOINTS = \["parse", "classify", "extract", "split", "edit"\] as const/,
  );
  assert.match(source, /parse: "Parse \(standalone\)"/);
  assert.match(source, /id=\{`\$\{endpoint\}-endpoint-tab`\}/);
  for (const endpoint of ["parse", "classify", "extract", "split", "edit"]) {
    assert.match(source, new RegExp(`id="${endpoint}-endpoint-panel"`));
  }
  assert.match(source, /className="endpoint-tabs"[\s\S]*?role="tablist"/);
  assert.match(source, /role="tab"[\s\S]*?aria-selected=\{manualEndpointTab === endpoint\}/);
  assert.match(source, /tabIndex=\{manualEndpointTab === endpoint \? 0 : -1\}/);
  assert.match(source, /className="endpoint-panel-scroll"/);
  assert.match(source, /<footer className="configurator-footer">/);
  assert.doesNotMatch(source, /<h5>Reducto settings<\/h5>|<h5>Lumos assumptions<\/h5>/);
  assert.match(source, /<h5>Additional inputs<\/h5>/);
  assert.doesNotMatch(source, /builder-step-[1-6]|pipeline-builder-step/);
  assert.doesNotMatch(
    source,
    /manualDraft\.(?:parseEnabled|classifyEnabled|extractMode|splitMode|editEnabled|parsePageSelection|extractPageSelection|splitPageSelection|agenticParse|batchParse|latencyPriority|imageContext)/,
  );
  assert.match(source, /manualDraftToPipeline\(/);
  assert.match(
    source,
    /pipelineToManualDraft\(codeImport\.pipeline, codeImport\.configurations\)/,
  );
  assert.match(source, /cloneManualDraft\(DEFAULT_MANUAL_PIPELINE_DRAFT\)/);
  assert.match(
    source,
    /function applyPipeline\(\)[\s\S]*?estimatePipeline\(\s*normalized,\s*appliedRates,?\s*\)[\s\S]*?setPipeline\(result\.pipeline\)/,
  );
  assert.match(
    source,
    /function applyImportedPipeline\(\)[\s\S]*?estimatePipeline\(normalized, appliedRates\)[\s\S]*?setPipeline\(codeImport\.pipeline\)/,
  );
  assert.match(
    source,
    /validatedUnpricedCostFactors = estimatePipeline\([\s\S]*?\)\.unpricedCostFactors[\s\S]*?setManualDraft\(\(current\) => \(\{[\s\S]*?assumptions:[\s\S]*?unpricedCostFactors: \[\.\.\.validatedUnpricedCostFactors\]/,
  );
  assert.match(source, /role="alert"[\s\S]*?Review the highlighted setup fields/);
  assert.match(
    source,
    /The \$\{rangeError\[1\]\} Page range does not include any pages in \$\{rangeError\[2\]\}/,
  );
  const manualApplySource = source.slice(
    source.indexOf("function applyPipeline()"),
    source.indexOf("function applyImportedPipeline()"),
  );
  assert.match(manualApplySource, /manualSetupError\(error\)/);
  assert.doesNotMatch(manualApplySource, /error instanceof Error|error\.message/);
  assert.match(
    source,
    /function handleEndpointTabKeyDown\([\s\S]*?ArrowRight[\s\S]*?ArrowLeft[\s\S]*?Home[\s\S]*?End[\s\S]*?event\.preventDefault\(\)[\s\S]*?selectManualEndpoint\(MANUAL_ENDPOINTS\[nextIndex\], true\)/,
  );
  assert.match(
    source,
    /function handlePipelineInputTabKeyDown\([\s\S]*?ArrowRight[\s\S]*?ArrowLeft[\s\S]*?Home[\s\S]*?End[\s\S]*?event\.preventDefault\(\)[\s\S]*?setPipelineInputTab\(nextTab\)[\s\S]*?document\.getElementById\(`\$\{nextTab\}-tab`\)\?\.focus\(\)/,
  );
  assert.match(source, /id="profile-tab"[\s\S]*?tabIndex=\{pipelineInputTab === "profile" \? 0 : -1\}/);
  assert.match(source, /id="code-tab"[\s\S]*?tabIndex=\{pipelineInputTab === "code" \? 0 : -1\}/);
  assert.match(
    source,
    /manualErrorEndpoint\(Object\.keys\(result\.errors\)\[0\][\s\S]*?focusManualEndpointError\(firstInvalidEndpoint\)/,
  );
  assert.match(
    source,
    /function focusManualEndpointError\([\s\S]*?querySelector<HTMLElement>\('\[aria-invalid="true"\]'\)[\s\S]*?invalidField \?\? endpointTabRefs\.current\[endpoint\][\s\S]*?\.focus\(\)/,
  );
  const pageEditorSource = source.slice(
    source.indexOf("function PageSelectionEditor("),
    source.indexOf("function makeDemoDocuments()"),
  );
  const pageModeSource = pageEditorSource.slice(
    pageEditorSource.indexOf('className="choice-row"'),
    pageEditorSource.indexOf('{selection.mode === "selected"'),
  );
  assert.doesNotMatch(pageModeSource, /aria-invalid/);
  assert.match(
    pageEditorSource,
    /aria-label=\{`\$\{legend\} \$\{index \+ 1\} start`\}[\s\S]*?aria-invalid=\{startError \|\| \(selectionError && index === 0\) \? "true" : undefined\}/,
  );
  assert.match(
    pageEditorSource,
    /aria-label=\{`\$\{legend\} \$\{index \+ 1\} end`\}[\s\S]*?aria-invalid=\{endError \? "true" : undefined\}/,
  );
  const endpointOpeningTags = [...source.matchAll(/<section\s+([\s\S]*?)>/g)]
    .map((match) => match[0])
    .filter((tag) => tag.includes('className="endpoint-panel"'));
  assert.equal(endpointOpeningTags.length, 5);
  for (const openingTag of endpointOpeningTags) {
    assert.doesNotMatch(openingTag, /tabIndex=/);
  }

  const parsePanelSource = source.slice(
    source.indexOf('id="parse-endpoint-panel"'),
    source.indexOf('manualEndpointTab === "classify"'),
  );
  assert.match(
    parsePanelSource,
    /<h4>Parse \(standalone\)<\/h4>[\s\S]*?Enable standalone Parse endpoint/,
  );
  assert.match(
    parsePanelSource,
    /disabled=\{hasDownstreamEndpoint\}[\s\S]*?Imported Parse settings are preserved and included in Extract or Split[\s\S]*?<legend>Queue Priority<\/legend>[\s\S]*?<PageSelectionEditor/,
  );
  assert.match(
    parsePanelSource,
    /className="config-group lumos-config-group"[\s\S]*?<h5>Additional inputs<\/h5>/,
  );
  assert.match(source, /disabled=\{manualDraft\.parse\.enabled\}/);
  assert.equal(source.match(/disabled=\{manualDraft\.parse\.enabled\}/g)?.length, 2);
  assert.match(source, /Return structured fields from the document, parsing included\./);
  assert.match(source, /Separate a document into sections and partitions, parsing included\./);
  assert.match(source, /Edit is priced separately and added to the estimate\./);
  assert.doesNotMatch(source, /Parsing is included in the (?:Extract|Split) price\. Do not add standalone Parse/);
  assert.doesNotMatch(source, /Default rates are \$60 per 1,000 pages, or \$15 per 1,000 fully prefilled/);
  assert.match(source, /aria-label="Imported estimate exclusions"/);
  assert.doesNotMatch(source, /const isBundledParse/);
  assert.match(source, /Expected Complex page share/);
  assert.match(source, /Expected Deep Extract share/);
  assert.match(source, /Fully prefilled pages/);
  assert.match(source, /aria-label=\{`Remove \$\{legend\} \$\{index \+ 1\}`\}/);
  assert.match(source, /aria-label=\{`Add another \$\{legend\}`\}/);
  assert.equal(source.match(/legend="Page Range"/g)?.length, 3);
  assert.doesNotMatch(source, /Shared pages to process|shares that range|using the selected Parse pages/);
  assert.match(source, /<h3><code>POST \{appPath\("\/api\/estimate"\)\}<\/code><\/h3>/);
  assert.doesNotMatch(source, /<h3>Configure once<\/h3>|<h3>For each upload<\/h3>|<h3>Handle the result<\/h3>/);
  const apiSectionSource = source.slice(
    source.indexOf('<section id="api">'),
    source.indexOf('<section id="verify">'),
  );
  assert.doesNotMatch(source, /Lumos receives metadata, not files/);
  assert.match(
    apiSectionSource,
    /Required\. An array of document <strong>metadata<\/strong> \(<code>name<\/code>, <code>pages<\/code>\)\.\s*Do not send file contents\./i,
  );
  assert.match(
    apiSectionSource,
    /Required\. The Lumos profile generated by the simulator, whether the\s+configuration\s+was created manually or imported from Reducto\./i,
  );
  assert.doesNotMatch(apiSectionSource, /canonical/i);
  assert.match(
    apiSectionSource,
    /Optional\. Maximum acceptable job cost in USD[.;]\s*defaults to (?:<code>)?10(?:<\/code>)?\./i,
  );
  assert.match(source, /authenticated server-to-server[\s\S]*?integration/);
  assert.match(source, /const pipeline = await loadSavedLumosProfile\(\)/);
  assert.match(source, />\s*Copy Lumos profile\s*<\/button>/);
  assert.doesNotMatch(apiSectionSource, />\s*Copy Lumos profile\s*<\/button>/);
  assert.match(source, /pipelineDraftState === "applied"[\s\S]*?>\s*Copy Lumos profile\s*<\/button>/);
  assert.match(source, /Lumos profile copied\./);
  assert.match(source, /Copy failed\./);
  const copyProfileSource = source.slice(
    source.indexOf("async function copyLumosProfile()"),
    source.indexOf("async function runReducto()"),
  );
  assert.match(copyProfileSource, /pipelineDraftState !== "applied"/);
  assert.match(copyProfileSource, /navigator\.clipboard\.writeText\(serializeLumosProfile\(pipeline\)\)/);
  assert.doesNotMatch(copyProfileSource, /apiRequest|documents|policy|appliedRates|reductoCode/);
  const apiSample = source.slice(source.indexOf('fetch("${appPath("/api/estimate")}"'));
  const responseGuard = apiSample.indexOf("if (!response.ok)");
  const allowGate = apiSample.indexOf('if (estimate.decision !== "allow")');
  const paidRun = apiSample.indexOf("reducto.pipeline.run");
  assert.ok(responseGuard > -1 && responseGuard < paidRun);
  assert.ok(allowGate > responseGuard && allowGate < paidRun);
  assert.match(source, /lastExtractMode\.current/);
  assert.match(source, /lastSplitMode\.current/);
  assert.ok(
    compactSource.includes(
      "Use Reducto-style settings to build the estimate configuration, or import the JSON from your Reducto pipeline.",
    ),
  );
  assert.ok(
    compactSource.includes(
      "Standard Extract is selected as an example. Apply the configuration to use it.",
    ),
  );
  assert.ok(
    compactSource.includes(
      "Copy the JSON configuration for each operation in your Reducto pipeline and paste it here. Include every operation Lumos should price, such as both Parse and Extract.",
    ),
  );
  assert.ok(
    compactSource.includes("Lumos could not create estimate settings from this Reducto JSON."),
  );
  assert.doesNotMatch(source, /"input": "reducto:\/\/uploaded-file\.pdf"/);
  assert.doesNotMatch(source, /"pipeline_id": "your_pipeline_id"/);
  assert.doesNotMatch(source, /After processing, Reducto returns billing tags/);
  assert.doesNotMatch(source, />Apply profile<\/button>|>Apply JSON config<\/button>/);
  assert.doesNotMatch(source, />Applied to estimate<\/span>|>Review Lumos profile<\/button>/);
  assert.match(source, /dialog\.showModal\(\)/);
  assert.match(source, /dialog\.addEventListener\("click", closeOnBackdrop\)/);
  assert.match(source, /<form method="dialog">/);
  assert.match(source, /onClose=\{\(\) => budgetPreviewLink\.current\?\.focus\(\)\}/);
  assert.doesNotMatch(source, /Paste Python or JSON|the code is never run/i);
  assert.match(
    source,
    /pipelineToManualDraft\(codeImport\.pipeline, codeImport\.configurations\)/,
  );
  assert.match(source, /structuredClone\(draft\.importedConfigurations\)/);
});

test("simulator mode labels come only from the configured priced operations", async () => {
  const { simulatorModeLabel } = await importTypeScriptModule("../lib/simulator-mode.ts");

  assert.equal(simulatorModeLabel({}), "No priced operation");
  assert.equal(
    simulatorModeLabel({ extract: { settings: { deep_extract: false } } }),
    "Standard Extract",
  );
  assert.equal(
    simulatorModeLabel({ extract: { settings: { deep_extract: true } } }),
    "Deep Extract",
  );
  assert.equal(
    simulatorModeLabel({
      extract: { settings: { deep_extract: false } },
      lumos_assumptions: { conditional_extract_routing: true },
    }),
    "Standard or Deep Extract",
  );
  assert.equal(simulatorModeLabel({ split: {} }), "Split");
  assert.equal(
    simulatorModeLabel({ split: { settings: { deep_split: true } } }),
    "Deep Split",
  );
  assert.equal(simulatorModeLabel({ parse: {} }), "Parse");
  assert.equal(simulatorModeLabel({ classify: {} }), "Classify");
  assert.equal(simulatorModeLabel({ edit: {} }), "Edit");
  assert.equal(
    simulatorModeLabel({
      parse: {},
      classify: {},
      extract: { settings: { deep_extract: false } },
      split: { settings: { deep_split: true } },
      edit: {},
    }),
    "Parse + Classify + Standard Extract + Deep Split + Edit",
  );
});

test("simulator gates estimates on an applied pipeline and clear restores unconfigured state", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /PipelineDraftState = "unconfigured" \| "applied" \| "dirty" \| "invalid"/,
  );
  assert.match(
    source,
    /useState<PipelineDraftState>\("unconfigured"\)/,
  );
  assert.match(
    source,
    /pipelineDraftState === "applied"[\s\S]*?simulatorModeLabel\(pipeline\)[\s\S]*?Awaiting pipeline config/,
  );
  assert.match(
    source,
    /if \(!documents\.length \|\| hasSpreadsheet \|\| pipelineDraftState !== "applied"\)/,
  );
  assert.match(source, /pipelineDraftState !== "applied"[\s\S]*?Apply the pipeline/);
  assert.match(source, /pipelineDraftState === "dirty"/);
  assert.match(source, /pipelineDraftState === "invalid"/);
  assert.match(
    source,
    /pipelineDraftState === "applied" && apiRequest[\s\S]*?View this simulator(?:&apos;|’|'|&#x27;)s API request and response/,
  );
  assert.match(
    source,
    /function clearSession\(\)[\s\S]*?setPipelineDraftState\("unconfigured"\)/,
  );
  assert.match(
    source,
    /documents\.length > 0 \|\| pipelineDraftState !== "unconfigured"/,
  );
  assert.match(source, /setPipelineDraftState\("applied"\)/);
});

test("one-click example loads the complete request and exact public-rate estimate", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const { SIMULATOR_EXAMPLE_REQUEST } = await importTypeScriptModule(
    "../lib/simulator-example.ts",
  );
  const { DEFAULT_PRICING_UNIT_RATES, estimatePipeline, normalizeRequest } =
    await importTypeScriptModule("../lib/pricing.ts");
  const { manualDraftToPipeline, pipelineToManualDraft } =
    await importTypeScriptModule("../lib/manual-pipeline.ts");
  const { serializeLumosProfile } =
    await importTypeScriptModule("../lib/profile-copy.ts");

  assert.deepEqual(SIMULATOR_EXAMPLE_REQUEST.documents, [
    { name: "data-room-01.pdf", pages: 100 },
    { name: "data-room-02.pdf", pages: 1_000 },
    { name: "data-room-03.pdf", pages: 100 },
    { name: "data-room-04.pdf", pages: 100 },
    { name: "data-room-05.pdf", pages: 1_000 },
  ]);
  assert.equal(SIMULATOR_EXAMPLE_REQUEST.policy.max_total_usd, 100);
  assert.deepEqual(SIMULATOR_EXAMPLE_REQUEST.pipeline, {
    parse: null,
    classify: { page_range: { start: 1, end: 3 } },
    extract: {
      settings: {
        deep_extract: false,
        optimize_for_latency: true,
        include_images: false,
        page_range: { start: 1, end: 5 },
      },
    },
    split: {
      settings: { deep_split: true },
      parsing: { settings: { page_range: { start: 6, end: 8 } } },
    },
    edit: {},
    lumos_assumptions: {
      conditional_extract_routing: true,
      likely_deep_extract_share: 0.4,
      estimated_extract_fields_per_page: 12,
      known_fully_prefilled_edit_pages: 20,
    },
  });

  const estimate = estimatePipeline(
    normalizeRequest(SIMULATOR_EXAMPLE_REQUEST),
    DEFAULT_PRICING_UNIT_RATES,
  );
  assert.equal(estimate.totalPages, 2_300);
  assert.equal(estimate.classifyPages, 15);
  assertClose(estimate.classifyCost, 0.1125, "example Classify subtotal");
  assert.equal(estimate.extractPages, 25);
  assertClose(estimate.extractLow, 1, "example Extract low");
  assertClose(estimate.extractLikely, 1.4, "example Extract likely");
  assertClose(estimate.extractHigh, 2, "example Extract high");
  assert.equal(estimate.splitPages, 15);
  assertClose(estimate.splitCost, 0.6, "example Split subtotal");
  assertClose(estimate.editCost, 137.1, "example Edit subtotal");
  assertClose(estimate.low, 138.8125, "example low estimate");
  assertClose(estimate.likely, 139.2125, "example likely estimate");
  assertClose(estimate.high, 139.8125, "example high estimate");
  assert.equal(estimate.estimateComplete, true);
  assert.deepEqual(estimate.unpricedCostFactors, []);
  assert.equal(estimate.decision, "deny");

  const hydratedDraft = pipelineToManualDraft(SIMULATOR_EXAMPLE_REQUEST.pipeline);
  assert.equal(hydratedDraft.classify.enabled, true);
  assert.equal(hydratedDraft.classify.start, "1");
  assert.equal(hydratedDraft.classify.end, "3");
  assert.equal(hydratedDraft.extract.mode, "conditional");
  assert.equal(hydratedDraft.extract.optimizeForLatency, true);
  assert.equal(hydratedDraft.extract.includeImages, false);
  assert.deepEqual(hydratedDraft.extract.pageSelection.ranges[0], {
    id: "extract-page-range-1",
    start: "1",
    end: "5",
  });
  assert.equal(hydratedDraft.split.mode, "deep");
  assert.deepEqual(hydratedDraft.split.pageSelection.ranges[0], {
    id: "split-page-range-1",
    start: "6",
    end: "8",
  });
  assert.equal(hydratedDraft.edit.enabled, true);
  assert.equal(hydratedDraft.edit.fullyPrefilledPages, "20");
  assert.equal(hydratedDraft.assumptions.deepSharePercent, "40");
  assert.equal(hydratedDraft.assumptions.extractFieldsPerPage, "12");

  const reapplied = manualDraftToPipeline(hydratedDraft, 2_300);
  assert.equal(reapplied.ok, true);
  assert.deepEqual(reapplied.pipeline, SIMULATOR_EXAMPLE_REQUEST.pipeline);

  const copiedProfile = serializeLumosProfile(SIMULATOR_EXAMPLE_REQUEST.pipeline);
  assert.deepEqual(JSON.parse(copiedProfile), SIMULATOR_EXAMPLE_REQUEST.pipeline);
  assert.doesNotMatch(copiedProfile, /documents|max_total_usd|rate_card|pricing_unit_rates/);

  const apiResponse = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(SIMULATOR_EXAMPLE_REQUEST),
  });
  assert.equal(apiResponse.status, 200);
  const apiResult = await apiResponse.json();
  assert.deepEqual(apiResult.estimate, {
    low_usd: 138.8125,
    likely_usd: 139.2125,
    high_usd: 139.8125,
    currency: "USD",
  });
  assert.equal(apiResult.breakdown.classify_usd, 0.1125);
  assert.equal(apiResult.breakdown.extract_low_usd, 1);
  assert.equal(apiResult.breakdown.extract_likely_usd, 1.4);
  assert.equal(apiResult.breakdown.extract_high_usd, 2);
  assert.equal(apiResult.breakdown.split_usd, 0.6);
  assert.equal(apiResult.breakdown.edit_usd, 137.1);
  assert.equal(apiResult.usage.documents, 5);
  assert.equal(apiResult.usage.pages, 2_300);
  assert.equal(apiResult.usage.classify_pages_priced, 15);
  assert.equal(apiResult.usage.extract_pages_priced, 25);
  assert.equal(apiResult.usage.split_pages_priced, 15);
  assert.equal(apiResult.estimate_complete, true);
  assert.equal(apiResult.decision, "deny");

  const loaderSource = source.slice(
    source.indexOf("function loadSimulatorExample()"),
    source.indexOf("function clearSession()"),
  );
  assert.match(loaderSource, /setDocuments\(makeExampleDocuments\(\)\)/);
  assert.match(loaderSource, /pipelineToManualDraft\(examplePipeline\)/);
  assert.match(loaderSource, /setPipelineDraftState\("applied"\)/);
  assert.match(loaderSource, /setBudget\(SIMULATOR_EXAMPLE_REQUEST\.policy\.max_total_usd\)/);
  assert.match(loaderSource, /setPipelineInputTab\("profile"\)/);
  assert.match(loaderSource, /setReductoCode\(""\)/);
  assert.match(loaderSource, /setImportApplied\(false\)/);
  assert.match(loaderSource, /setProfileCopyState\("idle"\)/);
  assert.match(loaderSource, /setLiveResult\(null\)/);
  assert.match(loaderSource, /setAppliedRates\(\{ \.\.\.DEFAULT_PRICING_UNIT_RATES \}\)/);
  assert.match(loaderSource, /setAppliedRateDraft\(defaultRateDraft\)/);
  assert.match(loaderSource, /setRateDraft\(defaultRateDraft\)/);
  assert.doesNotMatch(
    JSON.stringify(SIMULATOR_EXAMPLE_REQUEST),
    /appliedRates|rateDraft|pricing_unit_rates|rate_card|api_key|pipeline_id/,
  );
  assert.match(source, /onClick=\{loadSimulatorExample\}[\s\S]*?or try an example/);
  assert.doesNotMatch(source, /DEMO_PAGES|makeDemoDocuments|Load 15-document example/);
});

test("simulator cleanup keeps the policy, profile, and API preview states explicit", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const compactSource = source.replace(/\s+/g, " ");
  const simulatorStart = source.indexOf('<section id="simulator">');
  const apiStart = source.indexOf('<section id="api">', simulatorStart);
  const verifyStart = source.indexOf('<section id="verify">', apiStart);
  assert.ok(simulatorStart > -1 && apiStart > simulatorStart && verifyStart > apiStart);
  const simulatorSource = source.slice(simulatorStart, apiStart);
  const apiSource = source.slice(apiStart, verifyStart);

  let lastHeading = -1;
  for (const heading of [
    "<h3>1. Documents</h3>",
    "<h3>2. Pipeline configuration</h3>",
    "<h3>3. Policy</h3>",
    "<h3>4. Estimate</h3>",
  ]) {
    const index = simulatorSource.indexOf(heading);
    assert.ok(index > lastHeading, `${heading} appears in order`);
    lastHeading = index;
  }

  assert.doesNotMatch(
    simulatorSource,
    /The simulator keeps your files and estimates|Pipeline changes are ready to apply|Your budget/,
  );
  assert.match(simulatorSource, /<label className="budget">[\s\S]*?Maximum cost, USD[\s\S]*?value=\{budget\}/);
  const policyStart = simulatorSource.indexOf("<h3>3. Policy</h3>");
  const estimateStart = simulatorSource.indexOf("<h3>4. Estimate</h3>", policyStart);
  const policySource = simulatorSource.slice(policyStart, estimateStart);
  assert.match(policySource, /className="rate-card-link"/);
  assert.doesNotMatch(simulatorSource.slice(estimateStart), /className="rate-card-link"/);
  assert.match(source, /policy:\s*\{ max_total_usd: budget \}/);
  assert.match(
    simulatorSource,
    /pipelineDraftState === "dirty"[\s\S]*?role="status"[\s\S]*?Apply the pipeline changes to refresh the estimate/,
  );
  assert.match(
    simulatorSource,
    /pipelineDraftState === "applied"[\s\S]*?>\s*Copy Lumos profile\s*<\/button>/,
  );
  assert.ok(
    simulatorSource.indexOf("Copy Lumos profile") > -1 &&
      simulatorSource.indexOf("Copy Lumos profile") <
      simulatorSource.indexOf("<h3>3. Policy</h3>"),
  );
  assert.match(simulatorSource, /profileCopyState !== "idle"[\s\S]*?role=\{profileCopyState === "error" \? "alert" : "status"\}/);

  assert.match(
    apiSource,
    /<details[\s\S]*?<summary>View this simulator(?:&apos;|’|'|&#x27;)s API request and response<\/summary>[\s\S]*?<h3>Request preview<\/h3>[\s\S]*?<h3>Response preview<\/h3>[\s\S]*?<\/details>/,
  );
  assert.doesNotMatch(apiSource, />\s*Copy Lumos profile\s*<\/button>/);
  assert.doesNotMatch(apiSource, /Current applied request|Current response/);
  assert.ok(
    compactSource.includes(
      "The API preview uses public rates; simulator rate edits are excluded.",
    ),
  );
});

test("a known Standard Extract API route costs $300 for 15,000 pages", async () => {
  const response = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documents: Array.from({ length: 15 }, (_, index) => ({
        name: `document-${index + 1}.pdf`,
        pages: 1000,
        assumed_extract_route: "standard",
      })),
      pipeline: {
        classify: null,
        extract: { settings: { deep_extract: false } },
        lumos_assumptions: {
          conditional_extract_routing: true,
          likely_deep_extract_share: 0.27,
          estimated_extract_fields_per_page: 24,
        },
      },
      policy: { max_total_usd: 1000 },
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.estimate.low_usd, 300);
  assert.equal(result.estimate.likely_usd, 300);
  assert.equal(result.estimate.high_usd, 300);
  assert.equal(result.breakdown.classify_usd, 0);
});

test("standalone Parse returns a Standard-to-Complex range with a visible midpoint assumption", async () => {
  const response = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documents: [{ name: "archive.pdf", pages: 200 }],
      pipeline: { parse: {} },
      policy: { max_total_usd: 20 },
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.estimate, {
    low_usd: 3,
    likely_usd: 4.5,
    high_usd: 6,
    currency: "USD",
  });
  assert.equal(result.breakdown.parse_low_usd, 3);
  assert.equal(result.breakdown.parse_likely_usd, 4.5);
  assert.equal(result.breakdown.parse_high_usd, 6);
  assert.equal(result.usage.parse_pages_priced, 200);
  assert.equal(result.usage.parse_cost_multiplier, 1);
  assert.equal(result.usage.parse_batch_discount, 0);
  assert.equal(result.assumptions_used.likely_complex_parse_share, 0.5);
  assert.equal(result.has_range, true);
  assert.equal(result.estimate_complete, true);
});

test("agentic chart Parse applies explicit chart bounds and the batch-queue discount", async () => {
  const response = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documents: [{ name: "archive.pdf", pages: 200 }],
      pipeline: {
        parse: {
          enhance: {
            agentic: [{ scope: "figure", advanced_chart_agent: true }],
          },
          queue_priority: "batch",
        },
        lumos_assumptions: {
          likely_complex_parse_share: 0.5,
          advanced_chart_counts: { likely: 12, maximum: 25 },
        },
      },
      policy: { max_total_usd: 20 },
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.estimate.low_usd, 4.8);
  assert.equal(result.estimate.likely_usd, 7.776);
  assert.equal(result.estimate.high_usd, 10.8);
  assert.equal(result.usage.parse_cost_multiplier, 2);
  assert.equal(result.usage.parse_batch_discount, 0.2);
  assert.deepEqual(result.assumptions_used.advanced_chart_counts, {
    likely: 12,
    maximum: 25,
  });
  assert.equal(result.estimate_complete, true);
});

test("chart-enabled Parse still returns its known page estimate when chart counts are omitted", async () => {
  const response = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documents: [{ name: "charts.pdf", pages: 10 }],
      pipeline: {
        parse: {
          enhance: {
            agentic: [{ scope: "figure", advanced_chart_agent: true }],
          },
        },
        lumos_assumptions: { advanced_chart_counts: null },
      },
      policy: { max_total_usd: 10 },
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.estimate, {
    low_usd: 0.3,
    likely_usd: 0.45,
    high_usd: 0.6,
    currency: "USD",
  });
  assert.equal(result.estimate_complete, false);
  assert.deepEqual(result.unpriced_cost_factors, ["parse.advanced_chart_count"]);
  assert.equal(result.decision, "review");
});

test("Parse page ranges price only the selected pages", async () => {
  const response = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documents: [{ name: "archive.pdf", pages: 100 }],
      pipeline: {
        parse: { settings: { page_range: { start: 46, end: 62 } } },
      },
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.usage.parse_pages_priced, 17);
  assert.equal(result.estimate.low_usd, 0.255);
  assert.equal(result.estimate.likely_usd, 0.3825);
  assert.equal(result.estimate.high_usd, 0.51);
});

test("a bundled Parse page range controls downstream pages and conflicts fail closed", async () => {
  const ranged = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documents: [{ name: "archive.pdf", pages: 100 }],
      pipeline: {
        parse: { settings: { page_range: { start: 46, end: 62 } } },
        extract: { settings: { deep_extract: false } },
      },
    }),
  });
  assert.equal(ranged.status, 200);
  const rangedResult = await ranged.json();
  assert.equal(rangedResult.usage.parse_pages_priced, 0);
  assert.equal(rangedResult.usage.extract_pages_priced, 17);
  assert.equal(rangedResult.estimate.likely_usd, 0.34);

  const conflict = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documents: [{ name: "archive.pdf", pages: 100 }],
      pipeline: {
        parse: { settings: { page_range: { start: 1, end: 5 } } },
        extract: { settings: { page_range: { start: 1, end: 10 } } },
      },
    }),
  });
  assert.equal(conflict.status, 400);
  assert.match((await conflict.json()).error, /Parse and Extract specify different page ranges/i);
});

test("standalone Parse accepts the explicit auto queue without a batch discount", async () => {
  const response = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documents: [{ name: "archive.pdf", pages: 10 }],
      pipeline: { parse: { queue_priority: "auto" } },
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.usage.parse_batch_discount, 0);
  assert.equal(result.estimate.low_usd, 0.15);
});

test("bundled Parse enhancements add no separate charge to Extract", async () => {
  const response = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documents: [{ name: "charts.pdf", pages: 100 }],
      pipeline: {
        parse: {
          enhance: {
            agentic: [{ scope: "figure", advanced_chart_agent: true }],
          },
        },
        extract: { settings: { deep_extract: false } },
        lumos_assumptions: { estimated_extract_fields_per_page: 1 },
      },
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.estimate.low_usd, 2);
  assert.equal(result.estimate.likely_usd, 2);
  assert.equal(result.estimate.high_usd, 2);
  assert.equal(result.usage.parse_pages_priced, 0);
  assert.equal(result.estimate_complete, true);
  assert.deepEqual(result.unpriced_cost_factors, []);
});

test("Classify null always contributes zero pages and zero cost", async () => {
  const response = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documents: [{ name: "contract.pdf", pages: 10 }],
      pipeline: { classify: null },
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.usage.classify_pages_priced, 0);
  assert.equal(result.breakdown.classify_usd, 0);
  assert.equal(result.estimate.likely_usd, 0);
});

test("Classify prices inclusive PDF context ranges and caps the end at the last page", async () => {
  const cases = [
    { name: "default range on a short PDF", pages: 2, classify: {}, pricedPages: 2 },
    {
      name: "range 3 through 7 on a long PDF",
      pages: 20,
      classify: { page_range: { start: 3, end: 7 } },
      pricedPages: 5,
    },
    {
      name: "range 3 through 7 on a five-page PDF",
      pages: 5,
      classify: { page_range: { start: 3, end: 7 } },
      pricedPages: 3,
    },
    {
      name: "single-page range",
      pages: 20,
      classify: { page_range: { start: 4, end: 4 } },
      pricedPages: 1,
    },
  ];

  for (const testCase of cases) {
    const response = await request("/api/estimate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        documents: [{ name: "contract.pdf", pages: testCase.pages }],
        pipeline: { classify: testCase.classify },
      }),
    });
    assert.equal(response.status, 200, testCase.name);
    const result = await response.json();
    assert.equal(result.usage.classify_pages_priced, testCase.pricedPages, testCase.name);
    assert.equal(
      result.breakdown.classify_usd,
      Number((testCase.pricedPages * 0.0075).toFixed(4)),
      testCase.name,
    );
  }
});

test("Classify ignores PDF page_range for non-PDF documents and uses its default context", async () => {
  const response = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documents: [{ name: "contract.docx", pages: 20 }],
      pipeline: { classify: { page_range: { start: 4, end: 4 } } },
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.usage.classify_pages_priced, 5);
  assert.equal(result.breakdown.classify_usd, 0.0375);
});

test("Classify recognizes PDF URLs before applying the selected context range", async () => {
  const response = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documents: [{ name: "https://example.com/contract.pdf?download=1", pages: 20 }],
      pipeline: { classify: { page_range: { start: 1, end: 10 } } },
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.usage.classify_pages_priced, 10);
  assert.equal(result.breakdown.classify_usd, 0.075);
});

test("Classify rejects ranges that begin after the last PDF page", async () => {
  const response = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documents: [{ name: "contract.pdf", pages: 2 }],
      pipeline: { classify: { page_range: { start: 3, end: 5 } } },
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /starts after the last page/i);
});

test("estimate API prices documented Deep Extract settings without a separate Parse line", async () => {
  const response = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documents: [{ name: "contract.pdf", pages: 10 }],
      pipeline: {
        extract: { settings: { deep_extract: true } },
      },
      policy: { max_total_usd: 1 },
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.estimate.low_usd, 0.4);
  assert.equal(result.estimate.high_usd, 0.4);
  assert.equal(result.has_range, false);
  assert.equal(result.breakdown.parse_low_usd, 0);
  assert.equal(result.usage.parse_pages_priced, 0);
});

test("Extract page selections change the priced pages instead of pricing the full document", async () => {
  const response = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documents: [{ name: "policy.pdf", pages: 100 }],
      pipeline: {
        extract: {
          settings: {
            deep_extract: false,
            page_range: Array.from({ length: 17 }, (_, index) => index + 46),
          },
        },
      },
      policy: { max_total_usd: 1 },
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.usage.pages, 100);
  assert.equal(result.usage.extract_pages_priced, 17);
  assert.equal(result.breakdown.extract_likely_usd, 0.34);
  assert.equal(result.estimate.likely_usd, 0.34);
});

test("Extract applies Reducto's documented 2x latency-priority cost", async () => {
  const response = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documents: [{ name: "contract.pdf", pages: 10 }],
      pipeline: {
        extract: {
          settings: { deep_extract: false, optimize_for_latency: true },
        },
      },
      policy: { max_total_usd: 1 },
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.usage.extract_pages_priced, 10);
  assert.equal(result.estimate.likely_usd, 0.4);
});

test("unpriced imported settings force review instead of an unsafe allow", async () => {
  const response = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documents: [{ name: "visual-contract.pdf", pages: 10 }],
      pipeline: {
        extract: { settings: { deep_extract: false, include_images: true } },
        lumos_assumptions: { estimated_extract_fields_per_page: 1 },
      },
      policy: { max_total_usd: 10 },
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.estimate.likely_usd, 0.2);
  assert.equal(result.decision, "review");
  assert.equal(result.estimate_complete, false);
  assert.deepEqual(result.unpriced_cost_factors, ["extract.include_images"]);
});

test("dense Extract stays complete at 100 fields and becomes incomplete above 100", async () => {
  for (const [fields, complete] of [[100, true], [101, false]]) {
    const response = await request("/api/estimate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        documents: [{ name: "contract.pdf", pages: 10 }],
        pipeline: {
          extract: { settings: { deep_extract: false } },
          lumos_assumptions: { estimated_extract_fields_per_page: fields },
        },
        policy: { max_total_usd: 10 },
      }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.estimate.likely_usd, 0.2);
    assert.equal(result.estimate_complete, complete);
    assert.equal(
      result.unpriced_cost_factors.includes("extract.field_density"),
      !complete,
    );
    assert.equal(result.decision, complete ? "allow" : "review");
  }
});

test("Extract without a field-density bound keeps the page estimate but marks it incomplete", async () => {
  const response = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documents: [{ name: "contract.pdf", pages: 10 }],
      pipeline: { extract: { settings: { deep_extract: false } } },
      policy: { max_total_usd: 10 },
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.estimate.likely_usd, 0.2);
  assert.equal(result.estimate_complete, false);
  assert.deepEqual(result.unpriced_cost_factors, ["extract.field_density"]);
  assert.equal(result.decision, "review");
});

test("Edit uses the discounted rate only for developer-supplied fully prefilled pages", async () => {
  const response = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documents: [{ name: "form.pdf", pages: 10 }],
      pipeline: {
        edit: {},
        lumos_assumptions: { known_fully_prefilled_edit_pages: 4 },
      },
      policy: { max_total_usd: 10 },
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.breakdown.edit_usd, 0.42);
  assert.equal(result.estimate.likely_usd, 0.42);
  assert.equal(result.estimate_complete, true);
});

test("Edit rejects a fully prefilled page count larger than the document set", async () => {
  const response = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documents: [{ name: "form.pdf", pages: 10 }],
      pipeline: {
        edit: {},
        lumos_assumptions: { known_fully_prefilled_edit_pages: 11 },
      },
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /cannot exceed the total document page count/i);
});

test("Extract page ranges merge overlaps and stop at the document's last page", async () => {
  const response = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documents: [{ name: "policy.pdf", pages: 60 }],
      pipeline: {
        extract: {
          settings: {
            deep_extract: true,
            page_range: [
              { start: 46, end: 55 },
              { start: 52, end: 62 },
            ],
          },
        },
      },
      policy: { max_total_usd: 1 },
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.usage.extract_pages_priced, 15);
  assert.equal(result.estimate.likely_usd, 0.6);
});

test("Extract rejects a page selection outside the document", async () => {
  const response = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documents: [{ name: "short.pdf", pages: 10 }],
      pipeline: {
        extract: { settings: { page_range: { start: 46, end: 62 } } },
      },
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /selects no pages/i);
});

test("estimate API accepts Reducto's documented Deep Split setting", async () => {
  const response = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documents: [{ name: "packet.pdf", pages: 10 }],
      pipeline: {
        split: { settings: { deep_split: true } },
      },
      policy: { max_total_usd: 1 },
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.estimate.low_usd, 0.4);
  assert.equal(result.estimate.likely_usd, 0.4);
  assert.equal(result.estimate.high_usd, 0.4);
  assert.equal(result.usage.split_pages_priced, 10);
});

test("Split Parse page ranges merge overlaps, cap to the document, and change cost", async () => {
  const response = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documents: [{ name: "packet.pdf", pages: 100 }],
      pipeline: {
        split: {
          settings: { deep_split: false },
          parsing: {
            settings: {
              page_range: [
                { start: 2, end: 5 },
                { start: 4, end: 8 },
                { start: 99, end: 120 },
              ],
            },
          },
        },
      },
      policy: { max_total_usd: 1 },
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.usage.pages, 100);
  assert.equal(result.usage.split_pages_priced, 9);
  assert.equal(result.breakdown.split_usd, 0.18);
  assert.equal(result.estimate.likely_usd, 0.18);
});

test("Split rejects a Parse page selection outside the document", async () => {
  const response = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documents: [{ name: "short.pdf", pages: 10 }],
      pipeline: {
        split: {
          parsing: {
            settings: { page_range: { start: 46, end: 62 } },
          },
        },
      },
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Split.*page_range selects no pages/i);
});

test("estimate API enforces Reducto's documented 10-page Classify limit", async () => {
  const response = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documents: [{ name: "contract.pdf", pages: 20 }],
      pipeline: { classify: { page_range: { start: 1, end: 11 } } },
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /1 to 10 whole PDF pages/i);
});

test("estimate API rejects fractional Classify page numbers", async () => {
  const response = await request("/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      documents: [{ name: "contract.pdf", pages: 20 }],
      pipeline: { classify: { page_range: { start: 1.5, end: 5 } } },
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /whole PDF pages/i);
});

test("estimate API rejects malformed Classify page_range containers", async () => {
  for (const pageRange of [[], "1-5", true]) {
    const response = await request("/api/estimate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        documents: [{ name: "contract.pdf", pages: 20 }],
        pipeline: { classify: { page_range: pageRange } },
      }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /page_range must be an object or null/i);
  }
});

test("estimate API requires both Classify page_range bounds", async () => {
  for (const pageRange of [{ start: 2 }, { end: 4 }, {}]) {
    const response = await request("/api/estimate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        documents: [{ name: "contract.pdf", pages: 20 }],
        pipeline: { classify: { page_range: pageRange } },
      }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /needs both start and end/i);
  }
});

test("estimate API rejects malformed operation and settings containers", async () => {
  const malformedPipelines = [
    { parse: true },
    { classify: true },
    { extract: [] },
    { split: "deep" },
    { edit: 1 },
    { lumos_assumptions: [] },
    { parse: { enhance: true } },
    { parse: { settings: [] } },
    { extract: { settings: true } },
    { split: { settings: [] } },
    { split: { parsing: [] } },
    { split: { parsing: { settings: [] } } },
  ];

  for (const pipeline of malformedPipelines) {
    const response = await request("/api/estimate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ documents: [{ name: "contract.pdf", pages: 10 }], pipeline }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /must be an object or null/i);
  }
});

test("estimate API rejects nonboolean cost switches", async () => {
  const malformedPipelines = [
    { extract: { settings: { deep_extract: "true" } } },
    { extract: { settings: { optimize_for_latency: 1 } } },
    { extract: { settings: { include_images: "yes" } } },
    { split: { settings: { deep_split: 1 } } },
    { extract: {}, lumos_assumptions: { conditional_extract_routing: "yes" } },
  ];

  for (const pipeline of malformedPipelines) {
    const response = await request("/api/estimate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ documents: [{ name: "contract.pdf", pages: 10 }], pipeline }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /must be true or false/i);
  }
});

test("estimate API rejects malformed standalone Parse agentic modes", async () => {
  const cases = [
    {
      agentic: [{ advanced_chart_agent: true }],
      error: /scope must be text, table, or figure/i,
    },
    {
      agentic: [{ scope: "table", advanced_chart_agent: true }],
      error: /advanced_chart_agent requires scope "figure"/i,
    },
    {
      agentic: [{ scope: "figure", advanced_chart_agent: "yes" }],
      error: /advanced_chart_agent must be true or false/i,
    },
  ];

  for (const testCase of cases) {
    const response = await request("/api/estimate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        documents: [{ name: "charts.pdf", pages: 10 }],
        pipeline: { parse: { enhance: { agentic: testCase.agentic } } },
      }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, testCase.error);
  }
});

test("estimate API rejects unknown pricing fields", async () => {
  const malformedPipelines = [
    {
      pipeline: { extract: { settings: { deep_extrcat: true } } },
      error: /unsupported field: deep_extrcat/i,
    },
    {
      pipeline: { lumos_assumptions: { likely_deep_share: 0.5 } },
      error: /unsupported field: likely_deep_share/i,
    },
    {
      pipeline: { edit: { typo: true } },
      error: /pipeline\.edit contains unsupported field: typo/i,
    },
    {
      pipeline: { classify: { page_range: { start: 1, end: 5, typo: true } } },
      error: /Classify page_range contains unsupported field: typo/i,
    },
    {
      pipeline: {
        extract: { settings: { page_range: { start: 1, end: 5, typo: true } } },
      },
      error: /Extract settings\.page_range contains unsupported field: typo/i,
    },
    {
      pipeline: {
        split: {
          parsing: {
            settings: { page_range: { start: 1, end: 5, typo: true } },
          },
        },
      },
      error: /Split parsing\.settings\.page_range contains unsupported field: typo/i,
    },
    { pipeline: { transform: {} }, error: /unsupported field: transform/i },
  ];

  for (const testCase of malformedPipelines) {
    const response = await request("/api/estimate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        documents: [{ name: "contract.pdf", pages: 10 }],
        pipeline: testCase.pipeline,
      }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, testCase.error);
  }
});

test("estimate API rejects unknown request and document fields instead of using cheaper defaults", async () => {
  const malformedRequests = [
    {
      documents: [{ name: "contract.pdf", pages: 10 }],
      pipeline: {},
      polciy: { max_total_usd: 0.1 },
    },
    {
      documents: [{ name: "contract.pdf", pages: 10, assumed_extract_routes: "deep" }],
      pipeline: {
        extract: { settings: { deep_extract: false } },
        lumos_assumptions: { conditional_extract_routing: true },
      },
    },
    {
      documents: [{ name: "contract.pdf", pages: 10, mode: "deep" }],
      pipeline: {
        extract: { settings: { deep_extract: false } },
        lumos_assumptions: { conditional_extract_routing: true },
      },
    },
    {
      documents: [{ name: "contract.pdf", pages: 10, deep_extract: true }],
      pipeline: {
        extract: { settings: { deep_extract: false } },
        lumos_assumptions: { conditional_extract_routing: true },
      },
    },
    {
      documents: [{ name: "contract.pdf", pages: 10, assumed_extract: "deep" }],
      pipeline: {
        extract: { settings: { deep_extract: false } },
        lumos_assumptions: { conditional_extract_routing: true },
      },
    },
  ];

  for (const payload of malformedRequests) {
    const response = await request("/api/estimate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /unsupported field/i);
  }
});

test("estimate API rejects coercible and fractional billing counts", async () => {
  const malformedPipelines = [
    {
      extract: { settings: { page_range: { start: "1", end: "5" } } },
      error: /Extract settings\.page_range.*whole.*1-indexed/i,
    },
    {
      extract: { settings: { page_range: [{ start: "1", end: 5 }] } },
      error: /Extract settings\.page_range.*whole.*1-indexed/i,
    },
    {
      split: {
        parsing: { settings: { page_range: [{ start: "1", end: 5 }] } },
      },
      error: /Split parsing\.settings\.page_range.*whole.*1-indexed/i,
    },
    {
      split: { parsing: { settings: { page_range: [] } } },
      error: /Split parsing\.settings\.page_range needs at least one page/i,
    },
    {
      extract: {},
      lumos_assumptions: { estimated_extract_fields_per_page: 12.5 },
      error: /estimated_extract_fields_per_page.*(?:whole|integer)/i,
    },
    {
      edit: {},
      lumos_assumptions: { known_fully_prefilled_edit_pages: 9.6 },
      error: /known_fully_prefilled_edit_pages.*(?:whole|integer)/i,
    },
  ];

  for (const testCase of malformedPipelines) {
    const { error, ...pipeline } = testCase;
    const response = await request("/api/estimate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ documents: [{ name: "contract.pdf", pages: 10 }], pipeline }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, error);
  }
});

test("estimate API rejects unsafe individual and aggregate page counts", async () => {
  const malformedDocumentSets = [
    [{ name: "oversized.pdf", pages: Number.MAX_SAFE_INTEGER + 1 }],
    [
      { name: "first.pdf", pages: Number.MAX_SAFE_INTEGER },
      { name: "second.pdf", pages: Number.MAX_SAFE_INTEGER },
    ],
  ];

  for (const documents of malformedDocumentSets) {
    const response = await request("/api/estimate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ documents, pipeline: { extract: {} } }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /page count|pages.*safe|too large/i);
  }
});

test("estimate API rejects null cost inputs instead of replacing them with cheaper defaults", async () => {
  const malformedRequests = [
    {
      documents: [{ name: "contract.pdf", pages: 10, assumed_extract_route: null }],
      pipeline: {
        extract: {},
        lumos_assumptions: { conditional_extract_routing: true },
      },
      error: /Unknown document route/i,
    },
    {
      documents: [{ name: "contract.pdf", pages: 10 }],
      pipeline: {
        extract: {},
        lumos_assumptions: { unpriced_cost_factors: null },
      },
      error: /unpriced_cost_factors.*(?:list|array)/i,
    },
    {
      documents: [{ name: "contract.pdf", pages: 10 }],
      pipeline: { extract: {} },
      policy: null,
      error: /policy must be an object/i,
    },
  ];

  for (const { error, ...payload } of malformedRequests) {
    const response = await request("/api/estimate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, error);
  }
});

test("estimate API rejects invalid assumptions and budgets instead of coercing them", async () => {
  const malformedRequests = [
    {
      pipeline: {
        lumos_assumptions: { likely_deep_extract_share: 1.1 },
      },
    },
    {
      pipeline: {
        lumos_assumptions: { estimated_extract_fields_per_page: -1 },
      },
    },
    {
      pipeline: {
        lumos_assumptions: { known_fully_prefilled_edit_pages: "2" },
      },
    },
    { pipeline: {}, policy: { max_total_usd: "10" } },
  ];

  for (const malformed of malformedRequests) {
    const response = await request("/api/estimate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        documents: [{ name: "contract.pdf", pages: 10 }],
        ...malformed,
      }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /must be a finite number/i);
  }
});

test("estimate API rejects contradictory Parse and Extract pricing inputs", async () => {
  const cases = [
    {
      pipeline: {
        parse: { queue_priority: "batch" },
        extract: {},
      },
      error: /queue_priority.*only.*standalone Parse/i,
    },
    {
      pipeline: {
        parse: {},
        lumos_assumptions: {
          advanced_chart_counts: { likely: 1, maximum: 2 },
        },
      },
      error: /advanced_chart_counts requires advanced chart/i,
    },
    {
      pipeline: {
        parse: {
          enhance: {
            agentic: [{ scope: "figure", advanced_chart_agent: true }],
          },
        },
        lumos_assumptions: {
          advanced_chart_counts: { likely: 3, maximum: 2 },
        },
      },
      error: /maximum must be at least the likely/i,
    },
    {
      pipeline: {
        extract: { settings: { deep_extract: true } },
        lumos_assumptions: { conditional_extract_routing: true },
      },
      error: /deep_extract cannot be true.*conditional_extract_routing/i,
    },
  ];

  for (const testCase of cases) {
    const response = await request("/api/estimate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        documents: [{ name: "contract.pdf", pages: 10 }],
        pipeline: testCase.pipeline,
      }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, testCase.error);
  }
});

test("estimate API refuses to invent page pricing for spreadsheet names and URLs", async () => {
  for (const name of ["model.xlsx", "MODEL.XLSX?download=1", "table.csv#sheet-2"]) {
    const response = await request("/api/estimate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        documents: [{ name, pages: 1 }],
        pipeline: { extract: { settings: { deep_extract: false } } },
      }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /billable cell counts.*rate card/i);
  }
});

test("estimate API requires a nonempty original filename for every document", async () => {
  for (const document of [
    { pages: 10 },
    { name: "", pages: 10 },
    { name: "   ", pages: 10 },
  ]) {
    const response = await request("/api/estimate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        documents: [document],
        pipeline: { split: { settings: { deep_split: true } } },
      }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /nonempty original filename/i);
  }
});

test("removes the temporary starter preview", async () => {
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
});
