import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function loadImporter() {
  const filename = new URL("../lib/reducto-code-import.ts", import.meta.url);
  const source = await readFile(filename, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename.pathname,
    reportDiagnostics: true,
  });

  const errors = (transpiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.deepEqual(errors, [], "the Reducto JSON importer should transpile cleanly");

  const url = `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`;
  return import(url);
}

const { importReductoCode } = await loadImporter();

const PARSE_CONFIG = `{
  "enhance": {
    "agentic": [],
    "summarize_figures": true
  },
  "formatting": {
    "add_page_markers": false,
    "include": [],
    "merge_tables": false,
    "table_output_format": "html"
  },
  "retrieval": {
    "chunking": {
      "chunk_mode": "disabled",
      "chunk_size": null
    },
    "filter_blocks": []
  },
  "settings": {
    "extraction_mode": "hybrid",
    "force_url_result": false,
    "ocr_system": "standard",
    "page_range": {},
    "persist_results": true,
    "return_ocr_data": false,
    "timeout": 900
  },
  "spreadsheet": {
    "clustering": "accurate",
    "exclude": [],
    "include": [],
    "split_large_tables": {
      "enabled": true,
      "size": 50
    }
  }
}`;

const SCHEMALESS_EXTRACT_CONFIG = `{
  "instructions": {
    "schema": {
      "type": "object"
    }
  },
  "settings": {
    "citations": {
      "enabled": true,
      "numerical_confidence": false
    }
  }
}`;

const RICH_PARSE_CONFIG = `{
  "enhance": {
    "agentic": [
      {
        "scope": "figure"
      },
      {
        "mode": "auto",
        "scope": "table"
      },
      {
        "scope": "text"
      }
    ],
    "intelligent_ordering": true,
    "summarize_figures": true
  },
  "formatting": {
    "add_page_markers": true,
    "include": [
      "signatures",
      "hyperlinks",
      "comments",
      "ignore_watermarks",
      "highlight",
      "change_tracking"
    ],
    "merge_tables": true,
    "table_output_format": "html"
  },
  "retrieval": {
    "chunking": {
      "chunk_mode": "variable",
      "chunk_size": 1000
    },
    "embedding_optimized": true,
    "filter_blocks": []
  },
  "settings": {
    "embed_pdf_metadata": true,
    "extraction_mode": "hybrid",
    "force_url_result": false,
    "ocr_system": "standard",
    "page_range": {
      "end": 5,
      "start": 1
    },
    "persist_results": true,
    "return_images": [
      "figure",
      "table",
      "page"
    ],
    "return_ocr_data": true,
    "timeout": 900
  },
  "spreadsheet": {
    "clustering": "accurate",
    "exclude": [
      "hidden_cols",
      "hidden_rows",
      "spreadsheet_images",
      "hidden_sheets",
      "styling"
    ],
    "include": [
      "dropdowns",
      "formula",
      "cell_colors"
    ],
    "max_cell_count": 50,
    "split_large_tables": {
      "enabled": true,
      "size": 50
    }
  }
}`;

const DEEP_EXTRACT_CONFIG = `{
  "instructions": {
    "schema": {
      "type": "object",
      "properties": {
        "Name": {
          "type": "string"
        }
      },
      "required": [
        "Name"
      ]
    }
  },
  "settings": {
    "include_images": true,
    "optimize_for_latency": true,
    "deep_extract": true,
    "citations": {
      "enabled": true,
      "numerical_confidence": false
    },
    "alpha": {
      "deep_extract_confidence": true
    }
  }
}`;

const SPLIT_CONFIG = `{
  "split_description": [
    {
      "name": "Map",
      "description": "Natural Hazard Map"
    }
  ],
  "split_rules": "Split the document into the applicable sections. Sections may only overlap at their first and last page if at all.",
  "deep_split": true,
  "split_options": {
    "table_cutoff": "truncate"
  }
}`;

const CLASSIFY_CONFIG = `{
  "classification_schema": {
    "type": "object",
    "properties": {
      "document_type": {
        "type": "string",
        "enum": ["map", "report"]
      }
    }
  },
  "page_range": {
    "start": 1,
    "end": 3
  }
}`;

const EDIT_CONFIG = `{
  "edit_instructions": "Fill the highlighted fields using the extracted values."
}`;

