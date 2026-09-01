import type {
  ReductoImportedConfigurations,
  ReductoJsonObject,
  ReductoJsonValue,
} from "./reducto-code-import";
import type { PublicPageRange, PublicPipeline } from "./pricing";

export type ManualEndpoint = "parse" | "classify" | "extract" | "split" | "edit";
export type ManualParseMode = "standard" | "agentic";
export type ManualParsePricingModel = "legacy" | "r-1";
export type ManualExtractMode = "off" | "standard" | "deep" | "conditional";
export type ManualSplitMode = "off" | "standard" | "deep";

export type ManualPageRangeDraft = {
  id?: string;
  start: string;
  end: string;
};

export type ManualPageSelectionDraft = {
  mode: "all" | "selected";
  ranges: ManualPageRangeDraft[];
};

/**
 * String values deliberately remain strings while a user edits the form. This
 * lets the builder represent empty and partially entered values without ever
 * putting an invalid value into a PublicPipeline.
 */
export type ManualPipelineDraft = {
  parse: {
    enabled: boolean;
    /** Parse configuration imported as part of downstream Extract or Split pricing. */
    includedDownstream: boolean;
    pricingModel: ManualParsePricingModel;
    mode: ManualParseMode;
    agenticScopes: { text: boolean; table: boolean; figure: boolean };
    advancedChart: boolean;
    batch: boolean;
    pageSelection: ManualPageSelectionDraft;
    /** Imported-only r-1 inputs are retained without adding speculative form controls. */
    returnOcrData?: boolean;
    preservedAgentic?: ReductoJsonObject[];
  };
  classify: { enabled: boolean; start: string; end: string };
  extract: {
    mode: ManualExtractMode;
    includeImages: boolean;
    optimizeForLatency: boolean;
    pageSelection: ManualPageSelectionDraft;
  };
  split: { mode: ManualSplitMode; pageSelection: ManualPageSelectionDraft };
  edit: { enabled: boolean; fullyPrefilledPages: string };
  assumptions: {
    complexSharePercent: string;
    chartCountsEnabled: boolean;
    likelyChartCount: string;
    maximumChartCount: string;
    extractFieldsPerPage: string;
    deepSharePercent: string;
    /** Imported exclusions stay visible and survive review and reapplication. */
    unpricedCostFactors: string[];
  };
  /** Accepted Reducto JSON is retained so review never strips neutral settings. */
  importedConfigurations?: ReductoImportedConfigurations;
};

export type ManualPipelineErrors = Record<string, string>;

export type ManualPipelineConversionResult =
  | {
      ok: true;
      pipeline: PublicPipeline;
      configurations: ReductoImportedConfigurations;
      errors: Record<string, never>;
    }
  | { ok: false; pipeline: null; configurations: null; errors: ManualPipelineErrors };

const pageSelection = (prefix: string): ManualPageSelectionDraft => ({
  mode: "all",
  ranges: [{ id: `${prefix}-page-range-1`, start: "1", end: "1" }],
});

export const DEFAULT_MANUAL_PIPELINE_DRAFT: ManualPipelineDraft = {
  parse: {
    enabled: false,
    includedDownstream: false,
    pricingModel: "legacy",
    mode: "standard",
    agenticScopes: { text: false, table: false, figure: false },
    advancedChart: false,
    batch: false,
    pageSelection: pageSelection("parse"),
  },
  classify: { enabled: false, start: "1", end: "5" },
  extract: {
    mode: "standard",
    includeImages: false,
    optimizeForLatency: false,
    pageSelection: pageSelection("extract"),
  },
  split: { mode: "off", pageSelection: pageSelection("split") },
  edit: { enabled: false, fullyPrefilledPages: "0" },
  assumptions: {
    complexSharePercent: "50",
    chartCountsEnabled: false,
    likelyChartCount: "0",
    maximumChartCount: "0",
    extractFieldsPerPage: "24",
    deepSharePercent: "25",
    unpricedCostFactors: [],
  },
};

type ParsedNumber = { valid: true; value: number } | { valid: false };

function wholeNumber(value: string, minimum = 0): ParsedNumber {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return { valid: false };
  const number = Number(trimmed);
  if (!Number.isSafeInteger(number) || number < minimum) return { valid: false };
  return { valid: true, value: number };
}

