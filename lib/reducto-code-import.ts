import type { PublicPipeline } from "@/lib/pricing";

export type ReductoImportedOperation =
  | "parse"
  | "extract"
  | "split"
  | "classify"
  | "edit"
  | "pipeline";

export type ReductoImportPageRange = {
  start: number;
  end: number;
};

export type ReductoJsonPrimitive = string | number | boolean | null;
export type ReductoJsonValue =
  | ReductoJsonPrimitive
  | ReductoJsonValue[]
  | ReductoJsonObject;
export type ReductoJsonObject = { [key: string]: ReductoJsonValue };

export type ReductoImportedConfigurations = {
  parse: ReductoJsonObject | null;
  classify: ReductoJsonObject | null;
  extract: ReductoJsonObject | null;
  split: ReductoJsonObject | null;
  edit: ReductoJsonObject | null;
};

export type ReductoCodeImportResult = {
  applicable: boolean;
  pipeline: PublicPipeline | null;
  configurations: ReductoImportedConfigurations;
  detected: {
    source: "json" | "unknown";
    operations: ReductoImportedOperation[];
    extractMode: "none" | "standard" | "deep";
    extractPageRanges: ReductoImportPageRange[] | null;
    schemaFieldCount: number | null;
    spreadsheet: boolean;
    advancedChart: boolean;
  };
  warnings: string[];
  error: string | null;
};

type JsonValue = ReductoJsonValue;
type JsonObject = ReductoJsonObject;
type SupportedOperation = "parse" | "classify" | "extract" | "split" | "edit";
type CanonicalAgenticMode = {
  scope: "text" | "table" | "figure";
  mode?: string;
  advanced_chart_agent?: boolean;
};

const MAX_SOURCE_LENGTH = 200_000;
const MAX_JSON_DEPTH = 40;
const MAX_JSON_ITEMS = 5_000;

const OPERATION_ORDER: SupportedOperation[] = [
  "parse",
  "classify",
  "extract",
  "split",
  "edit",
];
const PARSE_TOP_LEVEL_KEYS = ["enhance", "formatting", "retrieval", "spreadsheet"];
const PARSE_EXECUTION_KEYS = ["queue_priority"];
const PARSE_SETTING_KEYS = [
  "embed_pdf_metadata",
  "extraction_mode",
  "force_url_result",
  "ocr_system",
  "page_range",
  "persist_results",
  "return_images",
  "return_ocr_data",
  "timeout",
];
const EXTRACT_SETTING_KEYS = [
  "deep_extract",
  "include_images",
  "optimize_for_latency",
];
const SPLIT_KEYS = ["split_description", "split_rules", "deep_split", "split_options"];
const SPLIT_SETTING_KEYS = ["deep_split"];
const ADVANCED_CHART_KEYS = new Set([
  "advanced_chart_agent",
  "advanced_chart_extraction",
  "chart_agent",
]);

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: JsonObject, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function cloneJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((entry) => cloneJsonValue(entry));
  if (!isObject(value)) return value;

  const clone: JsonObject = {};
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

function cloneJsonObject(value: JsonObject): ReductoJsonObject {
  return cloneJsonValue(value) as ReductoJsonObject;
}

function emptyConfigurations(): ReductoImportedConfigurations {
  return {
    parse: null,
    classify: null,
    extract: null,
    split: null,
    edit: null,
  };
}

function rejectUnknownKeys(owner: JsonObject, allowed: readonly string[], label: string) {
  const allowedKeys = new Set(allowed);
  const unknownKeys = Object.keys(owner).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `${label} contains unsupported field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}.`,
    );
  }
}

function detectedDefaults(source: "json" | "unknown" = "unknown") {
  return {
    source,
    operations: [] as ReductoImportedOperation[],
    extractMode: "none" as const,
    extractPageRanges: null as ReductoImportPageRange[] | null,
    schemaFieldCount: null as number | null,
    spreadsheet: false,
    advancedChart: false,
  };
}

function emptyResult(error: string, source: "json" | "unknown" = "unknown"): ReductoCodeImportResult {
  return {
    applicable: false,
    pipeline: null,
    configurations: emptyConfigurations(),
    detected: detectedDefaults(source),
    warnings: [],
    error,
  };
}

/**
 * A deliberately small JSON parser used so adjacent JSON objects can be read
 * without evaluating pasted text. It also rejects duplicate object keys,
 * excessive nesting, and unusually large collections instead of silently
 * choosing one value.
 */
class StrictJsonParser {
  private index = 0;
  private itemCount = 0;

  constructor(private readonly source: string) {}