test("imports the supplied standalone Parse configuration without treating its spreadsheet group as input", () => {
  const result = importReductoCode(PARSE_CONFIG);

  assert.equal(result.applicable, true);
  assert.equal(result.error, null);
  assert.deepEqual(result.detected.operations, ["parse"]);
  assert.equal(result.detected.source, "json");
  assert.equal(result.detected.spreadsheet, false);
  assert.deepEqual(result.pipeline.parse, {
    enhance: { agentic: [] },
  });
  assert.equal(result.pipeline.lumos_assumptions.likely_complex_parse_share, 0.5);
  assert.match(result.warnings.join(" "), /spreadsheet settings group/i);
});

test("preserves standalone Parse agentic modes and every normalized page range", () => {
  const parse = JSON.parse(RICH_PARSE_CONFIG);
  parse.settings.page_range = [
    { start: 8, end: 10 },
    { start: 1, end: 3 },
    { start: 3, end: 5 },
    { start: 12, end: 12 },
  ];
  const result = importReductoCode(JSON.stringify(parse));

  assert.equal(result.applicable, true);
  assert.deepEqual(result.pipeline.parse, {
    enhance: {
      agentic: [
        { scope: "figure" },
        { mode: "auto", scope: "table" },
        { scope: "text" },
      ],
    },
    settings: {
      page_range: [
        { start: 1, end: 5 },
        { start: 8, end: 10 },
        { start: 12, end: 12 },
      ],
    },
  });
  assert.equal(result.pipeline.lumos_assumptions.likely_complex_parse_share, 0.5);
});

test("keeps standalone advanced-chart Parse applicable while marking chart count unpriced", () => {
  const parse = JSON.parse(RICH_PARSE_CONFIG);
  parse.enhance.agentic[0].advanced_chart_agent = true;
  const result = importReductoCode(JSON.stringify(parse));

  assert.equal(result.applicable, true);
  assert.equal(result.detected.advancedChart, true);
  assert.equal(result.pipeline.parse.enhance.agentic[0].advanced_chart_agent, true);
  assert.deepEqual(result.pipeline.lumos_assumptions.unpriced_cost_factors, [
    "parse.advanced_chart_count",
  ]);
  assert.match(result.warnings.join(" "), /detected chart count.*unpriced/i);
});

test("accepts documented agentic prompts and fails closed on unknown agentic fields", () => {
  const withPrompt = JSON.parse(RICH_PARSE_CONFIG);
  withPrompt.enhance.agentic[0].prompt = "Focus on the primary trend line";
  const accepted = importReductoCode(JSON.stringify(withPrompt));
  assert.equal(accepted.applicable, true);

  withPrompt.enhance.agentic[0].future_billed_mode = true;
  const rejected = importReductoCode(JSON.stringify(withPrompt));
  assert.equal(rejected.applicable, false);
  assert.match(rejected.error, /unsupported field: future_billed_mode/i);
});

test("imports the supplied schemaless Standard Extract configuration conservatively", () => {
  const result = importReductoCode(SCHEMALESS_EXTRACT_CONFIG);

  assert.equal(result.applicable, true);
  assert.equal(result.error, null);
  assert.deepEqual(result.detected.operations, ["extract"]);
  assert.equal(result.detected.extractMode, "standard");
  assert.equal(result.detected.schemaFieldCount, null);
  assert.equal(result.pipeline.extract.settings.deep_extract, false);
  assert.deepEqual(result.pipeline.lumos_assumptions.unpriced_cost_factors, [
    "extract.field_density",
  ]);
});

test("imports the supplied Deep Extract configuration and its cost-relevant settings", () => {
  const result = importReductoCode(DEEP_EXTRACT_CONFIG);

  assert.equal(result.applicable, true);
  assert.equal(result.detected.extractMode, "deep");
  assert.equal(result.detected.schemaFieldCount, 1);
  assert.equal(result.pipeline.extract.settings.deep_extract, true);
  assert.equal(result.pipeline.extract.settings.optimize_for_latency, true);
  assert.equal(result.pipeline.extract.settings.include_images, true);
  assert.deepEqual(result.pipeline.lumos_assumptions.unpriced_cost_factors, [
    "extract.include_images",
  ]);
});