function percentage(value: string): ParsedNumber {
  const trimmed = value.trim();
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) return { valid: false };
  const number = Number(trimmed);
  if (!Number.isFinite(number) || number < 0 || number > 100) return { valid: false };
  return { valid: true, value: number };
}

function firstError(errors: ManualPipelineErrors, field: string, message: string) {
  if (!errors[field]) errors[field] = message;
}

function validatedPageRange(
  selection: ManualPageSelectionDraft,
  errors: ManualPipelineErrors,
  field: "parse.pageSelection" | "extract.pageSelection" | "split.pageSelection",
): PublicPageRange | undefined {
  if (selection.mode === "all") return undefined;
  if (selection.mode !== "selected" || selection.ranges.length === 0) {
    firstError(errors, field, "Add at least one page range or choose All pages.");
    return undefined;
  }

  const parsedRanges: Array<{ start: number; end: number }> = [];
  selection.ranges.forEach((range, index) => {
    const start = wholeNumber(range.start, 1);
    const end = wholeNumber(range.end, 1);
    if (!start.valid) {
      firstError(
        errors,
        `${field}.ranges.${index}.start`,
        "Use a whole starting page of 1 or greater.",
      );
      firstError(errors, field, "Check the selected page ranges.");
    }
    if (!end.valid) {
      firstError(
        errors,
        `${field}.ranges.${index}.end`,
        "Use a whole ending page of 1 or greater.",
      );
      firstError(errors, field, "Check the selected page ranges.");
    }
    if (start.valid && end.valid && end.value < start.value) {
      firstError(
        errors,
        `${field}.ranges.${index}.end`,
        "The ending page must be the same as or greater than the starting page.",
      );
      firstError(errors, field, "Check the selected page ranges.");
    }
    if (start.valid && end.valid && end.value >= start.value) {
      parsedRanges.push({ start: start.value, end: end.value });
    }
  });

  if (errors[field]) return undefined;
  return parsedRanges.length === 1 ? parsedRanges[0] : parsedRanges;
}

function sanitizedUnpricedFactors(factors: string[]) {
  return [
    ...new Set(
      factors
        .map((factor) => factor.trim())
        .filter((factor) => factor.length > 0 && factor.length <= 100)
        .slice(0, 20),
    ),
  ];
}

function emptyConfigurations(): ReductoImportedConfigurations {
  return { parse: null, classify: null, extract: null, split: null, edit: null };
}

function isJsonObject(value: ReductoJsonValue | undefined): value is ReductoJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJsonValue(value: ReductoJsonValue): ReductoJsonValue {
  if (Array.isArray(value)) return value.map((item) => cloneJsonValue(item));
  if (!isJsonObject(value)) return value;
  const clone: ReductoJsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    Object.defineProperty(clone, key, {
      configurable: true,
      enumerable: true,
      value: cloneJsonValue(child),
      writable: true,
    });
  }
  return clone;
}

function cloneConfigurations(
  source: ReductoImportedConfigurations | undefined,
): ReductoImportedConfigurations {
  const fallback = emptyConfigurations();
  if (!source) return fallback;
  for (const endpoint of Object.keys(fallback) as ManualEndpoint[]) {
    const config = source[endpoint];
    fallback[endpoint] = config ? (cloneJsonValue(config) as ReductoJsonObject) : null;
  }
  return fallback;
}

function objectChild(owner: ReductoJsonObject, key: string) {
  if (isJsonObject(owner[key])) return owner[key] as ReductoJsonObject;
  const child: ReductoJsonObject = {};
  owner[key] = child;
  return child;
}

function removeEmptyChild(owner: ReductoJsonObject, key: string) {
  if (isJsonObject(owner[key]) && Object.keys(owner[key] as ReductoJsonObject).length === 0) {
    delete owner[key];
  }
}