  parseConfigurations(): JsonObject[] {
    this.skipWhitespace();
    if (this.index >= this.source.length) throw new Error("Paste a Reducto JSON configuration first.");

    if (this.source[this.index] === "[") {
      const value = this.parseValue(0);
      this.skipWhitespace();
      if (this.index !== this.source.length) throw new Error("Unexpected text after the JSON array.");
      if (!Array.isArray(value) || value.length === 0 || value.some((entry) => !isObject(entry))) {
        throw new Error("A configuration array must contain one or more JSON objects.");
      }
      return value as JsonObject[];
    }

    const result: JsonObject[] = [];
    while (this.index < this.source.length) {
      const value = this.parseValue(0);
      if (!isObject(value)) throw new Error("Each Reducto configuration must be a complete JSON object.");
      result.push(value);
      this.skipWhitespace();
    }
    return result;
  }

  private parseValue(depth: number): JsonValue {
    if (depth > MAX_JSON_DEPTH) throw new Error("The JSON configuration is nested too deeply.");
    this.skipWhitespace();
    const character = this.source[this.index];
    if (character === "{") return this.parseObject(depth + 1);
    if (character === "[") return this.parseArray(depth + 1);
    if (character === "\"") return this.parseString();
    if (character === "-" || /[0-9]/.test(character ?? "")) return this.parseNumber();
    if (this.source.startsWith("true", this.index)) {
      this.index += 4;
      return true;
    }
    if (this.source.startsWith("false", this.index)) {
      this.index += 5;
      return false;
    }
    if (this.source.startsWith("null", this.index)) {
      this.index += 4;
      return null;
    }
    throw new Error("The pasted configuration contains invalid JSON.");
  }

  private parseObject(depth: number): JsonObject {
    this.index += 1;
    const result = Object.create(null) as JsonObject;
    this.skipWhitespace();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return result;
    }

    while (this.index < this.source.length) {
      this.incrementItems();
      if (this.source[this.index] !== "\"") throw new Error("JSON object keys must use double quotes.");
      const key = this.parseString();
      if (hasOwn(result, key)) throw new Error(`The JSON contains a duplicate "${key}" key.`);
      this.skipWhitespace();
      if (this.source[this.index] !== ":") throw new Error(`The "${key}" key needs a value.`);
      this.index += 1;
      result[key] = this.parseValue(depth);
      this.skipWhitespace();
      if (this.source[this.index] === "}") {
        this.index += 1;
        return result;
      }
      if (this.source[this.index] !== ",") throw new Error("JSON object entries must be separated by commas.");
      this.index += 1;
      this.skipWhitespace();
      if (this.source[this.index] === "}") throw new Error("JSON does not allow a trailing comma.");
    }
    throw new Error("The JSON object is incomplete.");
  }

  private parseArray(depth: number): JsonValue[] {
    this.index += 1;
    const result: JsonValue[] = [];
    this.skipWhitespace();
    if (this.source[this.index] === "]") {
      this.index += 1;
      return result;
    }

    while (this.index < this.source.length) {
      this.incrementItems();
      result.push(this.parseValue(depth));
      this.skipWhitespace();
      if (this.source[this.index] === "]") {
        this.index += 1;
        return result;
      }
      if (this.source[this.index] !== ",") throw new Error("JSON array items must be separated by commas.");
      this.index += 1;
      this.skipWhitespace();
      if (this.source[this.index] === "]") throw new Error("JSON does not allow a trailing comma.");
    }
    throw new Error("The JSON array is incomplete.");
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === "\"") {
        this.index += 1;
        try {
          return JSON.parse(this.source.slice(start, this.index)) as string;
        } catch {
          throw new Error("The JSON contains an invalid string.");
        }
      }
      if (character === "\\") {
        this.index += 2;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) throw new Error("JSON strings cannot contain raw control characters.");
      this.index += 1;
    }
    throw new Error("The JSON contains an incomplete string.");
  }

  private parseNumber(): number {
    const match = this.source.slice(this.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) throw new Error("The JSON contains an invalid number.");
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new Error("The JSON number is outside the supported range.");
    return value;
  }

  private skipWhitespace() {
    while (/\s/.test(this.source[this.index] ?? "")) this.index += 1;
  }

  private incrementItems() {
    this.itemCount += 1;
    if (this.itemCount > MAX_JSON_ITEMS) throw new Error("The JSON configuration is too large.");
  }
}

function optionalObject(owner: JsonObject, key: string, label: string): JsonObject | undefined {
  if (!hasOwn(owner, key) || owner[key] === null) return undefined;
  if (!isObject(owner[key])) throw new Error(`${label} must be a JSON object.`);
  return owner[key] as JsonObject;
}

