export type RouteMode = "unknown" | "standard" | "deep";
export type ParseMode = "none" | "standalone" | "bundled";
export type ParsePricingModel = "legacy" | "r-1";
export type ExtractMode = "none" | "standard" | "conditional" | "deep";
export type SplitMode = "none" | "standard" | "deep";
export type Decision = "allow" | "review" | "deny";

export type PublicPageRange =
  | { start: number; end: number }
  | number[]
  | Array<{ start: number; end: number }>;

type PageInterval = { start: number; end: number };

export type PricingDocument = {
  name: string;
  pages: number;
  route: RouteMode;
  isPdf: boolean;
};

export type PipelinePricingConfig = {
  parseMode: ParseMode;
  parseModel: ParsePricingModel;
  parsePageRanges: PageInterval[] | null;
  parseCostMultiplier: number;
  parseBatchDiscount: number;
  parseComplexShare: number;
  parseAdvancedChart: boolean;
  parseAdvancedChartCounts: { likely: number; maximum: number } | null;
  classify: boolean;
  classifyStart: number;
  classifyEnd: number;
  extractMode: ExtractMode;
  extractPageRanges: PageInterval[] | null;
  extractCostMultiplier: number;
  deepShare: number;
  fieldsPerPage: number;
  splitMode: SplitMode;
  splitPageRanges: PageInterval[] | null;
  edit: boolean;
  fullyPrefilledEditPages: number;
  unpricedCostFactors: string[];
};

export type EstimateInput = {
  documents: PricingDocument[];
  pipeline: PipelinePricingConfig;
  budgetUsd: number;
};

export type PublicPipeline = {
  parse?: {
    enhance?: {
      agentic?: Array<{
        scope: "text" | "table" | "figure";
        mode?: string;
        prompt?: string;
        advanced_chart_agent?: boolean;
      }> | null;
    } | null;
    settings?: {
      page_range?: PublicPageRange | null;
      model?: ParsePricingModel;
      return_ocr_data?: boolean;
    } | null;
    queue_priority?: "auto" | "batch";
  } | null;
  classify?: {
    page_range?: { start?: number; end?: number } | null;
  } | null;
  extract?: {
    settings?: {
      deep_extract?: boolean;
      optimize_for_latency?: boolean;
      include_images?: boolean;
      page_range?: PublicPageRange | null;
    } | null;
  } | null;
  split?: {
    settings?: { deep_split?: boolean } | null;
    parsing?: {
      settings?: { page_range?: PublicPageRange | null } | null;
    } | null;
  } | null;
  edit?: object | null;
  lumos_assumptions?: {
    likely_complex_parse_share?: number;
    advanced_chart_counts?: {
      likely: number;
      maximum: number;
    } | null;
    conditional_extract_routing?: boolean;
    likely_deep_extract_share?: number;
    estimated_extract_fields_per_page?: number;
    known_fully_prefilled_edit_pages?: number;
    unpriced_cost_factors?: string[];
  } | null;
};

export type PublicEstimateRequest = {
  documents: Array<{ name: string; pages: number; assumed_extract_route?: RouteMode }>;
  pipeline: PublicPipeline;
  policy?: { max_total_usd?: number };
};

export const RATE_CARD = "reducto-public-2026-09-01";
export const R1_RATE_CARD = "reducto-public-2026-09-01-r1-beta";

export type PricingUnitRates = {
  parseStandard: number;
  parseComplex: number;
  parseR1: number;
  advancedChart: number;
  classify: number;
  extract: number;
  deepExtract: number;
  split: number;
  deepSplit: number;
  edit: number;
  editPrefilled: number;
};

export const DEFAULT_PRICING_UNIT_RATES: PricingUnitRates = Object.freeze({
  parseStandard: 0.015,
  parseComplex: 0.03,
  parseR1: 0.01,
  advancedChart: 0.06,
  classify: 0.0075,
  extract: 0.02,
  deepExtract: 0.04,
  split: 0.02,
  deepSplit: 0.04,
  edit: 0.06,
  editPrefilled: 0.015,
});

export const FIXED_PRICING_RULES = Object.freeze({
  agenticParseMultiplier: 2,
  extractLatencyMultiplier: 2,
  batchParseDiscount: 0.2,
} as const);