function agenticEntries(
  draft: ManualPipelineDraft,
  existingValue?: ReductoJsonValue,
) {
  if (
    (!draft.parse.enabled && !draft.parse.includedDownstream) ||
    (draft.parse.mode !== "agentic" && !draft.parse.advancedChart)
  ) return [];
  const scopes = { ...draft.parse.agenticScopes };
  if (draft.parse.advancedChart) scopes.figure = true;
  const importedEnhance = draft.importedConfigurations?.parse?.enhance;
  const fallbackValue = isJsonObject(importedEnhance) ? importedEnhance.agentic : undefined;
  const sourceAgentic = existingValue ?? fallbackValue ?? draft.parse.preservedAgentic;
  const existingAgentic = Array.isArray(sourceAgentic)
    ? sourceAgentic.filter(isJsonObject)
    : [];

  const selectedScopes = new Set(
    (["text", "table", "figure"] as const).filter((scope) => scopes[scope]),
  );
  const nextEntries = existingAgentic
    .filter(
      (entry) =>
        (entry.scope === "text" || entry.scope === "table" || entry.scope === "figure") &&
        selectedScopes.has(entry.scope),
    )
    .map((entry) => cloneJsonValue(entry) as ReductoJsonObject);
  for (const scope of selectedScopes) {
    if (!nextEntries.some((entry) => entry.scope === scope)) nextEntries.push({ scope });
  }
  nextEntries.forEach((entry) => {
    if (entry.scope !== "figure" || !draft.parse.advancedChart) {
      delete entry.advanced_chart_agent;
      delete entry.advanced_chart_extraction;
      delete entry.chart_agent;
    }
  });
  if (draft.parse.advancedChart) {
    const figures = nextEntries.filter((entry) => entry.scope === "figure");
    if (!figures.some((entry) => entry.advanced_chart_agent === true)) {
      figures[0].advanced_chart_agent = true;
    }
  }
  return nextEntries;
}

function writePageRange(
  settings: ReductoJsonObject,
  range: PublicPageRange | undefined,
) {
  if (range === undefined) delete settings.page_range;
  else settings.page_range = cloneJsonValue(range as ReductoJsonValue);
}

function agenticDraftDiffersFromImported(draft: ManualPipelineDraft) {
  const imported = rawAgentic(draft.importedConfigurations);
  const importedScopes = {
    text: imported.some((entry) => entry.scope === "text"),
    table: imported.some((entry) => entry.scope === "table"),
    figure: imported.some((entry) => entry.scope === "figure"),
  };
  const importedAdvancedChart = imported.some(
    (entry) =>
      entry.scope === "figure" &&
      (
        entry.advanced_chart_agent === true ||
        entry.advanced_chart_extraction === true ||
        entry.chart_agent === true
      ),
  );
  const draftAgentic =
    (draft.parse.enabled || draft.parse.includedDownstream) &&
    (draft.parse.mode === "agentic" || draft.parse.advancedChart);
  return (
    draftAgentic !== (imported.length > 0) ||
    draft.parse.advancedChart !== importedAdvancedChart ||
    (draftAgentic &&
      (draft.parse.agenticScopes.text !== importedScopes.text ||
        draft.parse.agenticScopes.table !== importedScopes.table ||
        draft.parse.agenticScopes.figure !== importedScopes.figure))
  );
}