test("normalizes the supplied Studio Split configuration to the API pricing shape", () => {
  const result = importReductoCode(SPLIT_CONFIG);

  assert.equal(result.applicable, true);
  assert.deepEqual(result.detected.operations, ["split"]);
  assert.equal(result.pipeline.extract, null);
  assert.deepEqual(result.pipeline.split, { settings: { deep_split: true } });
  assert.match(result.warnings.join(" "), /deep_split.*settings\.deep_split/i);
  assert.match(result.warnings.join(" "), /table_cutoff.*no list-price effect/i);
});

test("accepts the official nested Deep Split setting and rejects conflicting compatibility forms", () => {
  const nested = importReductoCode(`{
    "split_description": [{"name": "Map", "description": "Natural Hazard Map"}],
    "settings": {"deep_split": true}
  }`);
  assert.equal(nested.applicable, true);
  assert.equal(nested.pipeline.split.settings.deep_split, true);

  const conflict = importReductoCode(`{
    "split_description": [{"name": "Map", "description": "Natural Hazard Map"}],
    "deep_split": true,
    "settings": {"deep_split": false}
  }`);
  assert.equal(conflict.applicable, false);
  assert.match(conflict.error, /conflicts/i);
});

test("imports raw Classify and Edit JSON configurations", () => {
  const classify = importReductoCode(CLASSIFY_CONFIG);
  assert.equal(classify.applicable, true);
  assert.deepEqual(classify.detected.operations, ["classify"]);
  assert.deepEqual(classify.pipeline.classify, {
    page_range: { start: 1, end: 3 },
  });

  const edit = importReductoCode(EDIT_CONFIG);
  assert.equal(edit.applicable, true);
  assert.deepEqual(edit.detected.operations, ["edit"]);
  assert.deepEqual(edit.pipeline.edit, {});
});

test("rejects invalid raw Classify and Edit cost configs", () => {
  const classify = importReductoCode(`{
    "classification_schema": "dynamic",
    "page_range": {"start": 1, "end": 3}
  }`);
  assert.equal(classify.applicable, false);
  assert.match(classify.error, /classification_schema.*object or array/i);

  const edit = importReductoCode(`{"edit_instructions": []}`);
  assert.equal(edit.applicable, false);
  assert.match(edit.error, /edit_instructions.*nonempty string/i);
});

test("combines adjacent Parse and Extract JSON objects into one Lumos pipeline", () => {
  const result = importReductoCode(`${RICH_PARSE_CONFIG}\n\n${DEEP_EXTRACT_CONFIG}`);

  assert.equal(result.applicable, true);
  assert.deepEqual(result.detected.operations, ["parse", "extract"]);
  assert.deepEqual(result.detected.extractPageRanges, [{ start: 1, end: 5 }]);
  assert.deepEqual(result.pipeline.extract.settings.page_range, { start: 1, end: 5 });
  assert.equal(result.pipeline.extract.settings.deep_extract, true);
  assert.deepEqual(result.pipeline.lumos_assumptions.unpriced_cost_factors, [
    "extract.include_images",
  ]);
  assert.deepEqual(result.pipeline.parse, {});
  assert.match(result.warnings.join(" "), /Parse page range.*downstream Extract/i);
});

test("keeps imported Parse raw when it is included downstream while Classify and Edit stay additive", () => {
  const parse = JSON.parse(RICH_PARSE_CONFIG);
  const classify = JSON.parse(CLASSIFY_CONFIG);
  const extract = JSON.parse(DEEP_EXTRACT_CONFIG);
  const edit = JSON.parse(EDIT_CONFIG);
  const result = importReductoCode(
    JSON.stringify([parse, classify, extract, edit]),
  );

  assert.equal(result.applicable, true);
  assert.deepEqual(result.detected.operations, ["parse", "classify", "extract", "edit"]);
  assert.deepEqual(result.pipeline.parse, {});
  assert.deepEqual(result.pipeline.classify, { page_range: { start: 1, end: 3 } });
  assert.deepEqual(result.pipeline.edit, {});
  assert.deepEqual(result.configurations.parse, parse);
  assert.deepEqual(result.configurations.classify, classify);
  assert.deepEqual(result.configurations.edit, edit);
});