function normalizeOperationPageRanges(
  pageRange: PublicPageRange | null | undefined,
  label: string,
): PageInterval[] | null {
  if (pageRange == null) return null;

  const unmerged: PageInterval[] = [];
  const addRange = (range: unknown) => {
    if (!isRecord(range)) {
      throw new Error(`${label} must use objects with start and end pages.`);
    }
    rejectUnknownKeys(range, ["start", "end"], label);
    unmerged.push({
      start: range.start as number,
      end: range.end as number,
    });
  };
  if (Array.isArray(pageRange)) {
    if (pageRange.length === 0) {
      throw new Error(`${label} needs at least one page.`);
    }
    const hasNumbers = pageRange.some((entry) => typeof entry === "number");
    const hasRanges = pageRange.some((entry) => typeof entry === "object");
    if (hasNumbers && hasRanges) {
      throw new Error(`${label} cannot mix page numbers and ranges.`);
    }
    if (hasNumbers) {
      for (const page of pageRange as number[]) {
        unmerged.push({ start: page, end: page });
      }
    } else {
      for (const range of pageRange) {
        addRange(range);
      }
    }
  } else {
    addRange(pageRange);
  }

  if (
    unmerged.some(
      ({ start, end }) =>
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 1 ||
        end < start,
    )
  ) {
    throw new Error(
      `${label} needs whole, 1-indexed pages with each end at or after its start.`,
    );
  }

  const sorted = unmerged.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: PageInterval[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function samePageIntervals(
  left: PageInterval[] | null,
  right: PageInterval[] | null,
) {
  if (left === null || right === null) return left === right;
  return (
    left.length === right.length &&
    left.every(
      (range, index) =>
        range.start === right[index].start && range.end === right[index].end,
    )
  );
}

function isSpreadsheet(name: string) {
  return /\.(?:xls|xlsx|xlsm|xltx|xltm|csv|qpw)(?:[?#].*)?$/i.test(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
) {
  const allowedKeys = new Set(allowed);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`${label} contains unsupported field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}.`);
  }
}

function optionalRecord(
  owner: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, unknown> | null {
  const value = owner[key];
  if (value == null) return null;
  if (!isRecord(value)) throw new Error(`${label} must be an object or null.`);
  return value;
}

function optionalBoolean(
  owner: Record<string, unknown>,
  key: string,
  label: string,
): boolean | undefined {
  const value = owner[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be true or false.`);
  return value;
}

function finiteNumber(
  value: unknown,
  fallback: number,
  label: string,
  {
    minimum,
    maximum,
    safeInteger = false,
  }: { minimum?: number; maximum?: number; safeInteger?: boolean } = {},
) {
  const resolved = value === undefined ? fallback : value;
  if (
    typeof resolved !== "number" ||
    !Number.isFinite(resolved) ||
    (safeInteger && !Number.isSafeInteger(resolved)) ||
    (minimum !== undefined && resolved < minimum) ||
    (maximum !== undefined && resolved > maximum)
  ) {
    const range =
      minimum !== undefined && maximum !== undefined
        ? ` from ${minimum} to ${maximum}`
        : minimum !== undefined
          ? ` of at least ${minimum}`
          : maximum !== undefined
            ? ` no greater than ${maximum}`
            : "";
    throw new Error(
      `${label} must be a finite number${safeInteger ? " and a whole number" : ""}${range}.`,
    );
  }
  return resolved;
}

export function normalizeRequest(input: PublicEstimateRequest): EstimateInput {
  const rawInput: unknown = input;
  if (!isRecord(rawInput)) throw new Error("The estimate request must be an object.");
  rejectUnknownKeys(rawInput, ["documents", "pipeline", "policy"], "request");

  const rawDocuments = rawInput.documents;
  if (!Array.isArray(rawDocuments) || rawDocuments.length === 0) {
    throw new Error("At least one document is required.");
  }

  const rawPipeline = rawInput.pipeline;
  if (!isRecord(rawPipeline)) throw new Error("pipeline must be an object.");
  rejectUnknownKeys(
    rawPipeline,
    ["parse", "classify", "extract", "split", "edit", "lumos_assumptions"],
    "pipeline",
  );
  const parse = optionalRecord(rawPipeline, "parse", "pipeline.parse");
  const classify = optionalRecord(rawPipeline, "classify", "pipeline.classify");
  const extract = optionalRecord(rawPipeline, "extract", "pipeline.extract");
  const split = optionalRecord(rawPipeline, "split", "pipeline.split");
  const edit = optionalRecord(rawPipeline, "edit", "pipeline.edit");
  const assumptions =
    optionalRecord(rawPipeline, "lumos_assumptions", "pipeline.lumos_assumptions") ?? {};
  const rawPolicy = rawInput.policy;
  if (rawPolicy !== undefined && !isRecord(rawPolicy)) {
    throw new Error("policy must be an object when supplied.");
  }
  const policy = rawPolicy ?? {};

  if (parse) {
    rejectUnknownKeys(
      parse,
      ["enhance", "settings", "queue_priority"],
      "pipeline.parse",
    );
  }
  if (classify) rejectUnknownKeys(classify, ["page_range"], "pipeline.classify");
  if (extract) rejectUnknownKeys(extract, ["settings"], "pipeline.extract");
  if (split) rejectUnknownKeys(split, ["settings", "parsing"], "pipeline.split");
  if (edit) rejectUnknownKeys(edit, [], "pipeline.edit");
  rejectUnknownKeys(
    assumptions,
    [
      "likely_complex_parse_share",
      "advanced_chart_counts",
      "conditional_extract_routing",
      "likely_deep_extract_share",
      "estimated_extract_fields_per_page",
      "known_fully_prefilled_edit_pages",
      "unpriced_cost_factors",
    ],
    "pipeline.lumos_assumptions",
  );
  rejectUnknownKeys(policy, ["max_total_usd"], "policy");

  const parseEnhance = parse
    ? (optionalRecord(parse, "enhance", "pipeline.parse.enhance") ?? {})
    : {};
  const parseSettings = parse
    ? (optionalRecord(parse, "settings", "pipeline.parse.settings") ?? {})
    : {};
  const extractSettings = extract
    ? (optionalRecord(extract, "settings", "pipeline.extract.settings") ?? {})
    : {};
  const splitSettings = split
    ? (optionalRecord(split, "settings", "pipeline.split.settings") ?? {})
    : {};
  const splitParsing = split
    ? optionalRecord(split, "parsing", "pipeline.split.parsing")
    : null;
  const splitParsingSettings = splitParsing
    ? (optionalRecord(
        splitParsing,
        "settings",
        "pipeline.split.parsing.settings",
      ) ?? {})
    : {};
  rejectUnknownKeys(parseEnhance, ["agentic"], "pipeline.parse.enhance");
  rejectUnknownKeys(
    parseSettings,
    ["page_range", "model", "return_ocr_data"],
    "pipeline.parse.settings",
  );
  rejectUnknownKeys(
    extractSettings,
    ["deep_extract", "optimize_for_latency", "include_images", "page_range"],
    "pipeline.extract.settings",
  );
  rejectUnknownKeys(splitSettings, ["deep_split"], "pipeline.split.settings");
  if (splitParsing) {
    rejectUnknownKeys(splitParsing, ["settings"], "pipeline.split.parsing");
  }
  rejectUnknownKeys(
    splitParsingSettings,
    ["page_range"],
    "pipeline.split.parsing.settings",
  );

  const rawParseAgentic = parseEnhance.agentic;
  if (
    rawParseAgentic !== undefined &&
    rawParseAgentic !== null &&
    !Array.isArray(rawParseAgentic)
  ) {
    throw new Error("Parse enhance.agentic must be an array or null.");
  }
  const parseAgentic = Array.isArray(rawParseAgentic) ? rawParseAgentic : [];
  let parseAdvancedChart = false;
  let parseHasCustomPrompt = false;
  let parseHasPromptlessAgenticScope = false;
  for (const [index, rawMode] of parseAgentic.entries()) {
    if (!isRecord(rawMode)) {
      throw new Error(`Parse enhance.agentic[${index}] must be an object.`);
    }
    rejectUnknownKeys(
      rawMode,
      ["scope", "mode", "prompt", "advanced_chart_agent"],
      `Parse enhance.agentic[${index}]`,
    );
    for (const key of ["scope", "mode", "prompt"] as const) {
      const value = rawMode[key];
      if (value !== undefined && (typeof value !== "string" || !value.trim())) {
        throw new Error(`Parse enhance.agentic[${index}].${key} must be a nonempty string.`);
      }
    }
    if (
      rawMode.scope !== "text" &&
      rawMode.scope !== "table" &&
      rawMode.scope !== "figure"
    ) {
      throw new Error(
        `Parse enhance.agentic[${index}].scope must be text, table, or figure.`,
      );
    }
    const advancedChart = optionalBoolean(
      rawMode,
      "advanced_chart_agent",
      `Parse enhance.agentic[${index}].advanced_chart_agent`,
    );
    if (advancedChart === true && rawMode.scope !== "figure") {
      throw new Error(
        `Parse enhance.agentic[${index}].advanced_chart_agent requires scope "figure".`,
      );
    }
    parseHasCustomPrompt ||= typeof rawMode.prompt === "string";
    parseHasPromptlessAgenticScope ||=
      rawMode.prompt === undefined && advancedChart !== true;
    parseAdvancedChart ||= advancedChart === true;
  }

  const parseQueuePriority = parse?.queue_priority;
  if (
    parseQueuePriority !== undefined &&
    parseQueuePriority !== "auto" &&
    parseQueuePriority !== "batch"
  ) {
    throw new Error('Parse queue_priority must be "auto" or "batch" when supplied.');
  }

  const rawParseModel = parseSettings.model;
  if (
    rawParseModel !== undefined &&
    rawParseModel !== "legacy" &&
    rawParseModel !== "r-1"
  ) {
    throw new Error('Parse settings.model must be "legacy" or "r-1" when supplied.');
  }
  const parseModel: ParsePricingModel = rawParseModel === "r-1" ? "r-1" : "legacy";
  const parseReturnOcrData = optionalBoolean(
    parseSettings,
    "return_ocr_data",
    "Parse settings.return_ocr_data",
  );

  const deepExtract = optionalBoolean(
    extractSettings,
    "deep_extract",
    "Extract settings.deep_extract",
  );
  const optimizeForLatency = optionalBoolean(
    extractSettings,
    "optimize_for_latency",
    "Extract settings.optimize_for_latency",
  );
  const includeImages = optionalBoolean(
    extractSettings,
    "include_images",
    "Extract settings.include_images",
  );
  const deepSplit = optionalBoolean(
    splitSettings,
    "deep_split",
    "Split settings.deep_split",
  );
  const conditionalExtractSetting = optionalBoolean(
    assumptions,
    "conditional_extract_routing",
    "lumos_assumptions.conditional_extract_routing",
  );
  if (deepExtract === true && conditionalExtractSetting === true) {
    throw new Error(
      "Extract settings.deep_extract cannot be true when conditional_extract_routing is enabled.",
    );
  }

  const parseMode: ParseMode =
    parse == null
      ? "none"
      : extract != null || split != null
        ? "bundled"
        : "standalone";
  if (parseModel === "r-1" && parseMode !== "standalone") {
    throw new Error('Parse settings.model "r-1" is available only for standalone Parse estimates.');
  }
  if (parseModel === "r-1" && parseHasPromptlessAgenticScope) {
    throw new Error(
      "r-1 Agentic scopes without prompts cannot be estimated. Add a prompt, remove the scope, or select Legacy Parse.",
    );
  }
  if (parseQueuePriority === "batch" && parseMode !== "standalone") {
    throw new Error("Parse queue_priority is available only for standalone Parse estimates.");
  }

  const hasParseComplexShare = Object.hasOwn(
    assumptions,
    "likely_complex_parse_share",
  );
  if (hasParseComplexShare && parseMode !== "standalone") {
    throw new Error(
      "likely_complex_parse_share is available only for standalone Parse estimates.",
    );
  }
  const normalizedParseComplexShare =
    parseMode === "standalone"
      ? finiteNumber(
          assumptions.likely_complex_parse_share,
          0.5,
          "lumos_assumptions.likely_complex_parse_share",
          { minimum: 0, maximum: 1 },
        )
      : 0.5;
  const parseComplexShare = parseModel === "r-1" ? 0 : normalizedParseComplexShare;

  const hasAdvancedChartCountsField = Object.hasOwn(
    assumptions,
    "advanced_chart_counts",
  );
  const rawAdvancedChartCounts = hasAdvancedChartCountsField
    ? optionalRecord(
        assumptions,
        "advanced_chart_counts",
        "lumos_assumptions.advanced_chart_counts",
      )
    : null;
  const hasAdvancedChartCounts = rawAdvancedChartCounts !== null;
  if (rawAdvancedChartCounts) {
    rejectUnknownKeys(
      rawAdvancedChartCounts,
      ["likely", "maximum"],
      "lumos_assumptions.advanced_chart_counts",
    );
    if (
      !Object.hasOwn(rawAdvancedChartCounts, "likely") ||
      !Object.hasOwn(rawAdvancedChartCounts, "maximum")
    ) {
      throw new Error("advanced_chart_counts needs both likely and maximum counts.");
    }
  }
  if (
    hasAdvancedChartCounts &&
    (parseMode !== "standalone" || !parseAdvancedChart)
  ) {
    throw new Error(
      "advanced_chart_counts requires advanced chart processing in a standalone Parse estimate.",
    );
  }
  const parseAdvancedChartCounts = rawAdvancedChartCounts
    ? {
        likely: finiteNumber(
          rawAdvancedChartCounts.likely,
          0,
          "lumos_assumptions.advanced_chart_counts.likely",
          { minimum: 0, safeInteger: true },
        ),
        maximum: finiteNumber(
          rawAdvancedChartCounts.maximum,
          0,
          "lumos_assumptions.advanced_chart_counts.maximum",
          { minimum: 0, safeInteger: true },
        ),
      }
    : null;
  if (
    parseAdvancedChartCounts &&
    parseAdvancedChartCounts.maximum < parseAdvancedChartCounts.likely
  ) {
    throw new Error("advanced_chart_counts.maximum must be at least the likely count.");
  }

  const classifyRangeValue = classify?.page_range;
  if (classifyRangeValue != null && !isRecord(classifyRangeValue)) {
    throw new Error("Classify page_range must be an object or null.");
  }
  const classifyRange = classifyRangeValue == null ? null : classifyRangeValue;
  if (classifyRange) {
    rejectUnknownKeys(classifyRange, ["start", "end"], "Classify page_range");
  }
  if (
    classifyRange != null &&
    (!Object.hasOwn(classifyRange, "start") || !Object.hasOwn(classifyRange, "end"))
  ) {
    throw new Error("Classify page_range needs both start and end.");
  }
  const classifyStart = finiteNumber(
    classifyRange?.start,
    1,
    "Classify page_range.start",
  );
  const classifyEnd = finiteNumber(
    classifyRange?.end,
    5,
    "Classify page_range.end",
  );
  const classifyPageCount = classifyEnd - classifyStart + 1;
  if (
    classify != null &&
    (!Number.isSafeInteger(classifyStart) ||
      !Number.isSafeInteger(classifyEnd) ||
      classifyStart < 1 ||
      classifyEnd < classifyStart ||
      classifyPageCount > 10)
  ) {
    throw new Error(
      "Lumos supports Classify page_range selections of 1 to 10 whole PDF pages.",
    );
  }

  const likelyDeepShare = finiteNumber(
    assumptions.likely_deep_extract_share,
    0.25,
    "lumos_assumptions.likely_deep_extract_share",
    { minimum: 0, maximum: 1 },
  );
  const fieldsPerPage = finiteNumber(
    assumptions.estimated_extract_fields_per_page,
    0,
    "lumos_assumptions.estimated_extract_fields_per_page",
    { minimum: 0, safeInteger: true },
  );
  const hasEstimatedFields = Object.hasOwn(
    assumptions,
    "estimated_extract_fields_per_page",
  );
  const fullyPrefilledEditPages = finiteNumber(
    assumptions.known_fully_prefilled_edit_pages,
    0,
    "lumos_assumptions.known_fully_prefilled_edit_pages",
    { minimum: 0, safeInteger: true },
  );
  const budgetUsd = finiteNumber(policy.max_total_usd, 10, "policy.max_total_usd", {
    minimum: 0,
  });

  const documents = rawDocuments.map((rawDocument) => {
    if (!isRecord(rawDocument)) throw new Error("Every document must be an object.");
    rejectUnknownKeys(
      rawDocument,
      ["name", "pages", "assumed_extract_route"],
      "Document",
    );
    const pages = rawDocument.pages;
    if (typeof pages !== "number" || !Number.isSafeInteger(pages) || pages < 1) {
      throw new Error("Every document needs a whole-number page count of at least 1.");
    }
    const rawName = rawDocument.name;
    if (typeof rawName !== "string" || !rawName.trim()) {
      throw new Error("Every document needs a nonempty original filename.");
    }
    const name = rawName.trim();
    const rawRoute =
      rawDocument.assumed_extract_route === undefined
        ? "unknown"
        : rawDocument.assumed_extract_route;
    if (rawRoute !== "unknown" && rawRoute !== "standard" && rawRoute !== "deep") {
      throw new Error(`Unknown document route: ${String(rawRoute)}`);
    }
    const route: RouteMode = rawRoute;
    return { name, pages, route, isPdf: /\.pdf(?:[?#].*)?$/i.test(name) };
  });

  if (documents.some((document) => isSpreadsheet(document.name))) {
    throw new Error(
      "Spreadsheet pricing needs billable cell counts and your Reducto rate card; Lumos will not guess a page-based price.",
    );
  }
  const totalDocumentPages = documents.reduce((sum, document) => sum + document.pages, 0);
  if (!Number.isSafeInteger(totalDocumentPages)) {
    throw new Error("The combined document page count is too large to estimate safely.");
  }
  if (fullyPrefilledEditPages > 0 && edit == null) {
    throw new Error(
      "known_fully_prefilled_edit_pages is available only when Edit is enabled.",
    );
  }
  if (fullyPrefilledEditPages > totalDocumentPages) {
    throw new Error(
      "known_fully_prefilled_edit_pages cannot exceed the total document page count.",
    );
  }

  const hasExtract = extract != null;
  const conditionalExtract = hasExtract && conditionalExtractSetting === true;
  const extractMode: ExtractMode = !hasExtract
    ? "none"
    : conditionalExtract
      ? "conditional"
      : deepExtract === true
        ? "deep"
        : "standard";

  const rawUnpricedCostFactors =
    assumptions.unpriced_cost_factors === undefined
      ? []
      : assumptions.unpriced_cost_factors;
  if (
    !Array.isArray(rawUnpricedCostFactors) ||
    rawUnpricedCostFactors.some(
      (factor) => typeof factor !== "string" || !factor.trim() || factor.length > 100,
    ) ||
    rawUnpricedCostFactors.length > 20
  ) {
    throw new Error("lumos_assumptions.unpriced_cost_factors must be a short list of names.");
  }
  const unpricedCostFactors = rawUnpricedCostFactors.filter(
    (factor) => parseModel !== "r-1" || factor !== "parse.advanced_chart_count",
  );
  if (includeImages === true) unpricedCostFactors.push("extract.include_images");
  if (hasExtract && (!hasEstimatedFields || fieldsPerPage > 100)) {
    unpricedCostFactors.push("extract.field_density");
  }
  if (parseMode === "standalone" && parseModel === "r-1") {
    if (parseHasCustomPrompt) {
      unpricedCostFactors.push("parse.r1_agentic_prompt");
    }
    if (parseReturnOcrData === true) {
      unpricedCostFactors.push("parse.r1_return_ocr_data");
    }
    if (parseAdvancedChart) {
      unpricedCostFactors.push("parse.r1_advanced_chart");
    }
  }
  if (
    parseMode === "standalone" &&
    parseModel === "legacy" &&
    parseAdvancedChart &&
    parseAdvancedChartCounts == null
  ) {
    unpricedCostFactors.push("parse.advanced_chart_count");
  }

  const parsePageRanges = normalizeOperationPageRanges(
    parseSettings.page_range as PublicPageRange | null | undefined,
    "Parse settings.page_range",
  );
  let extractPageRanges = normalizeOperationPageRanges(
    extractSettings.page_range as PublicPageRange | null | undefined,
    "Extract settings.page_range",
  );
  let splitPageRanges = normalizeOperationPageRanges(
    splitParsingSettings.page_range as PublicPageRange | null | undefined,
    "Split parsing.settings.page_range",
  );
  if (parseMode === "bundled" && parsePageRanges !== null) {
    if (hasExtract) {
      if (extractPageRanges !== null && !samePageIntervals(parsePageRanges, extractPageRanges)) {
        throw new Error(
          "Parse and Extract specify different page ranges, so Lumos cannot safely choose which pages to price.",
        );
      }
      extractPageRanges = parsePageRanges;
    }
    if (split != null) {
      if (splitPageRanges !== null && !samePageIntervals(parsePageRanges, splitPageRanges)) {
        throw new Error(
          "Parse and Split specify different page ranges, so Lumos cannot safely choose which pages to price.",
        );
      }
      splitPageRanges = parsePageRanges;
    }
  }

  return {
    documents,
    pipeline: {
      parseMode,
      parseModel,
      parsePageRanges,
      parseCostMultiplier:
        parseModel === "legacy" && parseAgentic.length > 0
          ? FIXED_PRICING_RULES.agenticParseMultiplier
          : 1,
      parseBatchDiscount:
        parseMode === "standalone" && parseQueuePriority === "batch"
          ? FIXED_PRICING_RULES.batchParseDiscount
          : 0,
      parseComplexShare,
      parseAdvancedChart,
      parseAdvancedChartCounts,
      classify: classify != null,
      classifyStart,
      classifyEnd,
      extractMode,
      extractPageRanges,
      extractCostMultiplier:
        optimizeForLatency === true
          ? FIXED_PRICING_RULES.extractLatencyMultiplier
          : 1,
      deepShare: likelyDeepShare,
      fieldsPerPage,
      splitMode: split == null ? "none" : deepSplit === true ? "deep" : "standard",
      splitPageRanges,
      edit: edit != null,
      fullyPrefilledEditPages,
      unpricedCostFactors: [...new Set(unpricedCostFactors.map((factor) => factor.trim()))],
    },
    budgetUsd,
  };
}

export function estimatePipeline(
  { documents, pipeline, budgetUsd }: EstimateInput,
  rates: PricingUnitRates = DEFAULT_PRICING_UNIT_RATES,
) {
  const totalPages = documents.reduce((sum, item) => sum + Math.max(1, item.pages), 0);

  let parsePages = 0;
  if (pipeline.parseMode === "standalone") {
    parsePages = documents.reduce((sum, document) => {
      if (pipeline.parsePageRanges == null) return sum + document.pages;
      const selectedPages = pipeline.parsePageRanges.reduce((rangeSum, range) => {
        if (range.start > document.pages) return rangeSum;
        return rangeSum + Math.min(range.end, document.pages) - range.start + 1;
      }, 0);
      if (selectedPages === 0) {
        throw new Error(
          `Parse settings.page_range selects no pages in ${document.name ?? "a document"}.`,
        );
      }
      return sum + selectedPages;
    }, 0);
  }

  const parseDiscountMultiplier = 1 - pipeline.parseBatchDiscount;
  const parsePageLow =
    pipeline.parseModel === "r-1"
      ? parsePages * rates.parseR1
      : parsePages * rates.parseStandard * pipeline.parseCostMultiplier;
  const parsePageLikely =
    pipeline.parseModel === "r-1"
      ? parsePages * rates.parseR1
      : parsePages *
        ((1 - pipeline.parseComplexShare) * rates.parseStandard +
          pipeline.parseComplexShare * rates.parseComplex) *
        pipeline.parseCostMultiplier;
  const parsePageHigh =
    pipeline.parseModel === "r-1"
      ? parsePages * rates.parseR1
      : parsePages * rates.parseComplex * pipeline.parseCostMultiplier;
  const parseChartLikely =
    pipeline.parseModel === "legacy"
      ? (pipeline.parseAdvancedChartCounts?.likely ?? 0)
      : 0;
  const parseChartMaximum =
    pipeline.parseModel === "legacy"
      ? (pipeline.parseAdvancedChartCounts?.maximum ?? 0)
      : 0;
  const parseLow = parsePageLow * parseDiscountMultiplier;
  const parseLikely =
    (parsePageLikely + parseChartLikely * rates.advancedChart) *
    parseDiscountMultiplier;
  const parseHigh =
    (parsePageHigh + parseChartMaximum * rates.advancedChart) *
    parseDiscountMultiplier;

  const classifyPages = pipeline.classify
    ? documents.reduce(
        (sum, item) => {
          // Reducto applies page_range only to PDFs. Other formats use the
          // documented default context of the first five available pages.
          if (!item.isPdf) return sum + Math.min(item.pages, 5);
          if (pipeline.classifyStart > item.pages) {
            throw new Error(
              `Classify page_range starts after the last page in ${item.name ?? "a PDF"}.`,
            );
          }
          return (
            sum +
            (Math.min(pipeline.classifyEnd, item.pages) - pipeline.classifyStart + 1)
          );
        },
        0,
      )
    : 0;
  const classifyCost = classifyPages * rates.classify;

  const extractPageCounts = new Map<PricingDocument, number>();
  for (const document of documents) {
    if (pipeline.extractMode === "none") {
      extractPageCounts.set(document, 0);
      continue;
    }
    if (pipeline.extractPageRanges == null) {
      extractPageCounts.set(document, document.pages);
      continue;
    }
    const selectedPages = pipeline.extractPageRanges.reduce((sum, range) => {
      if (range.start > document.pages) return sum;
      return sum + Math.min(range.end, document.pages) - range.start + 1;
    }, 0);
    if (selectedPages === 0) {
      throw new Error(
        `Extract settings.page_range selects no pages in ${document.name ?? "a document"}.`,
      );
    }
    extractPageCounts.set(document, selectedPages);
  }
  const extractPages = documents.reduce(
    (sum, document) => sum + (extractPageCounts.get(document) ?? 0),
    0,
  );

  const standardPages = documents
    .filter((item) => item.route === "standard")
    .reduce((sum, item) => sum + (extractPageCounts.get(item) ?? 0), 0);
  const deepPages = documents
    .filter((item) => item.route === "deep")
    .reduce((sum, item) => sum + (extractPageCounts.get(item) ?? 0), 0);
  const unknownRoutePages = documents
    .filter((item) => item.route === "unknown")
    .reduce((sum, item) => sum + (extractPageCounts.get(item) ?? 0), 0);

  let extractLow = 0;
  let extractLikely = 0;
  let extractHigh = 0;
  if (pipeline.extractMode === "standard") {
    extractLow = extractLikely = extractHigh =
      extractPages * rates.extract * pipeline.extractCostMultiplier;
  } else if (pipeline.extractMode === "deep") {
    extractLow = extractLikely = extractHigh =
      extractPages * rates.deepExtract * pipeline.extractCostMultiplier;
  } else if (pipeline.extractMode === "conditional") {
    const fixedExtract =
      (standardPages * rates.extract + deepPages * rates.deepExtract) *
      pipeline.extractCostMultiplier;
    const deepFraction = Math.min(1, Math.max(0, pipeline.deepShare));
    extractLow =
      fixedExtract + unknownRoutePages * rates.extract * pipeline.extractCostMultiplier;
    extractHigh =
      fixedExtract + unknownRoutePages * rates.deepExtract * pipeline.extractCostMultiplier;
    extractLikely =
      fixedExtract +
      unknownRoutePages *
        ((1 - deepFraction) * rates.extract + deepFraction * rates.deepExtract) *
        pipeline.extractCostMultiplier;
  }

  const splitPageCounts = new Map<PricingDocument, number>();
  for (const document of documents) {
    if (pipeline.splitMode === "none") {
      splitPageCounts.set(document, 0);
      continue;
    }
    if (pipeline.splitPageRanges == null) {
      splitPageCounts.set(document, document.pages);
      continue;
    }
    const selectedPages = pipeline.splitPageRanges.reduce((sum, range) => {
      if (range.start > document.pages) return sum;
      return sum + Math.min(range.end, document.pages) - range.start + 1;
    }, 0);
    if (selectedPages === 0) {
      throw new Error(
        `Split parsing.settings.page_range selects no pages in ${document.name ?? "a document"}.`,
      );
    }
    splitPageCounts.set(document, selectedPages);
  }
  const splitPages = documents.reduce(
    (sum, document) => sum + (splitPageCounts.get(document) ?? 0),
    0,
  );
  const splitCost =
    pipeline.splitMode === "standard"
      ? splitPages * rates.split
      : pipeline.splitMode === "deep"
        ? splitPages * rates.deepSplit
        : 0;

  const fullyPrefilledEditPages = Math.min(totalPages, pipeline.fullyPrefilledEditPages);
  const editCost = pipeline.edit
    ? fullyPrefilledEditPages * rates.editPrefilled +
      (totalPages - fullyPrefilledEditPages) * rates.edit
    : 0;

  const fixed = classifyCost + splitCost + editCost;
  const low = fixed + parseLow + extractLow;
  const likely = fixed + parseLikely + extractLikely;
  const high = fixed + parseHigh + extractHigh;
  const decision: Decision =
    low > budgetUsd
      ? "deny"
      : pipeline.unpricedCostFactors.length > 0
        ? "review"
        : high <= budgetUsd
          ? "allow"
          : "review";

  return {
    decision,
    totalPages,
    parseMode: pipeline.parseMode,
    parseModel: pipeline.parseModel,
    parsePages,
    parseCostMultiplier: pipeline.parseCostMultiplier,
    parseBatchDiscount: pipeline.parseBatchDiscount,
    parseLikelyComplexShare: pipeline.parseComplexShare,
    parseAdvancedChart: pipeline.parseAdvancedChart,
    parseAdvancedChartCounts:
      pipeline.parseModel === "legacy" && pipeline.parseAdvancedChartCounts
      ? {
          low: 0,
          likely: pipeline.parseAdvancedChartCounts.likely,
          high: pipeline.parseAdvancedChartCounts.maximum,
        }
      : null,
    parseLow,
    parseLikely,
    parseHigh,
    classifyPages,
    extractPages,
    extractCostMultiplier: pipeline.extractCostMultiplier,
    estimateComplete: pipeline.unpricedCostFactors.length === 0,
    unpricedCostFactors: pipeline.unpricedCostFactors,
    classifyCost,
    extractLow,
    extractLikely,
    extractHigh,
    splitPages,
    splitCost,
    editCost,
    low,
    likely,
    high,
  };
}