/** Generate cost-focused endpoint fragments using Reducto's current field paths. */
export function manualDraftToReductoConfigurations(
  draft: ManualPipelineDraft,
  ranges?: {
    parse?: PublicPageRange;
    extract?: PublicPageRange;
    split?: PublicPageRange;
    classify?: { start: number; end: number };
  },
): ReductoImportedConfigurations {
  const configs = cloneConfigurations(draft.importedConfigurations);
  const hasExtract = draft.extract.mode !== "off";
  const hasSplit = draft.split.mode !== "off";
  const standaloneParse = draft.parse.enabled;
  const bundledParse =
    draft.parse.includedDownstream && (hasExtract || hasSplit);
  const nestedParseOwners = [configs.extract, configs.split].filter(
    (configuration): configuration is ReductoJsonObject =>
      isJsonObject(configuration) && isJsonObject(configuration.parsing),
  );
  const importedTopLevelParse = configs.parse !== null;
  const agenticChanged = agenticDraftDiffersFromImported(draft);

  if (standaloneParse || bundledParse) {
    if (importedTopLevelParse || nestedParseOwners.length === 0) {
      const parse = configs.parse ?? {};
      if (agenticChanged || !importedTopLevelParse) {
        const enhance = objectChild(parse, "enhance");
        enhance.agentic = agenticEntries(draft, enhance.agentic);
        delete enhance.advanced_chart_agent;
        delete enhance.advanced_chart_extraction;
        delete enhance.chart_agent;
      }
      if (standaloneParse) {
        const settings = objectChild(parse, "settings");
        settings.model = draft.parse.pricingModel;
        if (draft.parse.returnOcrData !== undefined) {
          settings.return_ocr_data = draft.parse.returnOcrData;
        }
        writePageRange(settings, ranges?.parse);
        removeEmptyChild(parse, "settings");
        parse.queue_priority = draft.parse.batch ? "batch" : "auto";
      }
      configs.parse = parse;
    } else {
      configs.parse = null;
    }
  } else configs.parse = null;

  if (agenticChanged) {
    for (const owner of nestedParseOwners) {
      const parsing = objectChild(owner, "parsing");
      const enhance = objectChild(parsing, "enhance");
      enhance.agentic = agenticEntries(draft, enhance.agentic);
      delete enhance.advanced_chart_agent;
      delete enhance.advanced_chart_extraction;
      delete enhance.chart_agent;
    }
  }

  if (draft.classify.enabled) {
    const classify = configs.classify ?? {};
    if (ranges?.classify) {
      classify.page_range = { ...ranges.classify };
    }
    configs.classify = classify;
  } else configs.classify = null;

  if (hasExtract) {
    const extract = configs.extract ?? {};
    const settings = objectChild(extract, "settings");
    settings.deep_extract = draft.extract.mode === "deep";
    settings.include_images = draft.extract.includeImages;
    settings.optimize_for_latency = draft.extract.optimizeForLatency;
    delete settings.page_range;
    const parsing = objectChild(extract, "parsing");
    const parsingSettings = objectChild(parsing, "settings");
    writePageRange(parsingSettings, ranges?.extract);
    removeEmptyChild(parsing, "settings");
    removeEmptyChild(extract, "parsing");
    configs.extract = extract;
  } else configs.extract = null;

  if (hasSplit) {
    const split = configs.split ?? {};
    delete split.deep_split;
    const settings = objectChild(split, "settings");
    settings.deep_split = draft.split.mode === "deep";
    const parsing = objectChild(split, "parsing");
    const parsingSettings = objectChild(parsing, "settings");
    writePageRange(parsingSettings, ranges?.split);
    removeEmptyChild(parsing, "settings");
    removeEmptyChild(split, "parsing");
    configs.split = split;
  } else configs.split = null;

  configs.edit = draft.edit.enabled ? (configs.edit ?? {}) : null;
  return configs;
}