test("keeps an Extract settings page range attached to an otherwise clear Extract config", () => {
  const result = importReductoCode(`{
    "instructions": {
      "schema": {
        "type": "object",
        "properties": {"Name": {"type": "string"}}
      }
    },
    "settings": {
      "deep_extract": false,
      "page_range": {"start": 2, "end": 4}
    }
  }`);

  assert.equal(result.applicable, true);
  assert.deepEqual(result.detected.operations, ["extract"]);
  assert.deepEqual(result.pipeline.extract.settings.page_range, { start: 2, end: 4 });
});

test("normalizes all documented Parse page ranges without dropping disjoint ranges", () => {
  const parse = JSON.parse(PARSE_CONFIG);
  parse.settings.page_range = [
    { start: 8, end: 10 },
    { start: 1, end: 3 },
    { start: 3, end: 5 },
    { start: 12, end: 12 },
  ];
  const result = importReductoCode(
    `${JSON.stringify(parse)}\n${DEEP_EXTRACT_CONFIG}\n${SPLIT_CONFIG}`,
  );

  assert.equal(result.applicable, true);
  assert.deepEqual(result.detected.extractPageRanges, [
    { start: 1, end: 5 },
    { start: 8, end: 10 },
    { start: 12, end: 12 },
  ]);
  assert.deepEqual(result.pipeline.extract.settings.page_range, [
    { start: 1, end: 5 },
    { start: 8, end: 10 },
    { start: 12, end: 12 },
  ]);
  assert.deepEqual(result.pipeline.split.parsing.settings.page_range, [
    { start: 1, end: 5 },
    { start: 8, end: 10 },
    { start: 12, end: 12 },
  ]);
});

test("imports nested Extract parsing as bundled Parse configuration", () => {
  const extract = JSON.parse(DEEP_EXTRACT_CONFIG);
  extract.parsing = JSON.parse(RICH_PARSE_CONFIG);
  const result = importReductoCode(JSON.stringify(extract));

  assert.equal(result.applicable, true);
  assert.deepEqual(result.detected.operations, ["parse", "extract"]);
  assert.deepEqual(result.pipeline.extract.settings.page_range, { start: 1, end: 5 });
  assert.deepEqual(result.pipeline.parse, {});
  assert.deepEqual(result.pipeline.lumos_assumptions.unpriced_cost_factors, [
    "extract.include_images",
  ]);
});

test("keeps endpoint-owned nested Parse ranges isolated", () => {
  const extractWithParsing = JSON.parse(DEEP_EXTRACT_CONFIG);
  extractWithParsing.parsing = JSON.parse(RICH_PARSE_CONFIG);
  const extractOwned = importReductoCode(
    `${JSON.stringify(extractWithParsing)}\n${SPLIT_CONFIG}`,
  );

  assert.equal(extractOwned.applicable, true);
  assert.deepEqual(extractOwned.pipeline.extract.settings.page_range, {
    start: 1,
    end: 5,
  });
  assert.equal(extractOwned.pipeline.split.parsing, undefined);

  const splitWithParsing = JSON.parse(SPLIT_CONFIG);
  splitWithParsing.parsing = JSON.parse(RICH_PARSE_CONFIG);
  const splitOwned = importReductoCode(
    `${DEEP_EXTRACT_CONFIG}\n${JSON.stringify(splitWithParsing)}`,
  );

  assert.equal(splitOwned.applicable, true);
  assert.equal(splitOwned.pipeline.extract.settings.page_range, undefined);
  assert.deepEqual(splitOwned.pipeline.split.parsing.settings.page_range, {
    start: 1,
    end: 5,
  });
});

test("treats embedding-optimized Parse retrieval as included in bundled Extract pricing", () => {
  const parse = JSON.parse(PARSE_CONFIG);
  parse.enhance.summarize_figures = false;
  parse.retrieval.embedding_optimized = true;
  const result = importReductoCode(
    `${JSON.stringify(parse)}\n${SCHEMALESS_EXTRACT_CONFIG}`,
  );

  assert.equal(result.applicable, true);
  assert.deepEqual(result.pipeline.parse, {});
  assert.deepEqual(result.pipeline.lumos_assumptions.unpriced_cost_factors, [
    "extract.field_density",
  ]);
  assert.doesNotMatch(result.warnings.join(" "), /bundled Parse enhancements/i);
});