function optionalBoolean(owner: JsonObject | undefined, key: string, label: string): boolean | undefined {
  if (!owner || !hasOwn(owner, key) || owner[key] === null) return undefined;
  if (typeof owner[key] !== "boolean") throw new Error(`${label} must be true or false.`);
  return owner[key] as boolean;
}

function containsAnyKey(owner: JsonObject | undefined, keys: readonly string[]) {
  return Boolean(owner && keys.some((key) => hasOwn(owner, key)));
}

function inferOperation(config: JsonObject): SupportedOperation {
  const settings = isObject(config.settings) ? config.settings : undefined;
  const candidates: SupportedOperation[] = [];

  if (
    containsAnyKey(config, PARSE_TOP_LEVEL_KEYS) ||
    containsAnyKey(config, PARSE_EXECUTION_KEYS)
  ) {
    candidates.push("parse");
  }
  if (hasOwn(config, "classification_schema")) candidates.push("classify");
  if (hasOwn(config, "instructions")) candidates.push("extract");
  if (containsAnyKey(config, SPLIT_KEYS)) candidates.push("split");
  if (hasOwn(config, "edit_instructions")) candidates.push("edit");

  // A complete Studio export has endpoint-specific top-level keys. Settings
  // are used as a fallback for smaller API configs; this keeps a shared
  // `page_range` key from making an otherwise clear Extract object ambiguous.
  if (candidates.length === 0) {
    if (containsAnyKey(settings, PARSE_SETTING_KEYS)) candidates.push("parse");
    if (containsAnyKey(settings, EXTRACT_SETTING_KEYS)) candidates.push("extract");
    if (containsAnyKey(settings, SPLIT_SETTING_KEYS)) candidates.push("split");
  }

  if (candidates.length === 0) {
    throw new Error(
      "A JSON object does not match a Reducto Parse, Classify, Extract, Split, or Edit configuration.",
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `One JSON object looks like multiple Reducto configurations (${candidates.join(", ")}); paste each endpoint configuration as its own complete object.`,
    );
  }
  return candidates[0];
}