/** Convert the Reducto-native visual draft into the canonical strict API pipeline. */
export function manualDraftToPipeline(
  draft: ManualPipelineDraft,
  documentTotalPages?: number,
): ManualPipelineConversionResult {
  const errors: ManualPipelineErrors = {};
  const hasExtract = draft.extract.mode !== "off";
  const hasSplit = draft.split.mode !== "off";
  const standaloneParse = draft.parse.enabled;
  const bundledParse =
    draft.parse.includedDownstream && (hasExtract || hasSplit);

  if (standaloneParse && (hasExtract || hasSplit)) {
    errors["parse.enabled"] =
      "Standalone Parse cannot be combined with Extract or Split because their rates already include parsing.";
  }

  if (
    !draft.parse.enabled &&
    !draft.classify.enabled &&
    !hasExtract &&
    !hasSplit &&
    !draft.edit.enabled
  ) {
    errors.operations = "Choose at least one endpoint before applying the configuration.";
  }

  if (
    standaloneParse &&
    draft.parse.mode === "agentic" &&
    !draft.parse.advancedChart &&
    !Object.values(draft.parse.agenticScopes).some(Boolean)
  ) {
    errors["parse.agenticScopes"] = "Choose Text, Table, or Figure for Agentic Parse.";
  }

  const parseAgenticEntries = agenticEntries(draft);
  if (
    standaloneParse &&
    draft.parse.pricingModel === "r-1" &&
    parseAgenticEntries.some(
      (entry) =>
        (typeof entry.prompt !== "string" || !entry.prompt.trim()) &&
        !(entry.scope === "figure" && entry.advanced_chart_agent === true),
    )
  ) {
    errors["parse.agenticScopes"] =
      "r-1 Agentic scopes require a prompt. Remove the promptless scope or select Legacy Parse.";
  }

  const parsePageRange = standaloneParse
    ? validatedPageRange(draft.parse.pageSelection, errors, "parse.pageSelection")
    : undefined;
  const extractPageRange = hasExtract
    ? validatedPageRange(draft.extract.pageSelection, errors, "extract.pageSelection")
    : undefined;
  const splitPageRange = hasSplit
    ? validatedPageRange(draft.split.pageSelection, errors, "split.pageSelection")
    : undefined;

  let classifyStart = 1;
  let classifyEnd = 5;
  if (draft.classify.enabled) {
    const start = wholeNumber(draft.classify.start, 1);
    const end = wholeNumber(draft.classify.end, 1);
    if (!start.valid) errors["classify.start"] = "Use a whole starting page of 1 or greater.";
    else classifyStart = start.value;
    if (!end.valid) errors["classify.end"] = "Use a whole ending page of 1 or greater.";
    else classifyEnd = end.value;
    if (start.valid && end.valid) {
      if (end.value < start.value) {
        errors["classify.end"] =
          "The ending page must be the same as or greater than the starting page.";
      } else if (end.value - start.value + 1 > 10) {
        errors["classify.end"] = "Classify can use up to 10 context pages.";
      }
    }
  }

  let complexShare = 50;
  if (standaloneParse && draft.parse.pricingModel === "legacy") {
    const parsed = percentage(draft.assumptions.complexSharePercent);
    if (!parsed.valid) {
      errors["assumptions.complexSharePercent"] =
        "Enter an expected Complex-page share from 0% to 100%.";
    } else complexShare = parsed.value;
  }

  let likelyChartCount = 0;
  let maximumChartCount = 0;
  const usesChartCounts =
    standaloneParse &&
    draft.parse.pricingModel === "legacy" &&
    draft.parse.advancedChart &&
    draft.assumptions.chartCountsEnabled;
  if (usesChartCounts) {
    const likely = wholeNumber(draft.assumptions.likelyChartCount);
    const maximum = wholeNumber(draft.assumptions.maximumChartCount);
    if (!likely.valid) {
      errors["assumptions.likelyChartCount"] =
        "Use a whole likely chart count of 0 or greater.";
    } else likelyChartCount = likely.value;
    if (!maximum.valid) {
      errors["assumptions.maximumChartCount"] =
        "Use a whole maximum chart count of 0 or greater.";
    } else maximumChartCount = maximum.value;
    if (likely.valid && maximum.valid && maximum.value < likely.value) {
      errors["assumptions.maximumChartCount"] =
        "The maximum chart count must be at least the likely count.";
    }
  }

  let deepShare = 25;
  if (draft.extract.mode === "conditional") {
    const parsed = percentage(draft.assumptions.deepSharePercent);
    if (!parsed.valid) {
      errors["assumptions.deepSharePercent"] =
        "Enter an expected Deep Extract share from 0% to 100%.";
    } else deepShare = parsed.value;
  }

  let fieldsPerPage: number | undefined;
  if (hasExtract && draft.assumptions.extractFieldsPerPage.trim() !== "") {
    const parsed = wholeNumber(draft.assumptions.extractFieldsPerPage);
    if (!parsed.valid) {
      errors["assumptions.extractFieldsPerPage"] =
        "Use a whole expected field count of 0 or greater.";
    } else fieldsPerPage = parsed.value;
  }

  let fullyPrefilledPages = 0;
  if (draft.edit.enabled) {
    const parsed = wholeNumber(draft.edit.fullyPrefilledPages);
    if (!parsed.valid) {
      errors["edit.fullyPrefilledPages"] =
        "Use a whole fully prefilled page count of 0 or greater.";
    } else {
      fullyPrefilledPages = parsed.value;
      if (
        documentTotalPages !== undefined &&
        Number.isSafeInteger(documentTotalPages) &&
        documentTotalPages >= 0 &&
        parsed.value > documentTotalPages
      ) {
        errors["edit.fullyPrefilledPages"] =
          "Fully prefilled Edit pages cannot exceed the uploaded page total.";
      }
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, pipeline: null, configurations: null, errors };
  }

  const agentic = parseAgenticEntries.map((entry) => ({
    scope: entry.scope as "text" | "table" | "figure",
    ...(typeof entry.mode === "string" ? { mode: entry.mode } : {}),
    ...(typeof entry.prompt === "string" ? { prompt: entry.prompt } : {}),
    ...(entry.advanced_chart_agent === true ? { advanced_chart_agent: true } : {}),
  }));

  const parse: PublicPipeline["parse"] = standaloneParse
    ? {
        ...(agentic.length > 0 ? { enhance: { agentic } } : {}),
        settings: {
          model: draft.parse.pricingModel,
          ...(draft.parse.returnOcrData !== undefined
            ? { return_ocr_data: draft.parse.returnOcrData }
            : {}),
          ...(parsePageRange ? { page_range: parsePageRange } : {}),
        },
        ...(standaloneParse && draft.parse.batch ? { queue_priority: "batch" as const } : {}),
      }
    : bundledParse
      ? {}
      : null;

  const extract: PublicPipeline["extract"] = hasExtract
    ? {
        settings: {
          deep_extract: draft.extract.mode === "deep",
          optimize_for_latency: draft.extract.optimizeForLatency,
          include_images: draft.extract.includeImages,
          ...(extractPageRange ? { page_range: extractPageRange } : {}),
        },
      }
    : null;

  const split: PublicPipeline["split"] = hasSplit
    ? {
        settings: { deep_split: draft.split.mode === "deep" },
        ...(splitPageRange
          ? { parsing: { settings: { page_range: splitPageRange } } }
          : {}),
      }
    : null;

  const unpricedCostFactors = sanitizedUnpricedFactors(
    draft.assumptions.unpricedCostFactors,
  ).filter(
    (factor) =>
      factor !== "extract.include_images" &&
      factor !== "extract.field_density" &&
      factor !== "parse.advanced_chart_count",
  );
  const pipeline: PublicPipeline = {
    parse,
    classify: draft.classify.enabled
      ? { page_range: { start: classifyStart, end: classifyEnd } }
      : null,
    extract,
    split,
    edit: draft.edit.enabled ? {} : null,
    lumos_assumptions: {
      ...(standaloneParse && draft.parse.pricingModel === "legacy"
        ? { likely_complex_parse_share: complexShare / 100 }
        : {}),
      ...(usesChartCounts
        ? {
            advanced_chart_counts: {
              likely: likelyChartCount,
              maximum: maximumChartCount,
            },
          }
        : {}),
      ...(hasExtract
        ? { conditional_extract_routing: draft.extract.mode === "conditional" }
        : {}),
      ...(draft.extract.mode === "conditional"
        ? { likely_deep_extract_share: deepShare / 100 }
        : {}),
      ...(hasExtract && fieldsPerPage !== undefined
        ? { estimated_extract_fields_per_page: fieldsPerPage }
        : {}),
      ...(draft.edit.enabled
        ? { known_fully_prefilled_edit_pages: fullyPrefilledPages }
        : {}),
      ...(unpricedCostFactors.length > 0
        ? { unpriced_cost_factors: unpricedCostFactors }
        : {}),
    },
  };

  return {
    ok: true,
    pipeline,
    configurations: manualDraftToReductoConfigurations(draft, {
      parse: parsePageRange,
      extract: extractPageRange,
      split: splitPageRange,
      classify: draft.classify.enabled
        ? { start: classifyStart, end: classifyEnd }
        : undefined,
    }),
    errors: {},
  };
}