test("treats advanced charts as included when Parse is bundled downstream", () => {
  const parse = JSON.parse(RICH_PARSE_CONFIG);
  parse.enhance.agentic[0].advanced_chart_agent = true;
  const result = importReductoCode(
    `${JSON.stringify(parse)}\n${SCHEMALESS_EXTRACT_CONFIG}`,
  );

  assert.equal(result.applicable, true);
  assert.equal(result.detected.advancedChart, true);
  assert.deepEqual(result.pipeline.parse, {});
  assert.deepEqual(result.pipeline.lumos_assumptions.unpriced_cost_factors, [
    "extract.field_density",
  ]);
  assert.doesNotMatch(result.warnings.join(" "), /advanced chart/i);
});

test("imports all-page and ranged nested Split parsing", () => {
  const split = JSON.parse(SPLIT_CONFIG);
  split.parsing = JSON.parse(PARSE_CONFIG);
  const allPages = importReductoCode(JSON.stringify(split));
  assert.equal(allPages.applicable, true);
  assert.deepEqual(allPages.detected.operations, ["parse", "split"]);

  split.parsing = JSON.parse(RICH_PARSE_CONFIG);
  const ranged = importReductoCode(JSON.stringify(split));
  assert.equal(ranged.applicable, true);
  assert.deepEqual(ranged.pipeline.split.parsing, {
    settings: { page_range: { start: 1, end: 5 } },
  });
  assert.match(ranged.warnings.join(" "), /Parse page range.*downstream Split/i);
});

test("fails closed when separate and nested Parse configurations conflict", () => {
  const extract = JSON.parse(DEEP_EXTRACT_CONFIG);
  extract.parsing = JSON.parse(RICH_PARSE_CONFIG);
  const result = importReductoCode(
    `${PARSE_CONFIG}\n${JSON.stringify(extract)}`,
  );

  assert.equal(result.applicable, false);
  assert.match(result.error, /conflicts.*bundled Parse settings/i);
});

test("does not silently ignore a different endpoint shape inside parsing", () => {
  const extract = JSON.parse(DEEP_EXTRACT_CONFIG);
  extract.parsing = {
    instructions: { schema: { type: "object" } },
  };
  const result = importReductoCode(JSON.stringify(extract));

  assert.equal(result.applicable, false);
  assert.match(result.error, /Parse configuration.*instructions.*another endpoint/i);
});

test("accepts a JSON array containing every supported pricing configuration", () => {
  const result = importReductoCode(
    JSON.stringify([
      JSON.parse(PARSE_CONFIG),
      JSON.parse(CLASSIFY_CONFIG),
      JSON.parse(DEEP_EXTRACT_CONFIG),
      JSON.parse(SPLIT_CONFIG),
      JSON.parse(EDIT_CONFIG),
    ]),
  );

  assert.equal(result.applicable, true);
  assert.deepEqual(result.detected.operations, [
    "parse",
    "classify",
    "extract",
    "split",
    "edit",
  ]);
  assert.deepEqual(result.pipeline.classify.page_range, { start: 1, end: 3 });
  assert.equal(result.pipeline.extract.settings.deep_extract, true);
  assert.equal(result.pipeline.split.settings.deep_split, true);
  assert.deepEqual(result.pipeline.edit, {});
  assert.equal(result.detected.spreadsheet, false);
});

test("preserves every accepted endpoint configuration for builder review", () => {
  const expected = {
    parse: JSON.parse(RICH_PARSE_CONFIG),
    classify: JSON.parse(CLASSIFY_CONFIG),
    extract: JSON.parse(DEEP_EXTRACT_CONFIG),
    split: JSON.parse(SPLIT_CONFIG),
    edit: JSON.parse(EDIT_CONFIG),
  };
  const result = importReductoCode(JSON.stringify(Object.values(expected)));

  assert.equal(result.applicable, true);
  assert.deepEqual(result.configurations, expected);
  assert.equal(result.configurations.parse.formatting.table_output_format, "html");
  assert.equal(result.configurations.parse.retrieval.chunking.chunk_size, 1000);
  assert.deepEqual(result.configurations.parse.spreadsheet.include, [
    "dropdowns",
    "formula",
    "cell_colors",
  ]);
  assert.equal(result.configurations.extract.settings.citations.enabled, true);
  assert.equal(
    result.configurations.split.split_rules,
    "Split the document into the applicable sections. Sections may only overlap at their first and last page if at all.",
  );
  assert.equal(
    result.configurations.classify.classification_schema.properties.document_type.type,
    "string",
  );
  assert.equal(
    result.configurations.edit.edit_instructions,
    "Fill the highlighted fields using the extracted values.",
  );
});