function pageRangeFromValue(
  value: JsonValue | undefined,
  label: string,
): ReductoImportPageRange[] | null {
  if (value === undefined || value === null) return null;
  const rawRanges = Array.isArray(value) ? value : [value];
  if (rawRanges.length === 0) {
    throw new Error(`${label} cannot be an empty array; use an empty object for all pages.`);
  }

  const ranges: ReductoImportPageRange[] = [];
  for (const rawRange of rawRanges) {
    if (!isObject(rawRange)) {
      throw new Error(`${label} must contain objects with start and end pages.`);
    }
    const keys = Object.keys(rawRange);
    if (!Array.isArray(value) && keys.length === 0) return null;
    if (keys.length === 0 || keys.some((key) => key !== "start" && key !== "end")) {
      throw new Error(`${label} contains an incomplete or unsupported range.`);
    }
    const start = rawRange.start;
    const end = rawRange.end;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      (start as number) < 1 ||
      (end as number) < (start as number)
    ) {
      throw new Error(`${label} needs positive whole start and end pages.`);
    }
    ranges.push({ start: start as number, end: end as number });
  }

  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: ReductoImportPageRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function sameRanges(
  left: ReductoImportPageRange[] | null,
  right: ReductoImportPageRange[] | null,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function countSchemaFields(schema: JsonValue | undefined, depth = 0): number | null {
  if (depth > MAX_JSON_DEPTH || !isObject(schema) || !isObject(schema.properties)) return null;
  let count = 0;
  for (const definition of Object.values(schema.properties)) {
    if (!isObject(definition)) {
      count += 1;
      continue;
    }
    const nested = countSchemaFields(definition, depth + 1);
    if (nested !== null) {
      count += nested;
      continue;
    }
    const nestedItems = countSchemaFields(definition.items, depth + 1);
    count += nestedItems ?? 1;
  }
  return count;
}

function schemaHasUnboundedFieldCount(schema: JsonValue | undefined): boolean {
  if (!isObject(schema)) return true;
  if (
    ["$ref", "oneOf", "anyOf", "allOf", "patternProperties", "dependentSchemas", "unevaluatedProperties"].some(
      (key) => hasOwn(schema, key),
    )
  ) {
    return true;
  }
  if (schema.type === "array" || hasOwn(schema, "items")) return true;
  if (
    hasOwn(schema, "additionalProperties") &&
    schema.additionalProperties !== false &&
    schema.additionalProperties !== null
  ) {
    return true;
  }
  if (schema.type === "object" && !isObject(schema.properties)) return true;
  if (!isObject(schema.properties)) return true;
  return Object.values(schema.properties).some((definition) => {
    if (!isObject(definition)) return false;
    if (
      ["$ref", "oneOf", "anyOf", "allOf", "patternProperties", "dependentSchemas", "unevaluatedProperties"].some(
        (key) => hasOwn(definition, key),
      )
    ) {
      return true;
    }
    if (definition.type === "array" || hasOwn(definition, "items")) return true;
    if (
      hasOwn(definition, "additionalProperties") &&
      definition.additionalProperties !== false &&
      definition.additionalProperties !== null
    ) {
      return true;
    }
    if (definition.type === "object" && !isObject(definition.properties)) return true;
    return hasOwn(definition, "properties") && schemaHasUnboundedFieldCount(definition);
  });
}

function inspectParseConfig(config: JsonObject) {
  const wrongEndpointKey = [
    "classification_schema",
    "instructions",
    "split_description",
    "split_rules",
    "split_options",
    "edit_instructions",
  ].find((key) => hasOwn(config, key));
  if (wrongEndpointKey) {
    throw new Error(
      `Parse configuration contains ${wrongEndpointKey}, which belongs to another endpoint.`,
    );
  }
  rejectUnknownKeys(
    config,
    [
      "enhance",
      "formatting",
      "retrieval",
      "settings",
      "spreadsheet",
      ...PARSE_EXECUTION_KEYS,
    ],
    "Parse configuration",
  );
  for (const key of PARSE_TOP_LEVEL_KEYS) {
    optionalObject(config, key, `Parse ${key}`);
  }
  const settings = optionalObject(config, "settings", "Parse settings");
  if (
    Object.keys(config).length > 0 &&
    !containsAnyKey(config, PARSE_TOP_LEVEL_KEYS) &&
    !containsAnyKey(config, PARSE_EXECUTION_KEYS) &&
    !containsAnyKey(settings, PARSE_SETTING_KEYS)
  ) {
    throw new Error("The nested parsing object does not contain a recognizable Parse configuration.");
  }
  const pageRanges = pageRangeFromValue(settings?.page_range, "Parse settings.page_range");
  const enhance = isObject(config.enhance) ? config.enhance : undefined;
  const formatting = isObject(config.formatting) ? config.formatting : undefined;
  const retrieval = isObject(config.retrieval) ? config.retrieval : undefined;
  const spreadsheet = isObject(config.spreadsheet) ? config.spreadsheet : undefined;
  const queuePriority = config.queue_priority;
  if (
    queuePriority !== undefined &&
    queuePriority !== null &&
    queuePriority !== "auto" &&
    queuePriority !== "batch"
  ) {
    throw new Error('Parse queue_priority must be "auto" or "batch".');
  }
  rejectUnknownKeys(settings ?? {}, PARSE_SETTING_KEYS, "Parse settings");
  rejectUnknownKeys(
    enhance ?? {},
    [
      "agentic",
      "intelligent_ordering",
      "summarize_figures",
      ...ADVANCED_CHART_KEYS,
    ],
    "Parse enhance",
  );
  rejectUnknownKeys(
    formatting ?? {},
    ["add_page_markers", "include", "merge_tables", "table_output_format"],
    "Parse formatting",
  );
  rejectUnknownKeys(
    retrieval ?? {},
    ["chunking", "embedding_optimized", "filter_blocks"],
    "Parse retrieval",
  );
  const chunking = optionalObject(retrieval ?? {}, "chunking", "Parse retrieval.chunking");
  rejectUnknownKeys(
    chunking ?? {},
    ["chunk_mode", "chunk_size", "chunk_overlap"],
    "Parse retrieval.chunking",
  );
  rejectUnknownKeys(
    spreadsheet ?? {},
    ["clustering", "exclude", "include", "max_cell_count", "split_large_tables"],
    "Parse spreadsheet",
  );
  const splitLargeTables = optionalObject(
    spreadsheet ?? {},
    "split_large_tables",
    "Parse spreadsheet.split_large_tables",
  );
  rejectUnknownKeys(
    splitLargeTables ?? {},
    ["enabled", "size"],
    "Parse spreadsheet.split_large_tables",
  );
  const agentic = enhance?.agentic;
  if (agentic !== undefined && agentic !== null && !Array.isArray(agentic)) {
    throw new Error("Parse enhance.agentic must be an array.");
  }
  if (Array.isArray(agentic) && agentic.some((entry) => !isObject(entry))) {
    throw new Error("Each Parse enhance.agentic entry must be a JSON object.");
  }
  const canonicalAgentic = Array.isArray(agentic)
    ? agentic.map((entry, index): CanonicalAgenticMode => {
        const mode = entry as JsonObject;
        rejectUnknownKeys(
          mode,
          ["scope", "mode", "prompt", ...ADVANCED_CHART_KEYS],
          `Parse enhance.agentic[${index}]`,
        );
        const scope = mode.scope;
        if (
          scope !== "text" &&
          scope !== "table" &&
          scope !== "figure"
        ) {
          throw new Error(
            `Parse enhance.agentic[${index}].scope must be text, table, or figure.`,
          );
        }
        const modeName = mode.mode;
        if (
          modeName !== undefined &&
          modeName !== null &&
          (typeof modeName !== "string" || !modeName.trim())
        ) {
          throw new Error(
            `Parse enhance.agentic[${index}].mode must be a nonempty string.`,
          );
        }
        const canonical: CanonicalAgenticMode = {
          scope,
          ...(typeof modeName === "string" ? { mode: modeName } : {}),
        };
        if (
          mode.prompt !== undefined &&
          mode.prompt !== null &&
          (typeof mode.prompt !== "string" || !mode.prompt.trim())
        ) {
          throw new Error(
            `Parse enhance.agentic[${index}].prompt must be a nonempty string or null.`,
          );
        }
        const chartValues = [...ADVANCED_CHART_KEYS]
          .filter((key) => hasOwn(mode, key))
          .map((key) => mode[key]);
        if (
          chartValues.some(
            (value) => value !== undefined && value !== null && typeof value !== "boolean",
          )
        ) {
          throw new Error(
            `Parse enhance.agentic[${index}].advanced_chart_agent must be true or false.`,
          );
        }
        if (chartValues.some((value) => value === true)) {
          if (canonical.scope !== "figure") {
            throw new Error(
              `Parse enhance.agentic[${index}].advanced_chart_agent requires scope "figure".`,
            );
          }
          canonical.advanced_chart_agent = true;
        }
        return canonical;
      })
    : null;
  for (const key of ADVANCED_CHART_KEYS) {
    optionalBoolean(enhance, key, `Parse enhance.${key}`);
  }
  const topLevelAdvancedChart = [...ADVANCED_CHART_KEYS].some(
    (key) => enhance?.[key] === true,
  );
  if (topLevelAdvancedChart && canonicalAgentic) {
    canonicalAgentic.push({ scope: "figure", advanced_chart_agent: true });
  }
  const summarizeFigures = optionalBoolean(
    enhance,
    "summarize_figures",
    "Parse enhance.summarize_figures",
  );
  const embeddingOptimized = optionalBoolean(
    retrieval,
    "embedding_optimized",
    "Parse retrieval.embedding_optimized",
  );
  return {
    pageRanges,
    agentic: Array.isArray(agentic) && agentic.length > 0,
    canonicalAgentic:
      topLevelAdvancedChart && canonicalAgentic === null
        ? ([{ scope: "figure", advanced_chart_agent: true }] satisfies CanonicalAgenticMode[])
        : canonicalAgentic,
    complex: summarizeFigures === true || embeddingOptimized === true,
    advancedChart:
      topLevelAdvancedChart ||
      canonicalAgentic?.some((mode) => mode.advanced_chart_agent === true) === true,
    queuePriority:
      queuePriority === "auto" || queuePriority === "batch" ? queuePriority : undefined,
    spreadsheetConfig: hasOwn(config, "spreadsheet"),
  };
}

type ParseInspection = ReturnType<typeof inspectParseConfig>;

function mergeParseInspections(
  sources: Array<{ label: string; value: ParseInspection | null }>,
): ParseInspection | null {
  const present = sources.filter(
    (source): source is { label: string; value: ParseInspection } => source.value !== null,
  );
  const first = present[0];
  if (!first) return null;

  for (const source of present.slice(1)) {
    if (
      !sameRanges(first.value.pageRanges, source.value.pageRanges) ||
      first.value.agentic !== source.value.agentic ||
      first.value.complex !== source.value.complex ||
      first.value.advancedChart !== source.value.advancedChart
    ) {
      throw new Error(
        `${first.label} conflicts with ${source.label}; Lumos cannot safely choose the bundled Parse settings.`,
      );
    }
  }

  return {
    ...first.value,
    spreadsheetConfig: present.some((source) => source.value.spreadsheetConfig),
  };
}

function inspectExtractConfig(config: JsonObject) {
  rejectUnknownKeys(config, ["instructions", "settings", "parsing"], "Extract configuration");
  const instructions = optionalObject(config, "instructions", "Extract instructions");
  const settings = optionalObject(config, "settings", "Extract settings");
  const parsing = optionalObject(config, "parsing", "Extract parsing");
  rejectUnknownKeys(
    instructions ?? {},
    ["schema", "system_prompt"],
    "Extract instructions",
  );
  rejectUnknownKeys(
    settings ?? {},
    [
      "alpha",
      "array_extract",
      "citations",
      "deep_extract",
      "include_images",
      "optimize_for_latency",
      "page_range",
    ],
    "Extract settings",
  );
  const citations = optionalObject(settings ?? {}, "citations", "Extract settings.citations");
  const alpha = optionalObject(settings ?? {}, "alpha", "Extract settings.alpha");
  rejectUnknownKeys(
    citations ?? {},
    ["enabled", "numerical_confidence"],
    "Extract settings.citations",
  );
  rejectUnknownKeys(
    alpha ?? {},
    ["deep_extract_confidence"],
    "Extract settings.alpha",
  );
  const schema = instructions?.schema;
  if (schema !== undefined && schema !== null && !isObject(schema)) {
    throw new Error("Extract instructions.schema must be a JSON object.");
  }
  const deepExtract = optionalBoolean(settings, "deep_extract", "Extract settings.deep_extract");
  const includeImages = optionalBoolean(settings, "include_images", "Extract settings.include_images");
  const optimizeForLatency = optionalBoolean(
    settings,
    "optimize_for_latency",
    "Extract settings.optimize_for_latency",
  );
  const arrayExtract = optionalBoolean(
    settings,
    "array_extract",
    "Extract settings.array_extract",
  );
  const pageRanges = pageRangeFromValue(settings?.page_range, "Extract settings.page_range");
  const schemaFieldCount = countSchemaFields(schema);
  return {
    deepExtract: deepExtract === true,
    includeImages: includeImages === true,
    optimizeForLatency: optimizeForLatency === true,
    pageRanges,
    schemaFieldCount,
    fieldDensityUnpriced:
      arrayExtract === true || schemaFieldCount === null || schemaHasUnboundedFieldCount(schema),
    parsing: parsing ? inspectParseConfig(parsing) : null,
  };
}

function inspectSplitConfig(config: JsonObject) {
  rejectUnknownKeys(
    config,
    ["split_description", "split_rules", "deep_split", "split_options", "settings", "parsing"],
    "Split configuration",
  );
  if (hasOwn(config, "split_description") && !Array.isArray(config.split_description)) {
    throw new Error("Split split_description must be an array.");
  }
  if (
    Array.isArray(config.split_description) &&
    config.split_description.some((entry) => !isObject(entry))
  ) {
    throw new Error("Each Split split_description entry must be a JSON object.");
  }
  if (hasOwn(config, "split_rules") && typeof config.split_rules !== "string") {
    throw new Error("Split split_rules must be a string.");
  }
  const splitOptions = optionalObject(config, "split_options", "Split split_options");
  const settings = optionalObject(config, "settings", "Split settings");
  const parsing = optionalObject(config, "parsing", "Split parsing");
  rejectUnknownKeys(splitOptions ?? {}, ["table_cutoff"], "Split split_options");
  rejectUnknownKeys(settings ?? {}, ["deep_split", "table_cutoff"], "Split settings");
  const studioDeepSplit = optionalBoolean(config, "deep_split", "Split deep_split");
  const apiDeepSplit = optionalBoolean(settings, "deep_split", "Split settings.deep_split");
  if (
    studioDeepSplit !== undefined &&
    apiDeepSplit !== undefined &&
    studioDeepSplit !== apiDeepSplit
  ) {
    throw new Error("Split deep_split conflicts with settings.deep_split.");
  }
  return {
    deepSplit: (studioDeepSplit ?? apiDeepSplit) === true,
    parsing: parsing ? inspectParseConfig(parsing) : null,
    compatibilityFields: [
      ...(studioDeepSplit !== undefined ? ["deep_split"] : []),
      ...(splitOptions && hasOwn(splitOptions, "table_cutoff")
        ? ["split_options.table_cutoff"]
        : []),
    ],
  };
}

function inspectClassifyConfig(config: JsonObject) {
  rejectUnknownKeys(
    config,
    ["classification_schema", "page_range"],
    "Classify configuration",
  );
  const schema = config.classification_schema;
  if (!isObject(schema) && !Array.isArray(schema)) {
    throw new Error("Classify classification_schema must be a JSON object or array.");
  }
  if (Array.isArray(config.page_range)) {
    throw new Error("Classify page_range must be one object with start and end pages.");
  }
  const pageRanges = pageRangeFromValue(config.page_range, "Classify page_range");
  if (pageRanges && pageRanges.length > 1) {
    throw new Error("Classify page_range must resolve to one inclusive range.");
  }
  return { pageRanges };
}

function inspectEditConfig(config: JsonObject) {
  rejectUnknownKeys(
    config,
    ["edit_instructions", "form_schema", "edit_options"],
    "Edit configuration",
  );
  if (typeof config.edit_instructions !== "string" || !config.edit_instructions.trim()) {
    throw new Error("Edit edit_instructions must be a nonempty string.");
  }
}

function failure(
  error: string,
  operations: ReductoImportedOperation[] = [],
  warnings: string[] = [],
): ReductoCodeImportResult {
  return {
    applicable: false,
    pipeline: null,
    configurations: emptyConfigurations(),
    detected: { ...detectedDefaults("json"), operations },
    warnings,
    error,
  };
}

function analyzeConfigurations(configurations: JsonObject[]): ReductoCodeImportResult {
  const configs = new Map<SupportedOperation, JsonObject>();
  let operations: ReductoImportedOperation[] = [];

  try {
    for (const config of configurations) {
      const operation = inferOperation(config);
      if (configs.has(operation)) {
        const label = operation.charAt(0).toUpperCase() + operation.slice(1);
        throw new Error(
          `More than one ${label} configuration was pasted; include one complete configuration per endpoint.`,
        );
      }
      configs.set(operation, config);
    }
    operations = OPERATION_ORDER.filter((operation) => configs.has(operation));

    const parseConfig = configs.get("parse");
    const classifyConfig = configs.get("classify");
    const extractConfig = configs.get("extract");
    const splitConfig = configs.get("split");
    const editConfig = configs.get("edit");
    const topLevelParse = parseConfig ? inspectParseConfig(parseConfig) : null;
    const classify = classifyConfig ? inspectClassifyConfig(classifyConfig) : null;
    const extract = extractConfig ? inspectExtractConfig(extractConfig) : null;
    const split = splitConfig ? inspectSplitConfig(splitConfig) : null;
    if (editConfig) inspectEditConfig(editConfig);
    const extractParse = extract
      ? mergeParseInspections([
          { label: "the pasted Parse configuration", value: topLevelParse },
          { label: "Extract parsing", value: extract.parsing },
        ])
      : null;
    const splitParse = split
      ? mergeParseInspections([
          { label: "the pasted Parse configuration", value: topLevelParse },
          { label: "Split parsing", value: split.parsing },
        ])
      : null;
    const hasBundledParse =
      topLevelParse !== null || extract?.parsing != null || split?.parsing != null;
    if (hasBundledParse && !operations.includes("parse")) {
      operations = OPERATION_ORDER.filter(
        (operation) => operation === "parse" || configs.has(operation),
      );
    }
    const warnings: string[] = [];

    if (
      topLevelParse?.spreadsheetConfig ||
      extractParse?.spreadsheetConfig ||
      splitParse?.spreadsheetConfig
    ) {
      warnings.push(
        "A Parse spreadsheet settings group was found. It does not identify the uploaded file type, and Lumos currently excludes spreadsheet documents from calculations.",
      );
    }
    if (split?.compatibilityFields.length) {
      const notes = [
        ...(split.compatibilityFields.includes("deep_split")
          ? ["top-level deep_split was normalized to settings.deep_split"]
          : []),
        ...(split.compatibilityFields.includes("split_options.table_cutoff")
          ? ["split_options.table_cutoff has no list-price effect"]
          : []),
      ];
      warnings.push(`Studio Split compatibility: ${notes.join("; ")}.`);
    }
    let extractPageRanges = extract?.pageRanges ?? null;
    const splitPageRanges = splitParse?.pageRanges ?? null;
    if (
      extractParse?.pageRanges &&
      extract?.pageRanges &&
      !sameRanges(extractParse.pageRanges, extract.pageRanges)
    ) {
      return failure(
        "Parse and Extract specify different page ranges, so Lumos cannot safely choose which pages to price.",
        operations,
        warnings,
      );
    }
    if (extractParse?.pageRanges && extract) {
      extractPageRanges = extractParse.pageRanges;
      warnings.push("The Parse page range was applied to the downstream Extract estimate.");
    }
    if (splitPageRanges) {
      warnings.push("The Parse page range was applied to the downstream Split estimate.");
    }

    const hasAdvancedChart = [topLevelParse, extract?.parsing, split?.parsing].some(
      (value) => value?.advancedChart === true,
    );
    const standaloneParse = topLevelParse !== null && !extract && !split;
    const includedDownstreamParse = hasBundledParse && Boolean(extract || split);
    if (
      includedDownstreamParse &&
      [topLevelParse, extract?.parsing, split?.parsing].some(
        (value) => value?.queuePriority === "batch",
      )
    ) {
      return failure(
        "Batch Parse is available only when Parse is priced as a standalone operation.",
        operations,
        warnings,
      );
    }
    const unpricedCostFactors = [
      ...(extract?.includeImages ? ["extract.include_images"] : []),
      ...(extract?.fieldDensityUnpriced ? ["extract.field_density"] : []),
      ...(standaloneParse && hasAdvancedChart ? ["parse.advanced_chart_count"] : []),
    ];
    if (extract?.includeImages) {
      warnings.push("Extract image context is enabled and remains an unpriced cost factor.");
    }
    if (extract?.fieldDensityUnpriced) {
      warnings.push("The Extract schema has no bounded field count, so field density remains an unpriced cost factor.");
    }
    if (standaloneParse && hasAdvancedChart) {
      warnings.push(
        "Advanced chart processing is configured, but no detected chart count is available before Parse runs, so that charge remains unpriced.",
      );
    }

    const extractSettings: NonNullable<NonNullable<PublicPipeline["extract"]>["settings"]> = {
      deep_extract: extract?.deepExtract ?? false,
      optimize_for_latency: extract?.optimizeForLatency ?? false,
      include_images: extract?.includeImages ?? false,
    };
    if (extractPageRanges) {
      extractSettings.page_range =
        extractPageRanges.length === 1 ? extractPageRanges[0] : extractPageRanges;
    }

    const pipeline: PublicPipeline = {
      parse: standaloneParse
        ? {
            ...(topLevelParse.canonicalAgentic === null
              ? {}
              : { enhance: { agentic: topLevelParse.canonicalAgentic } }),
            ...(topLevelParse.pageRanges
              ? {
                  settings: {
                    page_range:
                      topLevelParse.pageRanges.length === 1
                        ? topLevelParse.pageRanges[0]
                        : topLevelParse.pageRanges,
                  },
                }
              : {}),
            ...(topLevelParse.queuePriority
              ? { queue_priority: topLevelParse.queuePriority }
              : {}),
          }
        : includedDownstreamParse
          ? {}
          : null,
      classify: classify
        ? classify.pageRanges
          ? { page_range: classify.pageRanges[0] }
          : {}
        : null,
      extract: extract ? { settings: extractSettings } : null,
      split: split
        ? {
            settings: { deep_split: split.deepSplit },
            ...(splitPageRanges
              ? {
                  parsing: {
                    settings: {
                      page_range:
                        splitPageRanges.length === 1
                          ? splitPageRanges[0]
                          : splitPageRanges,
                    },
                  },
                }
              : {}),
          }
        : null,
      edit: editConfig ? {} : null,
      lumos_assumptions: {
        ...(standaloneParse ? { likely_complex_parse_share: 0.5 } : {}),
        conditional_extract_routing: false,
        ...(extract?.schemaFieldCount == null
          ? {}
          : { estimated_extract_fields_per_page: extract.schemaFieldCount }),
        ...(unpricedCostFactors.length === 0
          ? {}
          : { unpriced_cost_factors: [...new Set(unpricedCostFactors)] }),
      },
    };

    const importedConfigurations: ReductoImportedConfigurations = {
      parse: parseConfig ? cloneJsonObject(parseConfig) : null,
      classify: classifyConfig ? cloneJsonObject(classifyConfig) : null,
      extract: extractConfig ? cloneJsonObject(extractConfig) : null,
      split: splitConfig ? cloneJsonObject(splitConfig) : null,
      edit: editConfig ? cloneJsonObject(editConfig) : null,
    };

    return {
      applicable: true,
      pipeline,
      configurations: importedConfigurations,
      detected: {
        source: "json",
        operations,
        extractMode: extract ? (extract.deepExtract ? "deep" : "standard") : "none",
        extractPageRanges,
        schemaFieldCount: extract?.schemaFieldCount ?? null,
        spreadsheet: false,
        advancedChart: hasAdvancedChart,
      },
      warnings,
      error: null,
    };
  } catch (error) {
    return failure(
      error instanceof Error ? error.message : "The JSON configuration could not be imported.",
      operations,
    );
  }
}

/**
 * Imports cost-relevant intent from one or more complete Reducto JSON
 * configurations. Pasted text is parsed only as JSON and is never evaluated or
 * executed.
 */
export function importReductoCode(source: string): ReductoCodeImportResult {
  if (typeof source !== "string" || !source.trim()) {
    return emptyResult("Paste a Reducto JSON configuration first.");
  }
  if (source.length > MAX_SOURCE_LENGTH) {
    return emptyResult("The pasted JSON configuration is too large to inspect safely.", "json");
  }

  const trimmed = source
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    const configurations = new StrictJsonParser(trimmed).parseConfigurations();
    return analyzeConfigurations(configurations);
  } catch (error) {
    return emptyResult(
      error instanceof Error ? error.message : "The pasted configuration is invalid JSON.",
      "json",
    );
  }
}