function pageRangesFromPublic(pageRange: PublicPageRange | null | undefined) {
  if (pageRange == null) return [];
  if (!Array.isArray(pageRange)) return [pageRange];
  if (pageRange.length === 0) return [];
  if (typeof pageRange[0] === "number") {
    return (pageRange as number[]).map((page) => ({ start: page, end: page }));
  }
  return pageRange as Array<{ start: number; end: number }>;
}

function pageSelectionFromPublic(
  pageRange: PublicPageRange | null | undefined,
  idPrefix: string,
): ManualPageSelectionDraft {
  const pageRanges = pageRangesFromPublic(pageRange);
  return {
    mode: pageRanges.length > 0 ? "selected" : "all",
    ranges:
      pageRanges.length > 0
        ? pageRanges.map(({ start, end }, index) => ({
            id: `${idPrefix}-page-range-${index + 1}`,
            start: String(start),
            end: String(end),
          }))
        : [{ id: `${idPrefix}-page-range-1`, start: "1", end: "1" }],
  };
}

function displayNumber(value: number) {
  return Number.isFinite(value) ? String(Math.round(value * 1_000_000) / 1_000_000) : "";
}

function rawAgentic(configurations: ReductoImportedConfigurations | undefined) {
  const nestedEnhance = (configuration: ReductoJsonObject | null | undefined) => {
    const parsing = configuration?.parsing;
    return isJsonObject(parsing) ? parsing.enhance : undefined;
  };
  const candidates = [
    configurations?.parse?.enhance,
    nestedEnhance(configurations?.extract),
    nestedEnhance(configurations?.split),
  ];
  return candidates.flatMap((enhance) => {
    if (!isJsonObject(enhance)) return [];
    const entries = Array.isArray(enhance.agentic)
      ? enhance.agentic.filter(isJsonObject)
      : [];
    const hasTopLevelAdvancedChart =
      enhance.advanced_chart_agent === true ||
      enhance.advanced_chart_extraction === true ||
      enhance.chart_agent === true;
    return hasTopLevelAdvancedChart
      ? [...entries, { scope: "figure", advanced_chart_agent: true }]
      : entries;
  });
}