test("keeps raw cost fields exact while retaining the normalized pricing pipeline", () => {
  const result = importReductoCode(
    `${RICH_PARSE_CONFIG}\n${DEEP_EXTRACT_CONFIG}\n${SPLIT_CONFIG}`,
  );

  assert.equal(result.applicable, true);
  assert.deepEqual(result.configurations.parse.settings.page_range, {
    end: 5,
    start: 1,
  });
  assert.equal(result.configurations.extract.settings.deep_extract, true);
  assert.equal(result.configurations.extract.settings.include_images, true);
  assert.equal(result.configurations.extract.settings.optimize_for_latency, true);
  assert.equal(result.configurations.split.deep_split, true);
  assert.equal(result.configurations.split.split_options.table_cutoff, "truncate");
  assert.equal(result.configurations.split.settings, undefined);
  assert.deepEqual(result.pipeline.extract.settings.page_range, { start: 1, end: 5 });
  assert.deepEqual(result.pipeline.split.parsing.settings.page_range, {
    start: 1,
    end: 5,
  });
  assert.equal(result.pipeline.split.settings.deep_split, true);
});

test("keeps endpoint-local nested parsing in independent configuration snapshots", () => {
  const extract = JSON.parse(DEEP_EXTRACT_CONFIG);
  extract.parsing = JSON.parse(RICH_PARSE_CONFIG);
  const split = JSON.parse(SPLIT_CONFIG);
  split.parsing = JSON.parse(PARSE_CONFIG);
  const result = importReductoCode(
    `${JSON.stringify(extract)}\n${JSON.stringify(split)}`,
  );

  assert.equal(result.applicable, true);
  assert.equal(result.configurations.parse, null);
  assert.deepEqual(result.configurations.extract.parsing, extract.parsing);
  assert.deepEqual(result.configurations.split.parsing, split.parsing);

  result.configurations.extract.settings.deep_extract = false;
  result.configurations.extract.parsing.settings.page_range.start = 99;
  result.configurations.split.parsing.enhance.summarize_figures = false;

  assert.equal(result.pipeline.extract.settings.deep_extract, true);
  assert.deepEqual(result.pipeline.extract.settings.page_range, { start: 1, end: 5 });
  assert.equal(result.pipeline.split.parsing, undefined);
});

test("does not expose partially accepted configurations when import fails", () => {
  const result = importReductoCode(`{
    "instructions": {"schema": {"type": "object"}},
    "settings": {"future_billed_mode": true}
  }`);

  assert.equal(result.applicable, false);
  assert.deepEqual(result.configurations, {
    parse: null,
    classify: null,
    extract: null,
    split: null,
    edit: null,
  });
});

test("allows Parse plus Split when Parse covers all pages", () => {
  const result = importReductoCode(`${PARSE_CONFIG}\n${SPLIT_CONFIG}`);

  assert.equal(result.applicable, true);
  assert.deepEqual(result.detected.operations, ["parse", "split"]);
  assert.equal(result.pipeline.extract, null);
  assert.deepEqual(result.pipeline.parse, {});
  assert.equal(result.pipeline.split.settings.deep_split, true);
  assert.equal(result.pipeline.lumos_assumptions.unpriced_cost_factors, undefined);
});

test("prices Parse as standalone when Classify is the only other operation", () => {
  const result = importReductoCode(`${PARSE_CONFIG}\n${CLASSIFY_CONFIG}`);

  assert.equal(result.applicable, true);
  assert.deepEqual(result.detected.operations, ["parse", "classify"]);
  assert.deepEqual(result.pipeline.parse, { enhance: { agentic: [] } });
  assert.deepEqual(result.pipeline.classify, {
    page_range: { start: 1, end: 3 },
  });
  assert.equal(result.pipeline.lumos_assumptions.likely_complex_parse_share, 0.5);
});

test("preserves standalone Parse queue priority and rejects Batch Parse when bundled", () => {
  const batchParse = JSON.parse(PARSE_CONFIG);
  batchParse.queue_priority = "batch";

  const standalone = importReductoCode(JSON.stringify(batchParse));
  assert.equal(standalone.applicable, true);
  assert.equal(standalone.pipeline.parse.queue_priority, "batch");
  assert.equal(standalone.configurations.parse.queue_priority, "batch");

  const bundled = importReductoCode(
    `${JSON.stringify(batchParse)}\n${DEEP_EXTRACT_CONFIG}`,
  );
  assert.equal(bundled.applicable, false);
  assert.match(bundled.error, /Batch Parse.*standalone/i);

  const invalid = importReductoCode(`{
    "enhance": {"agentic": []},
    "queue_priority": "urgent"
  }`);
  assert.equal(invalid.applicable, false);
  assert.match(invalid.error, /queue_priority.*auto.*batch/i);
});

test("maps a separate ranged Parse configuration into the canonical Split shape", () => {
  const result = importReductoCode(`${RICH_PARSE_CONFIG}\n${SPLIT_CONFIG}`);

  assert.equal(result.applicable, true);
  assert.deepEqual(result.pipeline.split.parsing.settings.page_range, {
    start: 1,
    end: 5,
  });
});

test("applies one ranged Parse config to both Extract and Split", () => {
  const result = importReductoCode(
    `${RICH_PARSE_CONFIG}\n${DEEP_EXTRACT_CONFIG}\n${SPLIT_CONFIG}`,
  );

  assert.equal(result.applicable, true);
  assert.deepEqual(result.pipeline.extract.settings.page_range, { start: 1, end: 5 });
  assert.deepEqual(result.pipeline.split.parsing.settings.page_range, {
    start: 1,
    end: 5,
  });
});

test("fails closed for an object that mixes endpoint configuration shapes", () => {
  const result = importReductoCode(`{
    "enhance": {"agentic": []},
    "instructions": {"schema": {"type": "object"}}
  }`);

  assert.equal(result.applicable, false);
  assert.equal(result.pipeline, null);
  assert.match(result.error, /multiple Reducto configurations/i);
});

test("fails closed for duplicate endpoint configs and duplicate JSON keys", () => {
  const duplicateEndpoint = importReductoCode(
    `${SCHEMALESS_EXTRACT_CONFIG}\n${DEEP_EXTRACT_CONFIG}`,
  );
  assert.equal(duplicateEndpoint.applicable, false);
  assert.match(duplicateEndpoint.error, /More than one Extract configuration/i);

  const duplicateKey = importReductoCode(`{
    "instructions": {"schema": {"type": "object"}},
    "settings": {"deep_extract": false, "deep_extract": true}
  }`);
  assert.equal(duplicateKey.applicable, false);
  assert.match(duplicateKey.error, /duplicate.*deep_extract/i);
});

test("accepts a JSON code fence but never treats Python as configuration JSON", () => {
  const fenced = importReductoCode(`\`\`\`json\n${DEEP_EXTRACT_CONFIG}\n\`\`\``);
  assert.equal(fenced.applicable, true);
  assert.equal(fenced.detected.source, "json");

  const python = importReductoCode(`client.extract.run(
    input=upload,
    settings={"deep_extract": True}
  )`);
  assert.equal(python.applicable, false);
  assert.equal(python.pipeline, null);
  assert.equal(python.detected.source, "json");
  assert.match(python.error, /invalid JSON/i);
});

test("rejects unknown, malformed, and non-object configuration values", () => {
  for (const source of [
    `{"settings": {"unknown_option": true}}`,
    `{"settings": {"citations": {"enabled": true}}}`,
    `{"instructions":`,
    `["extract"]`,
  ]) {
    const result = importReductoCode(source);
    assert.equal(result.applicable, false, source);
    assert.equal(result.pipeline, null, source);
  }
});

test("fails closed for unknown cost settings and a Classify range array", () => {
  const futureExtract = importReductoCode(`{
    "instructions": {
      "schema": {
        "type": "object",
        "properties": {"Name": {"type": "string"}}
      }
    },
    "settings": {"future_billed_mode": true}
  }`);
  assert.equal(futureExtract.applicable, false);
  assert.match(futureExtract.error, /Extract settings.*future_billed_mode/i);

  const classifyArray = JSON.parse(CLASSIFY_CONFIG);
  classifyArray.page_range = [
    { start: 1, end: 1 },
    { start: 2, end: 2 },
  ];
  const classify = importReductoCode(JSON.stringify(classifyArray));
  assert.equal(classify.applicable, false);
  assert.match(classify.error, /Classify page_range must be one object/i);
});