function rawParseSettings(configurations: ReductoImportedConfigurations | undefined) {
  const nestedSettings = (configuration: ReductoJsonObject | null | undefined) => {
    const parsing = configuration?.parsing;
    return isJsonObject(parsing) && isJsonObject(parsing.settings)
      ? parsing.settings
      : undefined;
  };
  const candidates = [
    configurations?.parse?.settings,
    nestedSettings(configurations?.extract),
    nestedSettings(configurations?.split),
  ];
  return candidates.find(isJsonObject);
}

/** Hydrate every simulator-supported pricing input from a canonical pipeline. */
export function pipelineToManualDraft(
  pipeline: PublicPipeline,
  importedConfigurations?: ReductoImportedConfigurations,
): ManualPipelineDraft {
  const parseEnabled = pipeline.parse != null;
  const extractEnabled = pipeline.extract != null;
  const splitEnabled = pipeline.split != null;
  const includedDownstream = parseEnabled && (extractEnabled || splitEnabled);
  const conditionalExtract =
    extractEnabled && pipeline.lumos_assumptions?.conditional_extract_routing === true;
  const extractMode: ManualExtractMode = !extractEnabled
    ? "off"
    : conditionalExtract
      ? "conditional"
      : pipeline.extract?.settings?.deep_extract === true
        ? "deep"
        : "standard";
  const splitMode: ManualSplitMode = !splitEnabled
    ? "off"
    : pipeline.split?.settings?.deep_split === true
      ? "deep"
      : "standard";
  const parsePageRange = pipeline.parse?.settings?.page_range;
  const extractPageRange = pipeline.extract?.settings?.page_range;
  const splitPageRange = pipeline.split?.parsing?.settings?.page_range;
  const publicAgentic = pipeline.parse?.enhance?.agentic ?? [];
  const importedAgentic = rawAgentic(importedConfigurations);
  const agentic = importedAgentic.length > 0 ? importedAgentic : publicAgentic;
  const importedParseSettings = rawParseSettings(importedConfigurations);
  const importedPricingModel = importedParseSettings?.model;
  const pricingModel: ManualParsePricingModel =
    pipeline.parse?.settings?.model === "r-1" || importedPricingModel === "r-1"
      ? "r-1"
      : "legacy";
  const returnOcrData =
    pipeline.parse?.settings?.return_ocr_data ??
    (typeof importedParseSettings?.return_ocr_data === "boolean"
      ? importedParseSettings.return_ocr_data
      : undefined);
  const hasScope = (scope: "text" | "table" | "figure") =>
    agentic.some((mode) => mode.scope === scope);
  const advancedChart = agentic.some(
    (mode) =>
      mode.scope === "figure" &&
      (
        mode.advanced_chart_agent === true ||
        mode.advanced_chart_extraction === true ||
        mode.chart_agent === true
      ),
  );
  const chartCounts = pipeline.lumos_assumptions?.advanced_chart_counts;
  const unpricedCostFactors = sanitizedUnpricedFactors(
    pipeline.lumos_assumptions?.unpriced_cost_factors ?? [],
  );

  return {
    parse: {
      enabled: parseEnabled && !includedDownstream,
      includedDownstream,
      pricingModel,
      mode: agentic.length > 0 ? "agentic" : "standard",
      agenticScopes: {
        text: hasScope("text"),
        table: hasScope("table"),
        figure: hasScope("figure"),
      },
      advancedChart,
      batch: pipeline.parse?.queue_priority === "batch",
      pageSelection: pageSelectionFromPublic(
        parseEnabled && !extractEnabled && !splitEnabled ? parsePageRange : undefined,
        "parse",
      ),
      ...(returnOcrData !== undefined ? { returnOcrData } : {}),
      ...(agentic.length > 0
        ? {
            preservedAgentic: agentic.map(
              (entry) => cloneJsonValue(entry as ReductoJsonValue) as ReductoJsonObject,
            ),
          }
        : {}),
    },
    classify: {
      enabled: pipeline.classify != null,
      start: String(pipeline.classify?.page_range?.start ?? 1),
      end: String(pipeline.classify?.page_range?.end ?? 5),
    },
    extract: {
      mode: extractMode,
      includeImages: pipeline.extract?.settings?.include_images === true,
      optimizeForLatency: pipeline.extract?.settings?.optimize_for_latency === true,
      pageSelection: pageSelectionFromPublic(
        extractPageRange ?? (extractEnabled ? parsePageRange : undefined),
        "extract",
      ),
    },
    split: {
      mode: splitMode,
      pageSelection: pageSelectionFromPublic(
        splitPageRange ?? (splitEnabled ? parsePageRange : undefined),
        "split",
      ),
    },
    edit: {
      enabled: pipeline.edit != null,
      fullyPrefilledPages: String(
        pipeline.lumos_assumptions?.known_fully_prefilled_edit_pages ?? 0,
      ),
    },
    assumptions: {
      complexSharePercent: displayNumber(
        (pipeline.lumos_assumptions?.likely_complex_parse_share ?? 0.5) * 100,
      ),
      chartCountsEnabled: chartCounts != null,
      likelyChartCount: String(chartCounts?.likely ?? 0),
      maximumChartCount: String(chartCounts?.maximum ?? 0),
      extractFieldsPerPage:
        unpricedCostFactors.includes("extract.field_density") ||
        pipeline.lumos_assumptions?.estimated_extract_fields_per_page === undefined
          ? ""
          : String(pipeline.lumos_assumptions.estimated_extract_fields_per_page),
      deepSharePercent: displayNumber(
        (pipeline.lumos_assumptions?.likely_deep_extract_share ?? 0.25) * 100,
      ),
      unpricedCostFactors,
    },
    importedConfigurations: cloneConfigurations(importedConfigurations),
  };
}

export function manualErrorEndpoint(field: string): ManualEndpoint | null {
  if (field.startsWith("parse.")) return "parse";
  if (field.startsWith("classify.")) return "classify";
  if (field.startsWith("extract.")) return "extract";
  if (field.startsWith("split.")) return "split";
  if (field.startsWith("edit.")) return "edit";
  if (field.startsWith("assumptions.complex") || field.startsWith("assumptions.chart")) {
    return "parse";
  }
  if (
    field.startsWith("assumptions.likelyChart") ||
    field.startsWith("assumptions.maximumChart")
  ) return "parse";
  if (field.startsWith("assumptions.extract") || field.startsWith("assumptions.deep")) {
    return "extract";
  }
  return null;
}
