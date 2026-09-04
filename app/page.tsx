"use client";

import {
  ChangeEvent,
  KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Image from "next/image";
import packageJson from "@/package.json";
import { appPath } from "@/lib/app-path";
import {
  DEFAULT_PRICING_UNIT_RATES,
  estimatePipeline,
  FIXED_PRICING_RULES,
  isSpreadsheetFilename as isSpreadsheetName,
  normalizeRequest,
  RATE_CARD,
  R1_RATE_CARD,
  type PricingUnitRates,
  type PublicEstimateDocument,
  type PublicEstimateRequest,
  type PublicPipeline,
} from "@/lib/pricing";
import {
  DEFAULT_MANUAL_PIPELINE_DRAFT,
  manualErrorEndpoint,
  manualDraftProcessingContext,
  manualDraftToPipeline,
  pipelineToManualDraft,
  type ManualEndpoint,
  type ManualPageSelectionDraft,
  type ManualParsingAddOnDraft,
  type ManualPipelineDraft,
  type ManualPipelineErrors,
  type ManualSpreadsheetDraft,
} from "@/lib/manual-pipeline";
import { importReductoCode, type ReductoCodeImportResult } from "@/lib/reducto-code-import";
import { serializeLumosProfile } from "@/lib/profile-copy";
import { SIMULATOR_EXAMPLE_REQUEST } from "@/lib/simulator-example";
import { simulatorModeLabel } from "@/lib/simulator-mode";

type DocumentRow = {
  id: string;
  name: string;
  pages: number;
  estimatedNonEmptyCells: string;
  note: string;
  file?: File;
};

type PipelineDraftState = "unconfigured" | "applied" | "dirty" | "invalid";
type PipelineInputTab = "profile" | "code";
type RateFieldKey = keyof PricingUnitRates;
type RateDraft = Record<RateFieldKey, string>;
type RateErrors = Partial<Record<RateFieldKey, string>>;
type FixedRuleKey = "agentic" | "latency" | "batch";
type ProfileCopyState = "idle" | "copied" | "error";

const RATE_GROUPS = [
  {
    name: "Parse",
    fields: [
      { key: "parseStandard", label: "Legacy Parse — Standard", perThousand: true },
      { key: "parseComplex", label: "Legacy Parse — Complex", perThousand: true },
      { key: "parseR1", label: "r‑1 Parse (Beta)", perThousand: true },
    ],
  },
  {
    name: "Parsing add-ons",
    fields: [
      {
        key: "advancedChart",
        label: "Advanced Chart",
        perThousand: false,
        unit: "/ detected chart",
      },
      { key: "ocrDataReturn", label: "OCR data return", perThousand: true },
      {
        key: "promptedBlocks",
        label: "Prompted blocks / custom regions",
        perThousand: true,
      },
    ],
  },
  {
    name: "Classify",
    fields: [{ key: "classify", label: "Classify", perThousand: true }],
  },
  {
    name: "Extract",
    fields: [
      { key: "extract", label: "Standard Extract", perThousand: true },
      { key: "deepExtract", label: "Deep Extract", perThousand: true },
    ],
  },
  {
    name: "Split",
    fields: [
      { key: "split", label: "Split", perThousand: true },
      { key: "deepSplit", label: "Deep Split", perThousand: true },
    ],
  },
  {
    name: "Edit",
    fields: [
      { key: "edit", label: "Edit", perThousand: true },
      { key: "editPrefilled", label: "Fully prefilled Edit", perThousand: true },
    ],
  },
  {
    name: "Spreadsheet",
    fields: [
      {
        key: "spreadsheetCredit",
        label: "Spreadsheet credit (Lumos default)",
        perThousand: false,
        unit: "/ credit",
      },
    ],
  },
] as const satisfies ReadonlyArray<{
  name: string;
  fields: ReadonlyArray<{
    key: RateFieldKey;
    label: string;
    perThousand: boolean;
    unit?: string;
  }>;
}>;

const RATE_FIELD_KEYS = RATE_GROUPS.flatMap((group) => group.fields.map((field) => field.key));
const MAX_DISPLAY_RATE = 1_000_000_000;

function ratesToDraft(rates: PricingUnitRates): RateDraft {
  return Object.fromEntries(
    RATE_GROUPS.flatMap((group) =>
      group.fields.map((field) => [
        field.key,
        String(rates[field.key] * (field.perThousand ? 1000 : 1)),
      ]),
    ),
  ) as RateDraft;
}

function validateRateDraft(draft: RateDraft) {
  const errors: RateErrors = {};
  const parsed = {} as Record<RateFieldKey, number>;

  for (const group of RATE_GROUPS) {
    for (const field of group.fields) {
      const rawValue = draft[field.key].trim();
      if (!/^\d+(?:\.\d+)?$/.test(rawValue)) {
        errors[field.key] = rawValue
          ? "Enter a nonnegative decimal without exponents."
          : "Enter a rate.";
        continue;
      }
      const displayValue = Number(rawValue);
      if (!Number.isFinite(displayValue)) {
        errors[field.key] = "Enter a finite rate.";
        continue;
      }
      if (displayValue > MAX_DISPLAY_RATE) {
        errors[field.key] = "Enter a rate no greater than 1,000,000,000.";
        continue;
      }
      if (displayValue === 0 && /[1-9]/.test(rawValue)) {
        errors[field.key] = "Enter a rate large enough to calculate.";
        continue;
      }
      const unitRate = displayValue / (field.perThousand ? 1000 : 1);
      if (displayValue > 0 && unitRate === 0) {
        errors[field.key] = "Enter a rate large enough to calculate.";
        continue;
      }
      parsed[field.key] = unitRate;
    }
  }

  if (!errors.parseStandard && !errors.parseComplex && parsed.parseComplex < parsed.parseStandard) {
    errors.parseComplex = "Complex Parse must be at least Standard Parse.";
  }
  if (!errors.extract && !errors.deepExtract && parsed.deepExtract < parsed.extract) {
    errors.deepExtract = "Deep Extract must be at least Standard Extract.";
  }
  if (!errors.split && !errors.deepSplit && parsed.deepSplit < parsed.split) {
    errors.deepSplit = "Deep Split must be at least Split.";
  }
  if (!errors.edit && !errors.editPrefilled && parsed.edit < parsed.editPrefilled) {
    errors.edit = "Edit must be at least Fully prefilled Edit.";
  }

  return { rates: parsed as PricingUnitRates, errors };
}

function sameRates(left: PricingUnitRates, right: PricingUnitRates) {
  return RATE_FIELD_KEYS.every((key) => left[key] === right[key]);
}

const DEFAULT_PIPELINE: PublicPipeline = {
  parse: null,
  classify: null,
  extract: {
    settings: { deep_extract: false, optimize_for_latency: false, include_images: false },
  },
  split: null,
  edit: null,
  lumos_assumptions: {
    conditional_extract_routing: false,
    estimated_extract_fields_per_page: 24,
  },
};

const MANUAL_ENDPOINTS = ["parse", "classify", "extract", "split", "edit"] as const;
const MANUAL_ENDPOINT_LABELS: Record<ManualEndpoint, string> = {
  parse: "Parse (standalone)",
  classify: "Classify",
  extract: "Extract",
  split: "Split",
  edit: "Edit",
};

function cloneManualDraft(draft: ManualPipelineDraft): ManualPipelineDraft {
  return {
    ...draft,
    parse: {
      ...draft.parse,
      agenticScopes: { ...draft.parse.agenticScopes },
      spreadsheet: { ...draft.parse.spreadsheet },
      pageSelection: {
        ...draft.parse.pageSelection,
        ranges: draft.parse.pageSelection.ranges.map((range) => ({ ...range })),
      },
    },
    classify: { ...draft.classify },
    extract: {
      ...draft.extract,
      parsingAddOns: { ...draft.extract.parsingAddOns },
      spreadsheet: { ...draft.extract.spreadsheet },
      pageSelection: {
        ...draft.extract.pageSelection,
        ranges: draft.extract.pageSelection.ranges.map((range) => ({ ...range })),
      },
    },
    split: {
      ...draft.split,
      parsingAddOns: { ...draft.split.parsingAddOns },
      spreadsheet: { ...draft.split.spreadsheet },
      pageSelection: {
        ...draft.split.pageSelection,
        ranges: draft.split.pageSelection.ranges.map((range) => ({ ...range })),
      },
    },
    edit: { ...draft.edit },
    assumptions: {
      ...draft.assumptions,
      unpricedCostFactors: [...draft.assumptions.unpricedCostFactors],
    },
    ...(draft.importedConfigurations
      ? { importedConfigurations: structuredClone(draft.importedConfigurations) }
      : {}),
  };
}

function manualEndpointEnabled(draft: ManualPipelineDraft, endpoint: ManualEndpoint) {
  if (endpoint === "parse") return draft.parse.enabled;
  if (endpoint === "classify") return draft.classify.enabled;
  if (endpoint === "extract") return draft.extract.mode !== "off";
  if (endpoint === "split") return draft.split.mode !== "off";
  return draft.edit.enabled;
}

function firstEnabledEndpoint(draft: ManualPipelineDraft): ManualEndpoint {
  return MANUAL_ENDPOINTS.find((endpoint) => manualEndpointEnabled(draft, endpoint)) ?? "extract";
}

function manualSetupError(error: unknown) {
  const message = error instanceof Error
    ? error.message
    : "This setup cannot be applied to the current documents.";
  const rangeError = message.match(
    /^(Parse|Extract|Split)(?: settings\.page_range| parsing\.settings\.page_range) selects no pages in (.+)\.$/,
  );
  if (rangeError) {
    return `The ${rangeError[1]} Page range does not include any pages in ${rangeError[2]}.`;
  }
  const classifyError = message.match(
    /^Classify page_range starts after the last page in (.+)\.$/,
  );
  if (classifyError) {
    return `The Classify context starts after the last page in ${classifyError[1]}.`;
  }
  return message;
}

function manualSetupErrorEndpoint(error: unknown): ManualEndpoint | null {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("Parse ")) return "parse";
  if (message.startsWith("Classify ")) return "classify";
  if (message.startsWith("Extract ")) return "extract";
  if (message.startsWith("Split ")) return "split";
  if (message.startsWith("Edit ")) return "edit";
  return null;
}

function PageSelectionEditor({
  id,
  legend,
  selection,
  errors,
  errorField,
  onChange,
}: {
  id: string;
  legend: string;
  selection: ManualPageSelectionDraft;
  errors: ManualPipelineErrors;
  errorField: "parse.pageSelection" | "extract.pageSelection" | "split.pageSelection";
  onChange: (selection: ManualPageSelectionDraft) => void;
}) {
  const selectionError = errors[errorField];
  return (
    <fieldset className="builder-section">
      <legend>{legend}</legend>
      <div className="choice-row">
        <label>
          <input
            type="radio"
            name={`${id}-mode`}
            checked={selection.mode === "all"}
            onChange={() => onChange({ ...selection, mode: "all" })}
          />
          All pages
        </label>
        <label>
          <input
            type="radio"
            name={`${id}-mode`}
            checked={selection.mode === "selected"}
            onChange={() =>
              onChange({
                ...selection,
                mode: "selected",
                ranges: selection.ranges.length
                  ? selection.ranges
                  : [{ id: `${id}-${crypto.randomUUID()}`, start: "1", end: "1" }],
              })
            }
          />
          Selected pages
        </label>
      </div>
      {selection.mode === "selected" && (
        <div className="page-ranges">
          {selection.ranges.map((range, index) => {
            const startError = errors[`${errorField}.ranges.${index}.start`];
            const endError = errors[`${errorField}.ranges.${index}.end`];
            return (
              <div className="page-range-row" key={range.id ?? `${id}-range-${index}`}>
                <label>
                  Start
                  <input
                    type="number"
                    min="1"
                    step="1"
                    inputMode="numeric"
                    aria-label={`${legend} ${index + 1} start`}
                    aria-invalid={startError || (selectionError && index === 0) ? "true" : undefined}
                    value={range.start}
                    onChange={(event) =>
                      onChange({
                        ...selection,
                        ranges: selection.ranges.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, start: event.target.value } : item,
                        ),
                      })
                    }
                  />
                  {startError && <span className="field-error">{startError}</span>}
                </label>
                <label>
                  End
                  <input
                    type="number"
                    min="1"
                    step="1"
                    inputMode="numeric"
                    aria-label={`${legend} ${index + 1} end`}
                    aria-invalid={endError ? "true" : undefined}
                    value={range.end}
                    onChange={(event) =>
                      onChange({
                        ...selection,
                        ranges: selection.ranges.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, end: event.target.value } : item,
                        ),
                      })
                    }
                  />
                  {endError && <span className="field-error">{endError}</span>}
                </label>
                {selection.ranges.length > 1 && (
                  <button
                    type="button"
                    className="remove-button"
                    aria-label={`Remove ${legend} ${index + 1}`}
                    onClick={() =>
                      onChange({
                        ...selection,
                        ranges: selection.ranges.filter((_, itemIndex) => itemIndex !== index),
                      })
                    }
                  >
                    Remove
                  </button>
                )}
              </div>
            );
          })}
          <button
            type="button"
            className="text-button"
            aria-label={`Add another ${legend}`}
            onClick={() =>
              onChange({
                ...selection,
                ranges: [
                  ...selection.ranges,
                  { id: `${id}-${crypto.randomUUID()}`, start: "1", end: "1" },
                ],
              })
            }
          >
            Add page range
          </button>
        </div>
      )}
      {selectionError && <p className="field-error">{selectionError}</p>}
    </fieldset>
  );
}

function ParsingAddOnControls({
  endpoint,
  value,
  errors,
  hasSpreadsheetDocuments,
  onChange,
}: {
  endpoint: "extract" | "split";
  value: ManualParsingAddOnDraft;
  errors: ManualPipelineErrors;
  hasSpreadsheetDocuments: boolean;
  onChange: (value: ManualParsingAddOnDraft) => void;
}) {
  const endpointLabel = endpoint === "extract" ? "Extract" : "Split";
  const likelyError = errors[`${endpoint}.parsingAddOns.likelyChartCount`];
  const maximumError = errors[`${endpoint}.parsingAddOns.maximumChartCount`];
  const reusesParse = value.inputKind === "jobid";
  return (
    <fieldset className="builder-section compact-builder-section">
      <legend>Parsing add-ons</legend>
      <label className="check-field">
        <input
          type="checkbox"
          checked={reusesParse}
          onChange={(event) =>
            onChange({ ...value, inputKind: event.target.checked ? "jobid" : "document" })
          }
        />
        Input reuses an existing Parse result (<code>jobid://</code>)
      </label>
      {reusesParse ? (
        <p className="aside">
          Parse add-ons were billed on the original job and are not charged again by {endpointLabel}.
        </p>
      ) : (
        <div className="nested-settings">
          <div className="check-grid">
            <label className="check-field">
              <input
                type="checkbox"
                checked={value.returnOcrData}
                onChange={(event) => onChange({ ...value, returnOcrData: event.target.checked })}
              />
              Return OCR data
            </label>
            <label className="check-field">
              <input
                type="checkbox"
                checked={value.promptedBlocks}
                onChange={(event) => onChange({ ...value, promptedBlocks: event.target.checked })}
              />
              Prompted blocks or custom regions
            </label>
            <label className="check-field">
              <input
                type="checkbox"
                checked={value.advancedChart}
                onChange={(event) => onChange({ ...value, advancedChart: event.target.checked })}
              />
              Advanced Chart Agent
            </label>
          </div>
          {value.advancedChart && (
            <div className="nested-settings">
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={value.chartCountsEnabled}
                  onChange={(event) =>
                    onChange({ ...value, chartCountsEnabled: event.target.checked })
                  }
                />
                Add expected chart counts
              </label>
              {value.chartCountsEnabled ? (
                <div className="form-grid">
                  <label className="number-field">
                    Likely charts
                    <input
                      type="number"
                      min="0"
                      step="1"
                      inputMode="numeric"
                      value={value.likelyChartCount}
                      aria-invalid={likelyError ? "true" : undefined}
                      onChange={(event) =>
                        onChange({ ...value, likelyChartCount: event.target.value })
                      }
                    />
                    {likelyError && <span className="field-error">{likelyError}</span>}
                  </label>
                  <label className="number-field">
                    Maximum charts
                    <input
                      type="number"
                      min="0"
                      step="1"
                      inputMode="numeric"
                      value={value.maximumChartCount}
                      aria-invalid={maximumError ? "true" : undefined}
                      onChange={(event) =>
                        onChange({ ...value, maximumChartCount: event.target.value })
                      }
                    />
                    {maximumError && <span className="field-error">{maximumError}</span>}
                  </label>
                </div>
              ) : (
                <p className="aside">The known subtotal will exclude the detected-chart charge.</p>
              )}
              {hasSpreadsheetDocuments && (
                <p className="aside">
                  Chart counts apply to non-spreadsheet documents. Spreadsheet chart costs remain
                  excluded.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </fieldset>
  );
}

function SpreadsheetSettings({
  endpoint,
  value,
  errors,
  onChange,
}: {
  endpoint: "parse" | "extract";
  value: ManualSpreadsheetDraft;
  errors: ManualPipelineErrors;
  onChange: (value: ManualSpreadsheetDraft) => void;
}) {
  const clusteringError = errors[`${endpoint}.spreadsheet.clustering`];
  const maxError = errors[`${endpoint}.spreadsheet.maxCellCount`];
  const clusteringErrorId = `${endpoint}-spreadsheet-clustering-error`;
  const maxErrorId = `${endpoint}-spreadsheet-max-error`;
  return (
    <fieldset className="builder-section compact-builder-section spreadsheet-settings">
      <legend>Spreadsheet</legend>
      <div className="form-grid">
        <label>
          Clustering
          <select
            value={value.clustering}
            aria-invalid={clusteringError ? "true" : undefined}
            aria-describedby={clusteringError ? clusteringErrorId : undefined}
            onChange={(event) =>
              onChange({
                ...value,
                configured: true,
                clustering: event.target.value as ManualSpreadsheetDraft["clustering"],
              })
            }
          >
            <option value="accurate">Accurate (default)</option>
            <option value="fast">Fast</option>
            <option value="disabled">Disabled</option>
          </select>
          {clusteringError && (
            <span id={clusteringErrorId} className="field-error">{clusteringError}</span>
          )}
        </label>
        <label className="number-field">
          Maximum non-empty cells
          <input
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            placeholder="No limit"
            value={value.maxCellCount}
            aria-invalid={maxError ? "true" : undefined}
            aria-describedby={maxError ? maxErrorId : undefined}
            onChange={(event) =>
              onChange({
                ...value,
                configured: true,
                maxCellCount: event.target.value,
              })
            }
          />
          {maxError && <span id={maxErrorId} className="field-error">{maxError}</span>}
        </label>
      </div>
      <p className="aside">
        Clustering sets cell usage. The maximum is a Reducto safety limit, not the estimate.
      </p>
    </fieldset>
  );
}

function makeExampleDocuments(): DocumentRow[] {
  return SIMULATOR_EXAMPLE_REQUEST.documents.map(({ name, pages }, index) => ({
    id: `example-${index}`,
    name,
    pages,
    estimatedNonEmptyCells: "",
    note: "Example metadata",
  }));
}

function money(value: number) {
  const absolute = Math.abs(value);
  const decimalPlaces = absolute > 0 && absolute < 0.0001 ? 6 : absolute < 1 ? 4 : 2;
  const factor = 10 ** decimalPlaces;
  const rounded = Math.round((value + Number.EPSILON) * factor) / factor;
  return `$${rounded.toFixed(decimalPlaces)}`;
}

function rateMoney(value: number) {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

function toPublicEstimateDocument(document: DocumentRow): PublicEstimateDocument {
  if (!isSpreadsheetName(document.name)) {
    return { name: document.name, pages: document.pages };
  }
  const rawCells = document.estimatedNonEmptyCells.trim();
  if (rawCells === "") return { name: document.name };
  if (!/^\d+$/.test(rawCells)) {
    throw new Error(
      `${document.name} needs a whole estimated non-empty-cell count of 0 or greater.`,
    );
  }
  const cells = Number(rawCells);
  if (!Number.isSafeInteger(cells)) {
    throw new Error(`${document.name} has a cell count that is too large to estimate safely.`);
  }
  return { name: document.name, estimated_non_empty_cells: cells };
}

function importSummary(result: ReductoCodeImportResult) {
  const operationNames = result.detected.operations.map((operation) => {
    if (operation === "extract") {
      return result.detected.extractMode === "deep" ? "Deep Extract" : "Standard Extract";
    }
    if (operation === "parse") {
      if (result.pipeline?.parse?.settings?.model === "r-1") return "r‑1 Parse (Beta)";
      return result.pipeline?.parse?.enhance?.agentic?.length ? "Agentic Parse" : "Legacy Parse";
    }
    if (operation === "pipeline") return "deployed pipeline call";
    return operation.charAt(0).toUpperCase() + operation.slice(1);
  });
  if (!operationNames.length) return "";

  const details = [...operationNames];
  if (result.detected.operations.includes("extract")) {
    const ranges = result.detected.extractPageRanges;
    details.push(
      ranges?.length
        ? `pages ${ranges.map(({ start, end }) => (start === end ? start : `${start}–${end}`)).join(", ")}`
        : "all pages",
    );
    if (result.detected.schemaFieldCount != null) {
      details.push(`${result.detected.schemaFieldCount} schema fields`);
    }
    if (result.pipeline?.extract?.settings?.optimize_for_latency) {
      details.push("2× latency priority");
    }
  }
  if (result.pipeline?.parse?.queue_priority === "batch") {
    details.push("batch queue");
  }
  return details.join(" · ");
}

function unpricedFactorLabel(factor: string, advancedChartRate: string) {
  if (factor === "extract.include_images") return "Extract image context";
  if (factor === "spreadsheet.non_empty_cell_count") {
    return "the missing estimated non-empty-cell count";
  }
  if (factor === "spreadsheet.base_processing") {
    return "spreadsheet processing outside supported Parse or Extract pricing";
  }
  if (factor === "spreadsheet.classify") return "Classify work on spreadsheets";
  if (factor === "spreadsheet.split") return "Split work on spreadsheets";
  if (factor === "spreadsheet.edit") return "Edit work on spreadsheets";
  const spreadsheetAddOn = factor.match(
    /^spreadsheet\.(parse|extract|split)\.(return_ocr_data|prompted_processing|advanced_chart)$/,
  );
  if (spreadsheetAddOn) {
    const endpoint = spreadsheetAddOn[1].charAt(0).toUpperCase() + spreadsheetAddOn[1].slice(1);
    const feature = {
      return_ocr_data: "OCR data return",
      prompted_processing: "prompted processing",
      advanced_chart: "Advanced Chart",
    }[spreadsheetAddOn[2]];
    return `${endpoint} ${feature} on spreadsheets`;
  }
  if (factor.endsWith(".advanced_chart_count")) {
    const endpoint = factor.split(".")[0];
    const label = endpoint.charAt(0).toUpperCase() + endpoint.slice(1);
    return `${label}'s $${advancedChartRate}-per-detected-chart charge because no chart count was provided`;
  }
  if (factor === "extract.field_density") return "a possible dense-field surcharge";
  return factor;
}

async function inspectFile(file: File): Promise<DocumentRow> {
  const name = file.name.toLowerCase();
  let pages = 1;
  let note = "Confirm the page count";

  if (/\.(png|jpe?g|gif|heic|bmp)$/.test(name)) {
    note = "Image counted as one page";
  } else if (name.endsWith(".pdf")) {
    try {
      const content = new TextDecoder("latin1").decode(await file.arrayBuffer());
      const matches = content.match(/\/Type\s*\/Page(?!s)\b/g);
      if (matches?.length) {
        pages = matches.length;
        note = "PDF pages detected; editable";
      } else {
        note = "PDF count needs confirmation";
      }
    } catch {
      note = "PDF count needs confirmation";
    }
  } else if (/\.(ppt|pptx)$/.test(name)) {
    note = "Enter the slide count";
  } else if (/\.(doc|docx)$/.test(name)) {
    note = "Enter the rendered page count";
  } else if (/\.(xls|xlsx|xlsm|xltx|xltm|csv|qpw)$/.test(name)) {
    pages = 0;
    note = "Enter expected non-empty cells after exclusions or filtering";
  }

  return {
    id: crypto.randomUUID(),
    name: file.name,
    pages,
    estimatedNonEmptyCells: "",
    note,
    file,
  };
}

export default function Home() {
  const budgetPreview = useRef<HTMLDialogElement>(null);
  const budgetPreviewLink = useRef<HTMLAnchorElement>(null);
  const rateCardDialog = useRef<HTMLDialogElement>(null);
  const rateCardBody = useRef<HTMLDivElement>(null);
  const rateCardButton = useRef<HTMLButtonElement>(null);
  const rateInputRefs = useRef<Partial<Record<RateFieldKey, HTMLInputElement | null>>>({});
  const manualErrorSummary = useRef<HTMLDivElement>(null);
  const endpointTabRefs = useRef<Partial<Record<ManualEndpoint, HTMLButtonElement | null>>>({});
  const endpointPanelScroll = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastExtractMode = useRef<Exclude<ManualPipelineDraft["extract"]["mode"], "off">>(
    "standard",
  );
  const lastSplitMode = useRef<Exclude<ManualPipelineDraft["split"]["mode"], "off">>(
    "standard",
  );
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [pipeline, setPipeline] = useState<PublicPipeline>(DEFAULT_PIPELINE);
  const [appliedProcessingContext, setAppliedProcessingContext] = useState<
    PublicEstimateRequest["processing_context"]
  >(undefined);
  const [manualDraft, setManualDraft] = useState<ManualPipelineDraft>(() =>
    cloneManualDraft(DEFAULT_MANUAL_PIPELINE_DRAFT),
  );
  const [manualErrors, setManualErrors] = useState<ManualPipelineErrors>({});
  const [pipelineInputTab, setPipelineInputTab] = useState<PipelineInputTab>("profile");
  const [manualEndpointTab, setManualEndpointTab] = useState<ManualEndpoint>("extract");
  const [reductoCode, setReductoCode] = useState("");
  const [importApplied, setImportApplied] = useState(false);
  const [pipelineDraftState, setPipelineDraftState] = useState<PipelineDraftState>("unconfigured");
  const [pipelineError, setPipelineError] = useState("");
  const [profileCopyState, setProfileCopyState] = useState<ProfileCopyState>("idle");
  const [budget, setBudget] = useState(10);
  const [apiKey, setApiKey] = useState("");
  const [pipelineId, setPipelineId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [liveState, setLiveState] = useState<"idle" | "running" | "done">("idle");
  const [liveError, setLiveError] = useState("");
  const [liveResult, setLiveResult] = useState<unknown>(null);
  const [appliedRates, setAppliedRates] = useState<PricingUnitRates>(() => ({
    ...DEFAULT_PRICING_UNIT_RATES,
  }));
  const [rateDraft, setRateDraft] = useState<RateDraft>(() =>
    ratesToDraft(DEFAULT_PRICING_UNIT_RATES),
  );
  const [appliedRateDraft, setAppliedRateDraft] = useState<RateDraft>(() =>
    ratesToDraft(DEFAULT_PRICING_UNIT_RATES),
  );
  const [rateErrors, setRateErrors] = useState<RateErrors>({});

  useEffect(() => {
    const dialog = budgetPreview.current;
    if (!dialog) return;
    const closeOnBackdrop = (event: MouseEvent) => {
      if (event.target === dialog) dialog.close();
    };
    dialog.addEventListener("click", closeOnBackdrop);
    return () => dialog.removeEventListener("click", closeOnBackdrop);
  }, []);

  useEffect(() => {
    const dialog = rateCardDialog.current;
    if (!dialog) return;
    const closeOnBackdrop = (event: MouseEvent) => {
      if (event.target === dialog) dialog.close();
    };
    dialog.addEventListener("click", closeOnBackdrop);
    return () => dialog.removeEventListener("click", closeOnBackdrop);
  }, []);

  useEffect(() => {
    if (manualDraft.extract.mode !== "off") lastExtractMode.current = manualDraft.extract.mode;
    if (manualDraft.split.mode !== "off") lastSplitMode.current = manualDraft.split.mode;
  }, [manualDraft.extract.mode, manualDraft.split.mode]);

  const hasSpreadsheet = documents.some((document) => isSpreadsheetName(document.name));
  const documentTotalPages = documents.reduce(
    (total, document) =>
      isSpreadsheetName(document.name) ? total : total + document.pages,
    0,
  );
  const spreadsheetDocumentCount = documents.filter((document) =>
    isSpreadsheetName(document.name),
  ).length;
  const spreadsheetCellsEstimated = documents.reduce((total, document) => {
    if (!isSpreadsheetName(document.name)) return total;
    const rawCells = document.estimatedNonEmptyCells.trim();
    if (!/^\d+$/.test(rawCells)) return total;
    const cells = Number(rawCells);
    return Number.isSafeInteger(cells) ? total + cells : total;
  }, 0);
  const spreadsheetDocumentsMissingCellCount = documents.filter(
    (document) =>
      isSpreadsheetName(document.name) &&
      document.estimatedNonEmptyCells.trim() === "",
  ).length;
  const requestDocumentsResult = useMemo(() => {
    try {
      return {
        documents: documents.map(toPublicEstimateDocument),
        error: "",
      };
    } catch (error) {
      return {
        documents: null,
        error: error instanceof Error ? error.message : "Check the document metadata.",
      };
    }
  }, [documents]);
  const hasDownstreamEndpoint =
    manualDraft.extract.mode !== "off" || manualDraft.split.mode !== "off";
  const parseIncludedDownstream =
    manualDraft.parse.includedDownstream && hasDownstreamEndpoint;
  const codeImport = useMemo(() => importReductoCode(reductoCode), [reductoCode]);
  const codeImportSummary = useMemo(() => importSummary(codeImport), [codeImport]);
  const isCustomRateCard = useMemo(
    () => !sameRates(appliedRates, DEFAULT_PRICING_UNIT_RATES),
    [appliedRates],
  );
  const usedPricing = useMemo(() => {
    const rates = new Set<RateFieldKey>();
    const rules = new Set<FixedRuleKey>();
    if (pipelineDraftState !== "applied") return { rates, rules };

    const standaloneParse = pipeline.parse != null && pipeline.extract == null && pipeline.split == null;
    if (standaloneParse && documentTotalPages > 0) {
      const parseModel = pipeline.parse?.settings?.model === "r-1" ? "r-1" : "legacy";
      if (parseModel === "r-1") {
        rates.add("parseR1");
      } else {
        rates.add("parseStandard");
        rates.add("parseComplex");
        const agenticModes = pipeline.parse?.enhance?.agentic ?? [];
        if (agenticModes.length > 0) rules.add("agentic");
      }
      const agenticModes = pipeline.parse?.enhance?.agentic ?? [];
      if (pipeline.parse?.settings?.return_ocr_data) rates.add("ocrDataReturn");
      if (
        agenticModes.some((mode) => typeof mode.prompt === "string") ||
        pipeline.lumos_assumptions?.prompted_blocks_or_custom_regions?.parse
      ) rates.add("promptedBlocks");
      if (agenticModes.some((mode) => mode.advanced_chart_agent === true)) {
        rates.add("advancedChart");
      }
      if (pipeline.parse?.queue_priority === "batch") rules.add("batch");
    }
    if (pipeline.classify != null && documentTotalPages > 0) rates.add("classify");
    if (pipeline.extract != null && documentTotalPages > 0) {
      if (pipeline.lumos_assumptions?.conditional_extract_routing) {
        rates.add("extract");
        rates.add("deepExtract");
      } else if (pipeline.extract.settings?.deep_extract) {
        rates.add("deepExtract");
      } else {
        rates.add("extract");
      }
      if (pipeline.extract.settings?.optimize_for_latency) rules.add("latency");
      if (appliedProcessingContext?.extract_input !== "jobid") {
        const modes = pipeline.extract.parsing?.enhance?.agentic ?? [];
        if (pipeline.extract.parsing?.settings?.return_ocr_data) rates.add("ocrDataReturn");
        if (
          modes.some((mode) => typeof mode.prompt === "string") ||
          pipeline.lumos_assumptions?.prompted_blocks_or_custom_regions?.extract
        ) rates.add("promptedBlocks");
        if (modes.some((mode) => mode.advanced_chart_agent === true)) {
          rates.add("advancedChart");
        }
      }
    }
    if (pipeline.split != null && documentTotalPages > 0) {
      rates.add(pipeline.split.settings?.deep_split ? "deepSplit" : "split");
      if (appliedProcessingContext?.split_input !== "jobid") {
        const modes = pipeline.split.parsing?.enhance?.agentic ?? [];
        if (pipeline.split.parsing?.settings?.return_ocr_data) rates.add("ocrDataReturn");
        if (
          modes.some((mode) => typeof mode.prompt === "string") ||
          pipeline.lumos_assumptions?.prompted_blocks_or_custom_regions?.split
        ) rates.add("promptedBlocks");
        if (modes.some((mode) => mode.advanced_chart_agent === true)) {
          rates.add("advancedChart");
        }
      }
    }
    if (pipeline.edit != null && documentTotalPages > 0) {
      rates.add("edit");
      if ((pipeline.lumos_assumptions?.known_fully_prefilled_edit_pages ?? 0) > 0) {
        rates.add("editPrefilled");
      }
    }
    if (
      hasSpreadsheet &&
      (standaloneParse || pipeline.extract != null)
    ) {
      rates.add("spreadsheetCredit");
    }
    return { rates, rules };
  }, [
    appliedProcessingContext,
    documentTotalPages,
    hasSpreadsheet,
    pipeline,
    pipelineDraftState,
  ]);

  const estimateResult = useMemo(() => {
    if (requestDocumentsResult.error) {
      return { estimate: null, error: requestDocumentsResult.error };
    }
    if (
      !documents.length ||
      !requestDocumentsResult.documents ||
      pipelineDraftState !== "applied"
    ) {
      return { estimate: null, error: "" };
    }
    try {
      const normalized = normalizeRequest({
        documents: requestDocumentsResult.documents,
        pipeline,
        policy: { max_total_usd: budget },
        ...(appliedProcessingContext
          ? { processing_context: appliedProcessingContext }
          : {}),
      });
      return { estimate: estimatePipeline(normalized, appliedRates), error: "" };
    } catch (error) {
      return {
        estimate: null,
        error: error instanceof Error ? error.message : "The estimate inputs are invalid.",
      };
    }
  }, [
    appliedProcessingContext,
    documents,
    pipeline,
    budget,
    requestDocumentsResult,
    pipelineDraftState,
    appliedRates,
  ]);
  const estimate = estimateResult.estimate;

  const publicEstimateResult = useMemo(() => {
    if (requestDocumentsResult.error) {
      return { estimate: null, error: requestDocumentsResult.error };
    }
    if (
      !documents.length ||
      !requestDocumentsResult.documents ||
      pipelineDraftState !== "applied"
    ) {
      return { estimate: null, error: "" };
    }
    try {
      const normalized = normalizeRequest({
        documents: requestDocumentsResult.documents,
        pipeline,
        policy: { max_total_usd: budget },
        ...(appliedProcessingContext
          ? { processing_context: appliedProcessingContext }
          : {}),
      });
      return { estimate: estimatePipeline(normalized), error: "" };
    } catch (error) {
      return {
        estimate: null,
        error: error instanceof Error ? error.message : "The estimate inputs are invalid.",
      };
    }
  }, [
    appliedProcessingContext,
    documents,
    pipeline,
    budget,
    requestDocumentsResult,
    pipelineDraftState,
  ]);
  const apiEstimate = isCustomRateCard ? publicEstimateResult.estimate : estimate;
  const hasEstimateRange = estimate != null && estimate.low !== estimate.high;
  const configuredMode =
    pipelineDraftState === "applied"
      ? simulatorModeLabel(pipeline)
      : "Awaiting pipeline config";

  const apiRequest = useMemo(
    () =>
      pipelineDraftState === "applied"
        && requestDocumentsResult.documents
        ? {
            documents: requestDocumentsResult.documents,
            pipeline,
            policy: { max_total_usd: budget },
            ...(appliedProcessingContext
              ? { processing_context: appliedProcessingContext }
              : {}),
          }
        : null,
    [
      appliedProcessingContext,
      requestDocumentsResult.documents,
      pipeline,
      budget,
      pipelineDraftState,
    ],
  );

  const apiResponse = useMemo(() => {
    if (pipelineDraftState !== "applied") {
      return { error: "Apply the pipeline changes before requesting an estimate." };
    }
    if (!apiEstimate) {
      return estimateResult.error
        ? { error: estimateResult.error }
        : { decision: "awaiting_documents", estimate: null };
    }
    const hasSpreadsheets = apiEstimate.spreadsheetDocuments > 0;
    const usd = (value: number) => Number(value.toFixed(hasSpreadsheets ? 6 : 4));
    return {
            decision: apiEstimate.decision,
            estimate: {
              low_usd: usd(apiEstimate.low),
              likely_usd: usd(apiEstimate.likely),
              high_usd: usd(apiEstimate.high),
              currency: "USD",
            },
            breakdown: {
              parse_low_usd: usd(apiEstimate.parseLow),
              parse_likely_usd: usd(apiEstimate.parseLikely),
              parse_high_usd: usd(apiEstimate.parseHigh),
              classify_usd: usd(apiEstimate.classifyCost),
              extract_low_usd: usd(apiEstimate.extractLow),
              extract_likely_usd: usd(apiEstimate.extractLikely),
              extract_high_usd: usd(apiEstimate.extractHigh),
              split_usd: usd(apiEstimate.splitCost),
              split_low_usd: usd(apiEstimate.splitLow),
              split_likely_usd: usd(apiEstimate.splitLikely),
              split_high_usd: usd(apiEstimate.splitHigh),
              edit_usd: usd(apiEstimate.editCost),
              ...(hasSpreadsheets
                ? { spreadsheet_usd: usd(apiEstimate.spreadsheetCost) }
                : {}),
              parsing_add_ons: apiEstimate.parsingAddOns,
            },
            usage: {
              documents: documents.length,
              pages: apiEstimate.totalPages,
              parse_pages_priced: apiEstimate.parsePages,
              parse_cost_multiplier: apiEstimate.parseCostMultiplier,
              parse_batch_discount: apiEstimate.parseBatchDiscount,
              classify_pages_priced: apiEstimate.classifyPages,
              extract_pages_priced: apiEstimate.extractPages,
              split_pages_priced: apiEstimate.splitPages,
              extract_cost_multiplier: apiEstimate.extractCostMultiplier,
              ocr_pages: {
                parse: apiEstimate.parsingAddOns.parse.ocr_pages,
                extract: apiEstimate.parsingAddOns.extract.ocr_pages,
                split: apiEstimate.parsingAddOns.split.ocr_pages,
              },
              prompted_pages: {
                parse: apiEstimate.parsingAddOns.parse.prompted_pages,
                extract: apiEstimate.parsingAddOns.extract.prompted_pages,
                split: apiEstimate.parsingAddOns.split.prompted_pages,
              },
              charts: {
                parse: apiEstimate.parsingAddOns.parse.charts,
                extract: apiEstimate.parsingAddOns.extract.charts,
                split: apiEstimate.parsingAddOns.split.charts,
              },
              ...(hasSpreadsheets
                ? {
                    spreadsheets: {
                      documents: apiEstimate.spreadsheetDocuments,
                      estimated_non_empty_cells:
                        apiEstimate.spreadsheetCellsEstimated,
                      documents_missing_cell_count:
                        apiEstimate.spreadsheetDocumentsMissingCellCount,
                      credits: apiEstimate.spreadsheetCredits,
                      clustering: apiEstimate.spreadsheetClustering,
                      max_cell_count: apiEstimate.spreadsheetMaxCellCount,
                      base_endpoint: apiEstimate.spreadsheetBaseEndpoint,
                    },
                  }
                : {}),
            },
            assumptions_used: {
              ...(apiEstimate.parseMode === "standalone" &&
              apiEstimate.parseModel === "legacy" &&
              apiEstimate.parsePages > 0
                ? { likely_complex_parse_share: apiEstimate.parseLikelyComplexShare }
                : {}),
              ...(apiEstimate.parseAdvancedChartCounts && apiEstimate.parsePages > 0
                ? {
                    advanced_chart_counts: {
                      likely: apiEstimate.parseAdvancedChartCounts.likely,
                      maximum: apiEstimate.parseAdvancedChartCounts.high,
                    },
                  }
                : {}),
              ...(pipeline.lumos_assumptions?.conditional_extract_routing &&
              apiEstimate.extractPages > 0
                ? {
                    likely_deep_extract_share:
                      pipeline.lumos_assumptions.likely_deep_extract_share ?? 0.25,
                  }
                : {}),
            },
            rate_card: apiEstimate.parseModel === "r-1" ? R1_RATE_CARD : RATE_CARD,
            ...(hasSpreadsheets
              ? {
                  spreadsheet_rate_basis: {
                    usd_per_credit: DEFAULT_PRICING_UNIT_RATES.spreadsheetCredit,
                    basis: "lumos_default",
                    note: "Consult your Reducto rate card.",
                  },
                }
              : {}),
            has_range: apiEstimate.low !== apiEstimate.high,
            estimate_complete: apiEstimate.estimateComplete,
            unpriced_cost_factors: apiEstimate.unpricedCostFactors,
          };
  }, [apiEstimate, documents.length, estimateResult.error, pipeline, pipelineDraftState]);

  const includedAddOnBreakdown = estimate
    ? (["parse", "extract", "split"] as const).flatMap((endpoint) => {
        const label = endpoint.charAt(0).toUpperCase() + endpoint.slice(1);
        const addOns = estimate.parsingAddOns[endpoint];
        return [
          addOns.ocr_pages > 0 ? `${label} OCR ${money(addOns.ocr_usd)}` : null,
          addOns.prompted_pages > 0
            ? `${label} prompted processing ${money(addOns.prompted_usd)}`
            : null,
          addOns.charts.high > 0
            ? `${label} charts ${
                addOns.chart_likely_usd === addOns.chart_high_usd
                  ? money(addOns.chart_likely_usd)
                  : `${money(addOns.chart_likely_usd)}–${money(addOns.chart_high_usd)}`
              }`
            : null,
        ].filter((item): item is string => item !== null);
      })
    : [];
  const estimateBreakdown = estimate
    ? [
        estimate.parseMode === "standalone" && estimate.parsePages > 0
          ? `${estimate.parseModel === "r-1" ? "r‑1 Parse" : "Legacy Parse"} ${
              estimate.parseLow === estimate.parseHigh
                ? money(estimate.parseLikely)
                : `${money(estimate.parseLow)}–${money(estimate.parseHigh)}`
            } across ${estimate.parsePages} priced pages`
          : null,
        pipeline.classify != null && estimate.classifyPages > 0
          ? `Classify ${money(estimate.classifyCost)}`
          : null,
        pipeline.extract != null && estimate.extractPages > 0
          ? `Extract ${
              estimate.extractLow === estimate.extractHigh
                ? money(estimate.extractLikely)
                : `${money(estimate.extractLow)}–${money(estimate.extractHigh)}`
            } across ${estimate.extractPages} priced pages`
          : null,
        pipeline.split != null && estimate.splitPages > 0
          ? `Split ${
              estimate.splitLow === estimate.splitHigh
                ? money(estimate.splitLikely)
                : `${money(estimate.splitLow)}–${money(estimate.splitHigh)}`
            } across ${estimate.splitPages} priced pages`
          : null,
        pipeline.edit != null && estimate.totalPages > 0
          ? `Edit ${money(estimate.editCost)}`
          : null,
        estimate.spreadsheetDocuments > 0 && estimate.spreadsheetBaseEndpoint
          ? `Spreadsheet ${money(estimate.spreadsheetCost)} for ${estimate.spreadsheetCellsEstimated.toLocaleString()} estimated non-empty cells (${estimate.spreadsheetCredits.toLocaleString()} credits, ${estimate.spreadsheetClustering})`
          : null,
        includedAddOnBreakdown.length > 0
          ? `Add-ons included above: ${includedAddOnBreakdown.join("; ")}`
          : null,
      ].filter((item): item is string => item !== null)
    : [];
  const parsingNote =
    pipeline.extract != null && pipeline.split != null
      ? "Parsing is included in the Extract and Split prices."
      : pipeline.extract != null
        ? "Parsing is included in the Extract price."
        : pipeline.split != null
          ? "Parsing is included in the Split price."
          : "";

  async function addFiles(files: FileList | File[]) {
    const inspected = await Promise.all(Array.from(files).slice(0, 50).map(inspectFile));
    setDocuments((current) => [...current, ...inspected]);
    setLiveResult(null);
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files) void addFiles(event.target.files);
    event.target.value = "";
  }

  function updateManualDraft(
    update: (current: ManualPipelineDraft) => ManualPipelineDraft,
  ) {
    setManualDraft((current) => update(current));
    setManualErrors({});
    setPipelineError("");
    setPipelineDraftState("dirty");
    setImportApplied(false);
    setProfileCopyState("idle");
  }

  function selectManualEndpoint(endpoint: ManualEndpoint, focusTab = false) {
    setManualEndpointTab(endpoint);
    if (endpointPanelScroll.current) endpointPanelScroll.current.scrollTop = 0;
    if (focusTab) {
      requestAnimationFrame(() => endpointTabRefs.current[endpoint]?.focus());
    }
  }

  function focusManualEndpointError(endpoint: ManualEndpoint) {
    setManualEndpointTab(endpoint);
    if (endpointPanelScroll.current) endpointPanelScroll.current.scrollTop = 0;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const panel = document.getElementById(`${endpoint}-endpoint-panel`);
        const invalidField = panel?.querySelector<HTMLElement>('[aria-invalid="true"]');
        (invalidField ?? endpointTabRefs.current[endpoint] ?? manualErrorSummary.current)?.focus();
      });
    });
  }

  function handleEndpointTabKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    endpoint: ManualEndpoint,
  ) {
    const currentIndex = MANUAL_ENDPOINTS.indexOf(endpoint);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % MANUAL_ENDPOINTS.length;
    if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + MANUAL_ENDPOINTS.length) % MANUAL_ENDPOINTS.length;
    }
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = MANUAL_ENDPOINTS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    selectManualEndpoint(MANUAL_ENDPOINTS[nextIndex], true);
  }

  function handlePipelineInputTabKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    tab: PipelineInputTab,
  ) {
    let nextTab: PipelineInputTab | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      nextTab = tab === "profile" ? "code" : "profile";
    }
    if (event.key === "Home") nextTab = "profile";
    if (event.key === "End") nextTab = "code";
    if (nextTab === null) return;
    event.preventDefault();
    setPipelineInputTab(nextTab);
    requestAnimationFrame(() => document.getElementById(`${nextTab}-tab`)?.focus());
  }

  function applyPipeline() {
    const result = manualDraftToPipeline(
      manualDraft,
      documents.length > 0 ? documentTotalPages : undefined,
    );
    if (!result.ok) {
      setManualErrors(result.errors);
      setPipelineError("");
      setPipelineDraftState("invalid");
      const firstInvalidEndpoint = manualErrorEndpoint(Object.keys(result.errors)[0] ?? "");
      if (firstInvalidEndpoint) {
        focusManualEndpointError(firstInvalidEndpoint);
      } else {
        requestAnimationFrame(() => manualErrorSummary.current?.focus());
      }
      return;
    }
    const processingContext = manualDraftProcessingContext(manualDraft);

    try {
      if (documents.length > 0 && !requestDocumentsResult.documents) {
        throw new Error(requestDocumentsResult.error);
      }
      const normalized = normalizeRequest({
        documents: documents.length > 0 && requestDocumentsResult.documents
          ? requestDocumentsResult.documents
          : [{ name: "validation.pdf", pages: 1_000_000 }],
        pipeline: result.pipeline,
        ...(processingContext ? { processing_context: processingContext } : {}),
      });
      estimatePipeline(normalized, appliedRates);
    } catch (error) {
      const setupMessage = manualSetupError(error);
      let invalidEndpoint = manualSetupErrorEndpoint(error);
      let errorField = invalidEndpoint === "classify"
        ? "classify.start"
        : invalidEndpoint === "parse" || invalidEndpoint === "extract" || invalidEndpoint === "split"
          ? `${invalidEndpoint}.pageSelection`
          : "setup";
      if (setupMessage.includes("spreadsheet.max_cell_count")) {
        const spreadsheetEndpoint =
          result.pipeline.parse != null &&
          result.pipeline.extract == null &&
          result.pipeline.split == null
            ? "parse"
            : result.pipeline.extract != null
              ? "extract"
              : null;
        if (spreadsheetEndpoint) {
          invalidEndpoint = spreadsheetEndpoint;
          errorField = `${spreadsheetEndpoint}.spreadsheet.maxCellCount`;
        }
      }
      setManualErrors({ [errorField]: setupMessage });
      setPipelineError("");
      setPipelineDraftState("invalid");
      if (invalidEndpoint) {
        focusManualEndpointError(invalidEndpoint);
      } else {
        requestAnimationFrame(() => manualErrorSummary.current?.focus());
      }
      return;
    }

    setPipeline(result.pipeline);
    setAppliedProcessingContext(processingContext);
    const preservedUnpricedCostFactors =
      result.pipeline.lumos_assumptions?.unpriced_cost_factors ?? [];
    setManualDraft((current) => ({
      ...current,
      assumptions: {
        ...current.assumptions,
        unpricedCostFactors: [...preservedUnpricedCostFactors],
      },
    }));
    setManualErrors({});
    setPipelineError("");
    setPipelineDraftState("applied");
    setImportApplied(false);
    setProfileCopyState("idle");
  }

  function applyImportedPipeline() {
    if (!codeImport.applicable || !codeImport.pipeline) {
      setPipelineError(
        codeImport.error ?? "Lumos could not create estimate settings from this Reducto JSON.",
      );
      setPipelineDraftState("invalid");
      return;
    }

    try {
      if (documents.length > 0 && !requestDocumentsResult.documents) {
        throw new Error(requestDocumentsResult.error);
      }
      const normalized = normalizeRequest({
        documents: documents.length > 0 && requestDocumentsResult.documents
          ? requestDocumentsResult.documents
          : [{ name: "validation.pdf", pages: 1_000_000 }],
        pipeline: codeImport.pipeline,
      });
      estimatePipeline(normalized, appliedRates);
      const hydratedDraft = cloneManualDraft(
        pipelineToManualDraft(codeImport.pipeline, codeImport.configurations),
      );
      setPipeline(codeImport.pipeline);
      setAppliedProcessingContext(undefined);
      setManualDraft(hydratedDraft);
      setManualEndpointTab(firstEnabledEndpoint(hydratedDraft));
      setManualErrors({});
      setPipelineError("");
      setPipelineDraftState("applied");
      setImportApplied(true);
      setProfileCopyState("idle");
    } catch (error) {
      setPipelineError(error instanceof Error ? error.message : "The imported pipeline is invalid.");
      setPipelineDraftState("invalid");
      setImportApplied(false);
    }
  }

  function updateDocument(id: string, patch: Partial<DocumentRow>) {
    setDocuments((current) =>
      current.map((document) => (document.id === id ? { ...document, ...patch } : document)),
    );
  }

  function openRateCard() {
    setRateDraft({ ...appliedRateDraft });
    setRateErrors({});
    if (rateCardBody.current) rateCardBody.current.scrollTop = 0;
    const dialog = rateCardDialog.current;
    if (dialog && typeof dialog.showModal === "function" && !dialog.open) {
      dialog.showModal();
    }
  }

  function applyRateCard() {
    const validation = validateRateDraft(rateDraft);
    if (Object.keys(validation.errors).length > 0) {
      setRateErrors(validation.errors);
      const firstInvalidKey = RATE_FIELD_KEYS.find((key) => validation.errors[key]);
      if (firstInvalidKey) {
        requestAnimationFrame(() => rateInputRefs.current[firstInvalidKey]?.focus());
      }
      return;
    }

    const normalizedDraft = Object.fromEntries(
      RATE_FIELD_KEYS.map((key) => [key, rateDraft[key].trim()]),
    ) as RateDraft;
    setAppliedRates({ ...validation.rates });
    setAppliedRateDraft(normalizedDraft);
    setRateDraft(normalizedDraft);
    setRateErrors({});
    rateCardDialog.current?.close();
  }

  async function copyLumosProfile() {
    if (pipelineDraftState !== "applied") return;
    try {
      await navigator.clipboard.writeText(serializeLumosProfile(pipeline));
      setProfileCopyState("copied");
    } catch {
      setProfileCopyState("error");
    }
  }

  async function runReducto() {
    const files = documents.flatMap((document) => (document.file ? [document.file] : []));
    setLiveError("");
    setLiveResult(null);

    if (!files.length) {
      setLiveError("Choose at least one uploaded file before starting a Reducto job.");
      return;
    }
    if (files.some((file) => isSpreadsheetName(file.name))) {
      setLiveError(
        "Spreadsheet verification is unavailable because Lumos does not upload workbook contents.",
      );
      return;
    }
    if (!apiKey.trim() || !pipelineId.trim() || !confirmed) {
      setLiveError("Add an API key and pipeline ID, then confirm that this starts paid work.");
      return;
    }

    const body = new FormData();
    files.forEach((file) => body.append("files", file));
    body.append("api_key", apiKey.trim());
    body.append("pipeline_id", pipelineId.trim());
    body.append("confirmed", "true");

    setLiveState("running");
    try {
      const response = await fetch(appPath("/api/reducto"), { method: "POST", body });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error || "Reducto returned an error.");
      setLiveResult(result);
      setApiKey("");
      setLiveState("done");
    } catch (error) {
      setLiveError(error instanceof Error ? error.message : "The verification ended before completion.");
      setLiveState("idle");
    }
  }

  function loadSimulatorExample() {
    const examplePipeline = structuredClone(SIMULATOR_EXAMPLE_REQUEST.pipeline);
    const exampleDraft = pipelineToManualDraft(examplePipeline);
    const defaultRateDraft = ratesToDraft(DEFAULT_PRICING_UNIT_RATES);

    if (rateCardDialog.current?.open) rateCardDialog.current.close();
    setDocuments(makeExampleDocuments());
    setPipeline(examplePipeline);
    setAppliedProcessingContext(undefined);
    setManualDraft(cloneManualDraft(exampleDraft));
    setManualErrors({});
    setPipelineDraftState("applied");
    setPipelineError("");
    setProfileCopyState("idle");
    setPipelineInputTab("profile");
    setManualEndpointTab(firstEnabledEndpoint(exampleDraft));
    setBudget(SIMULATOR_EXAMPLE_REQUEST.policy.max_total_usd);
    setReductoCode("");
    setImportApplied(false);
    setApiKey("");
    setPipelineId("");
    setConfirmed(false);
    setLiveResult(null);
    setLiveError("");
    setLiveState("idle");
    setAppliedRates({ ...DEFAULT_PRICING_UNIT_RATES });
    setAppliedRateDraft(defaultRateDraft);
    setRateDraft(defaultRateDraft);
    setRateErrors({});
  }

  function clearSession() {
    const dialog = rateCardDialog.current;
    if (dialog?.open) dialog.close();
    setDocuments([]);
    setPipeline(DEFAULT_PIPELINE);
    setAppliedProcessingContext(undefined);
    setManualDraft(cloneManualDraft(DEFAULT_MANUAL_PIPELINE_DRAFT));
    setManualErrors({});
    setPipelineDraftState("unconfigured");
    setPipelineError("");
    setProfileCopyState("idle");
    setPipelineInputTab("profile");
    setManualEndpointTab("extract");
    setApiKey("");
    setPipelineId("");
    setConfirmed(false);
    setLiveResult(null);
    setLiveError("");
    setLiveState("idle");
    setReductoCode("");
    setImportApplied(false);
    setAppliedRates({ ...DEFAULT_PRICING_UNIT_RATES });
    const defaultRateDraft = ratesToDraft(DEFAULT_PRICING_UNIT_RATES);
    setAppliedRateDraft(defaultRateDraft);
    setRateDraft(defaultRateDraft);
    setRateErrors({});
  }

  return (
    <main>
      <header>
        <h1>Lumos</h1>
        <p className="subtitle">Estimate Reducto costs before processing begins.</p>
        <nav aria-label="Page sections">
          <a href="#how-to-use">How to use</a>
          <a href="#simulator">Simulator</a>
          <a href="#api">API</a>
          <a href="#verify">Verify with Reducto</a>
        </nav>
      </header>

      <section id="problem">
        <h2>Problem</h2>
        <p>
          Reducto turns unstructured documents into structured, usable data. Before a job runs,
          its price can be difficult to predict because it depends on the amount of work, the
          endpoints and configurations used, and the applicable rate card.
        </p>
        <p>
          That makes a job difficult to budget before processing begins. For enterprises and
          startups, seeing an estimate earlier can inform their own pricing, {" "}
          <a
            ref={budgetPreviewLink}
            className="evidence-link"
            href={appPath("/waiver-redacted.png")}
            aria-haspopup="dialog"
            aria-controls="budget-example"
            aria-describedby="budget-evidence-note"
            onClick={(event) => {
              const dialog = budgetPreview.current;
              if (dialog && typeof dialog.showModal === "function") {
                event.preventDefault();
                if (!dialog.open) dialog.showModal();
              }
            }}
          >
            <strong>protect budgets</strong>
            <sup className="evidence-marker">1</sup>
          </a>{", and help teams use resources more efficiently and transparently."}
        </p>

        <p id="budget-evidence-note" className="evidence-footnote">
          <sup>1</sup> Actual screenshot from 2025 requesting a refund due to overusage.
        </p>

        <dialog
          id="budget-example"
          ref={budgetPreview}
          className="image-preview"
          aria-labelledby="budget-example-title"
          aria-describedby="budget-example-description"
          onClose={() => budgetPreviewLink.current?.focus()}
        >
          <div className="image-preview-header">
            <div>
              <h3 id="budget-example-title">Unexpected usage and waiver request</h3>
              <p id="budget-example-description">
                A real example of an unexpected test-usage spike and the resulting waiver request.
              </p>
            </div>
            <form method="dialog">
              <button type="submit" aria-label="Close image preview">
                Close
              </button>
            </form>
          </div>
          <div className="image-preview-body">
            <Image
              src={appPath("/waiver-redacted.png")}
              width={1040}
              height={1512}
              sizes="(max-width: 960px) calc(100vw - 56px), 880px"
              alt="An email requesting a waiver after test runs processed about 198,000 pages, followed by a response approving a credit for the overage. The phone number and invoice identifiers are redacted."
            />
          </div>
        </dialog>

        <h2>Solution</h2>
        <p>
          Lumos estimates the cost of a Reducto job before it runs by looking at the document, how
          it will be processed, and the applicable Reducto pricing.
        </p>
        <p>
          When the cost can be determined upfront, Lumos returns a single estimate. When part of the
          cost depends on what Reducto discovers during processing, or on a processing path that has
          not yet been chosen, Lumos returns a low, likely, and high estimate. If any part of the
          price cannot be calculated, Lumos still shows the known cost and clearly identifies what
          is excluded.
        </p>
        <p>
          Lumos does not run the Reducto pipeline to create an estimate, so no Reducto processing
          fee is incurred. In the simulator, document details are read locally in your browser.
          Through the API, your application can send the same information directly.
        </p>
        <p>
          With the estimate available before processing begins, teams can add an approve-or-stop
          check to their workflow, helping protect budgets and make costs more predictable for both
          the business and its users.
        </p>
        <figure className="solution-figure">
          <a href={appPath("/reducto-lumos.jpg")} aria-label="Open the Lumos workflow image at full size">
            <Image
              src={appPath("/reducto-lumos.jpg")}
              width={1569}
              height={747}
              loading="lazy"
              sizes="(max-width: 760px) calc(100vw - 36px), 760px"
              alt="Documents normally run through Reducto before their exact cost is known; Lumos adds a checkpoint before processing to inspect the documents, read the pipeline configuration, estimate the work and cost range, check policy, and approve or stop the job."
            />
          </a>
        </figure>
      </section>

      <section id="how-to-use">
        <h2>How to use</h2>
        <ul>
          <li><a href="#simulator"><strong>Simulator</strong></a> Upload documents and describe the pipeline here</li>
          <li><a href="#api"><strong>API</strong></a> Run the same estimate inside your own upload flow</li>
        </ul>
      </section>

      <section id="simulator">
        <h2>Simulator</h2>

        <h3>1. Documents</h3>
        <div className="button-row">
          <button type="button" onClick={() => fileInput.current?.click()}>Choose documents</button>
          <button type="button" className="text-button" onClick={loadSimulatorExample}>
            or try an example
          </button>
          {(documents.length > 0 || pipelineDraftState !== "unconfigured" || isCustomRateCard) && (
            <button type="button" className="text-button" onClick={clearSession}>Clear session</button>
          )}
        </div>
        <input
          ref={fileInput}
          className="hidden-input"
          type="file"
          multiple
          accept=".pdf,.png,.jpg,.jpeg,.gif,.heic,.bmp,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.xlsm,.xltx,.xltm,.csv,.qpw"
          onChange={onFileChange}
        />

        {documents.length === 0 ? (
          <p className="empty">Awaiting documents</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Document</th><th>Pages / estimated non-empty cells</th><th>Mode</th><th /></tr>
              </thead>
              <tbody>
                {documents.map((document) => {
                  const spreadsheet = isSpreadsheetName(document.name);
                  const rawCells = document.estimatedNonEmptyCells.trim();
                  const invalidCells =
                    spreadsheet &&
                    rawCells !== "" &&
                    (!/^\d+$/.test(rawCells) || !Number.isSafeInteger(Number(rawCells)));
                  const cellErrorId = `cell-count-error-${document.id}`;
                  return (
                  <tr key={document.id}>
                    <td>{document.name}<small>{document.note}</small></td>
                    <td>
                      {spreadsheet ? (
                        <>
                          <input
                            className="cell-count-input"
                            aria-label={`Estimated non-empty cells in ${document.name}`}
                            type="number"
                            min="0"
                            step="1"
                            inputMode="numeric"
                            placeholder="Non-empty cells"
                            value={document.estimatedNonEmptyCells}
                            aria-invalid={invalidCells ? "true" : undefined}
                            aria-describedby={invalidCells ? cellErrorId : undefined}
                            onChange={(event) =>
                              updateDocument(document.id, {
                                estimatedNonEmptyCells: event.target.value,
                              })
                            }
                          />
                          {invalidCells && (
                            <small id={cellErrorId} className="field-error">
                              Enter a whole number of 0 or greater.
                            </small>
                          )}
                        </>
                      ) : (
                        <input
                          aria-label={`Pages in ${document.name}`}
                          type="number"
                          min="1"
                          value={document.pages}
                          onChange={(event) =>
                            updateDocument(document.id, {
                              pages: Math.max(1, Number(event.target.value)),
                            })
                          }
                        />
                      )}
                    </td>
                    <td>
                      <span>{configuredMode}</span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="remove-button"
                        aria-label={`Remove ${document.name}`}
                        onClick={() => setDocuments((current) => current.filter((item) => item.id !== document.id))}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <h3>2. Pipeline configuration</h3>
        <p className="aside">
          Use Reducto-style settings to build the estimate configuration, or import the JSON from
          your Reducto pipeline.
        </p>
        <p className="document-total" aria-live="polite">
          <strong>Uploaded</strong>{" "}
          {documents.length > 0
            ? `${documents.length} document${documents.length === 1 ? "" : "s"}, ${documentTotalPages} page${documentTotalPages === 1 ? "" : "s"}${spreadsheetDocumentCount > 0 ? `, ${spreadsheetCellsEstimated.toLocaleString()} estimated non-empty cells${spreadsheetDocumentsMissingCellCount > 0 ? ` (${spreadsheetDocumentsMissingCellCount} count${spreadsheetDocumentsMissingCellCount === 1 ? "" : "s"} missing)` : ""}` : ""}`
            : "No documents yet"}
        </p>
        <div className="pipeline-tabs" role="tablist" aria-label="Pipeline configuration input">
          <button
            type="button"
            role="tab"
            id="profile-tab"
            aria-controls="profile-panel"
            aria-selected={pipelineInputTab === "profile"}
            tabIndex={pipelineInputTab === "profile" ? 0 : -1}
            className={pipelineInputTab === "profile" ? "pipeline-tab active" : "pipeline-tab"}
            onClick={() => setPipelineInputTab("profile")}
            onKeyDown={(event) => handlePipelineInputTabKeyDown(event, "profile")}
          >
            Set up manually
          </button>
          <button
            type="button"
            role="tab"
            id="code-tab"
            aria-controls="code-panel"
            aria-selected={pipelineInputTab === "code"}
            tabIndex={pipelineInputTab === "code" ? 0 : -1}
            className={pipelineInputTab === "code" ? "pipeline-tab active" : "pipeline-tab"}
            onClick={() => setPipelineInputTab("code")}
            onKeyDown={(event) => handlePipelineInputTabKeyDown(event, "code")}
          >
            Import from Reducto
          </button>
        </div>

        {pipelineInputTab === "profile" ? (
          <div role="tabpanel" id="profile-panel" aria-labelledby="profile-tab">
            <p className="aside">
              Standard Extract is selected as an example. Apply the configuration to use it.
            </p>
            <div className="pipeline-configurator">
              <div
                className="endpoint-tabs"
                role="tablist"
                aria-label="Reducto endpoints"
                aria-orientation="horizontal"
              >
                {MANUAL_ENDPOINTS.map((endpoint) => {
                  const enabled = manualEndpointEnabled(manualDraft, endpoint);
                  const included = endpoint === "parse" && parseIncludedDownstream;
                  return (
                    <button
                      key={endpoint}
                      ref={(element) => { endpointTabRefs.current[endpoint] = element; }}
                      type="button"
                      role="tab"
                      id={`${endpoint}-endpoint-tab`}
                      aria-controls={`${endpoint}-endpoint-panel`}
                      aria-selected={manualEndpointTab === endpoint}
                      tabIndex={manualEndpointTab === endpoint ? 0 : -1}
                      className={manualEndpointTab === endpoint ? "endpoint-tab active" : "endpoint-tab"}
                      onClick={() => selectManualEndpoint(endpoint)}
                      onKeyDown={(event) => handleEndpointTabKeyDown(event, endpoint)}
                    >
                      <span>{MANUAL_ENDPOINT_LABELS[endpoint]}</span>
                      <small className={enabled || included ? "endpoint-tab-status on" : "endpoint-tab-status"}>
                        {included ? "Included" : enabled ? "On" : "Off"}
                      </small>
                    </button>
                  );
                })}
              </div>
              <div ref={endpointPanelScroll} className="endpoint-panel-scroll">
                {Object.keys(manualErrors).length > 0 && (
                  <div
                    ref={manualErrorSummary}
                    className="builder-error-summary"
                    role="alert"
                    tabIndex={-1}
                  >
                    <strong>Review the highlighted setup fields.</strong>
                    <ul>
                      {[...new Set(Object.values(manualErrors))].map((error) => (
                        <li key={error}>{error}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {manualEndpointTab === "parse" && (
                  <section
                    className="endpoint-panel"
                    role="tabpanel"
                    id="parse-endpoint-panel"
                    aria-labelledby="parse-endpoint-tab"
                  >
                    <header className="endpoint-panel-heading">
                      <div>
                        <h4>Parse (standalone)</h4>
                        <p>Price a direct Parse job separately from Extract or Split.</p>
                      </div>
                      <label className="endpoint-switch">
                        <span>{manualDraft.parse.enabled ? "On" : "Off"}</span>
                        <input
                          type="checkbox"
                          aria-label="Enable standalone Parse endpoint"
                          aria-describedby={hasDownstreamEndpoint ? "standalone-parse-availability" : undefined}
                          checked={manualDraft.parse.enabled}
                          disabled={hasDownstreamEndpoint}
                          onChange={(event) =>
                            updateManualDraft((current) => ({
                              ...current,
                              parse: {
                                ...current.parse,
                                enabled: event.target.checked,
                                includedDownstream: event.target.checked
                                  ? false
                                  : current.parse.includedDownstream,
                              },
                            }))
                          }
                        />
                      </label>
                    </header>

                    {parseIncludedDownstream ? (
                      <p id="standalone-parse-availability" className="builder-note">
                        Imported Parse settings are preserved and included in Extract or Split
                        pricing. They do not create a standalone Parse charge.
                      </p>
                    ) : !manualDraft.parse.enabled ? (
                      <p id="standalone-parse-availability" className="endpoint-empty">
                        {hasDownstreamEndpoint
                          ? "Parsing is already included in Extract or Split. Turn those endpoints off to configure a separately priced Parse job."
                          : "Turn on standalone Parse to configure a separately priced Parse job."}
                      </p>
                    ) : (
                      <>
                        <div className="config-group">
                          <fieldset className="builder-section compact-builder-section">
                            <legend>Pricing model</legend>
                            <div className="choice-row parse-model-options">
                              <label>
                                <input
                                  type="radio"
                                  name="parse-pricing-model"
                                  checked={manualDraft.parse.pricingModel === "legacy"}
                                  onChange={() =>
                                    updateManualDraft((current) => ({
                                      ...current,
                                      parse: { ...current.parse, pricingModel: "legacy" },
                                    }))
                                  }
                                />
                                Legacy
                              </label>
                              <span className="r1-model-option">
                                <label>
                                  <input
                                    type="radio"
                                    name="parse-pricing-model"
                                    checked={manualDraft.parse.pricingModel === "r-1"}
                                    onChange={() =>
                                      updateManualDraft((current) => ({
                                        ...current,
                                        parse: {
                                          ...current.parse,
                                          pricingModel: "r-1",
                                          mode: "standard",
                                        },
                                      }))
                                    }
                                  />
                                  r‑1 (Beta)
                                </label>
                                <a
                                  className="new-badge"
                                  href="https://reducto.ai/blog/parse-r-1-model"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  aria-label="New: read Reducto's r-1 model announcement"
                                >
                                  New
                                </a>
                              </span>
                            </div>
                            {manualDraft.parse.pricingModel === "r-1" && (
                              <p className="parse-model-note">
                                Base pricing is $10 per 1,000 pages. Optional parsing add-ons are
                                priced separately below.
                              </p>
                            )}
                          </fieldset>

                          {manualDraft.parse.pricingModel === "legacy" && (
                            <fieldset className="builder-section compact-builder-section">
                              <legend>Agentic</legend>
                            <label className="check-field">
                              <input
                                type="checkbox"
                                checked={manualDraft.parse.mode === "agentic"}
                                onChange={(event) =>
                                  updateManualDraft((current) => {
                                    const hasScope = Object.values(current.parse.agenticScopes).some(Boolean);
                                    return {
                                      ...current,
                                      parse: {
                                        ...current.parse,
                                        mode: event.target.checked ? "agentic" : "standard",
                                        agenticScopes:
                                          event.target.checked && !hasScope
                                            ? { ...current.parse.agenticScopes, text: true }
                                            : current.parse.agenticScopes,
                                        advancedChart: event.target.checked
                                          ? current.parse.advancedChart
                                          : false,
                                      },
                                    };
                                  })
                                }
                              />
                              Use vision language models to enhance extraction accuracy
                            </label>
                            {manualDraft.parse.mode === "agentic" && (
                              <div className="nested-settings">
                                <div className="check-grid" aria-label="Agentic scopes">
                                  {(["figure", "table", "text"] as const).map((scope) => (
                                    <label className="check-field" key={scope}>
                                      <input
                                        type="checkbox"
                                        checked={manualDraft.parse.agenticScopes[scope]}
                                        aria-invalid={manualErrors["parse.agenticScopes"] ? "true" : undefined}
                                        onChange={(event) =>
                                          updateManualDraft((current) => ({
                                            ...current,
                                            parse: {
                                              ...current.parse,
                                              agenticScopes: {
                                                ...current.parse.agenticScopes,
                                                [scope]: event.target.checked,
                                              },
                                              advancedChart:
                                                scope === "figure" && !event.target.checked
                                                  ? false
                                                  : current.parse.advancedChart,
                                            },
                                          }))
                                        }
                                      />
                                      {scope.charAt(0).toUpperCase() + scope.slice(1)}
                                    </label>
                                  ))}
                                </div>
                                {manualErrors["parse.agenticScopes"] && (
                                  <p className="field-error">{manualErrors["parse.agenticScopes"]}</p>
                                )}
                                <label className="check-field nested-option">
                                  <input
                                    type="checkbox"
                                    checked={manualDraft.parse.advancedChart}
                                    onChange={(event) =>
                                      updateManualDraft((current) => ({
                                        ...current,
                                        parse: {
                                          ...current.parse,
                                          mode: event.target.checked ? "agentic" : current.parse.mode,
                                          agenticScopes: event.target.checked
                                            ? { ...current.parse.agenticScopes, figure: true }
                                            : current.parse.agenticScopes,
                                          advancedChart: event.target.checked,
                                        },
                                      }))
                                    }
                                  />
                                  Advanced Chart Agent
                                </label>
                              </div>
                            )}
                            </fieldset>
                          )}

                          <fieldset className="builder-section compact-builder-section">
                            <legend>Queue Priority</legend>
                            <div className="choice-row">
                              <label>
                                <input
                                  type="radio"
                                  name="parse-queue-priority"
                                  checked={!manualDraft.parse.batch}
                                  onChange={() =>
                                    updateManualDraft((current) => ({
                                      ...current,
                                      parse: { ...current.parse, batch: false },
                                    }))
                                  }
                                />
                                Auto
                              </label>
                              <label>
                                <input
                                  type="radio"
                                  name="parse-queue-priority"
                                  checked={manualDraft.parse.batch}
                                  onChange={() =>
                                    updateManualDraft((current) => ({
                                      ...current,
                                      parse: { ...current.parse, batch: true },
                                    }))
                                  }
                                />
                                Batch <small>20% discount</small>
                              </label>
                            </div>
                          </fieldset>

                          <PageSelectionEditor
                            id="parse-pages"
                            legend="Page Range"
                            selection={manualDraft.parse.pageSelection}
                            errors={manualErrors}
                            errorField="parse.pageSelection"
                            onChange={(pageSelection) =>
                              updateManualDraft((current) => ({
                                ...current,
                                parse: { ...current.parse, pageSelection },
                              }))
                            }
                          />
                          {(hasSpreadsheet || manualDraft.parse.spreadsheet.configured) && (
                            <SpreadsheetSettings
                              endpoint="parse"
                              value={manualDraft.parse.spreadsheet}
                              errors={manualErrors}
                              onChange={(spreadsheet) =>
                                updateManualDraft((current) => ({
                                  ...current,
                                  parse: { ...current.parse, spreadsheet },
                                }))
                              }
                            />
                          )}
                          <fieldset className="builder-section compact-builder-section">
                            <legend>Parsing add-ons</legend>
                            <div className="check-grid">
                              <label className="check-field">
                                <input
                                  type="checkbox"
                                  checked={manualDraft.parse.returnOcrData === true}
                                  onChange={(event) =>
                                    updateManualDraft((current) => ({
                                      ...current,
                                      parse: {
                                        ...current.parse,
                                        returnOcrData: event.target.checked,
                                      },
                                    }))
                                  }
                                />
                                Return OCR data
                              </label>
                              <label className="check-field">
                                <input
                                  type="checkbox"
                                  checked={manualDraft.parse.promptedBlocks}
                                  onChange={(event) =>
                                    updateManualDraft((current) => ({
                                      ...current,
                                      parse: {
                                        ...current.parse,
                                        promptedBlocks: event.target.checked,
                                      },
                                    }))
                                  }
                                />
                                Prompted blocks or custom regions
                              </label>
                              {manualDraft.parse.pricingModel === "r-1" && (
                                <label className="check-field">
                                  <input
                                    type="checkbox"
                                    checked={manualDraft.parse.advancedChart}
                                    onChange={(event) =>
                                      updateManualDraft((current) => ({
                                        ...current,
                                        parse: {
                                          ...current.parse,
                                          advancedChart: event.target.checked,
                                          agenticScopes: event.target.checked
                                            ? { ...current.parse.agenticScopes, figure: true }
                                            : current.parse.agenticScopes,
                                        },
                                      }))
                                    }
                                  />
                                  Advanced Chart Agent
                                </label>
                              )}
                            </div>
                          </fieldset>
                        </div>

                        {(manualDraft.parse.pricingModel === "legacy" ||
                          manualDraft.parse.advancedChart) && (
                          <div className="config-group lumos-config-group">
                            <h5>Additional inputs</h5>
                          {manualDraft.parse.pricingModel === "legacy" && (
                            <label className="number-field">
                            Expected Complex page share
                            <span>
                              <input
                                type="number"
                                min="0"
                                max="100"
                                step="1"
                                inputMode="decimal"
                                value={manualDraft.assumptions.complexSharePercent}
                                aria-invalid={manualErrors["assumptions.complexSharePercent"] ? "true" : undefined}
                                onChange={(event) =>
                                  updateManualDraft((current) => ({
                                    ...current,
                                    assumptions: {
                                      ...current.assumptions,
                                      complexSharePercent: event.target.value,
                                    },
                                  }))
                                }
                              />
                              %
                            </span>
                            {manualErrors["assumptions.complexSharePercent"] && (
                              <span className="field-error">
                                {manualErrors["assumptions.complexSharePercent"]}
                              </span>
                            )}
                            </label>
                          )}
                          {manualDraft.parse.advancedChart && (
                            <div className="nested-settings">
                              <label className="check-field">
                                <input
                                  type="checkbox"
                                  checked={manualDraft.assumptions.chartCountsEnabled}
                                  onChange={(event) =>
                                    updateManualDraft((current) => ({
                                      ...current,
                                      assumptions: {
                                        ...current.assumptions,
                                        chartCountsEnabled: event.target.checked,
                                      },
                                    }))
                                  }
                                />
                                Add expected chart counts
                              </label>
                              {manualDraft.assumptions.chartCountsEnabled ? (
                                <div className="form-grid">
                                  <label className="number-field">
                                    Likely charts
                                    <input
                                      type="number"
                                      min="0"
                                      step="1"
                                      inputMode="numeric"
                                      value={manualDraft.assumptions.likelyChartCount}
                                      aria-invalid={manualErrors["assumptions.likelyChartCount"] ? "true" : undefined}
                                      onChange={(event) =>
                                        updateManualDraft((current) => ({
                                          ...current,
                                          assumptions: {
                                            ...current.assumptions,
                                            likelyChartCount: event.target.value,
                                          },
                                        }))
                                      }
                                    />
                                    {manualErrors["assumptions.likelyChartCount"] && (
                                      <span className="field-error">
                                        {manualErrors["assumptions.likelyChartCount"]}
                                      </span>
                                    )}
                                  </label>
                                  <label className="number-field">
                                    Maximum charts
                                    <input
                                      type="number"
                                      min="0"
                                      step="1"
                                      inputMode="numeric"
                                      value={manualDraft.assumptions.maximumChartCount}
                                      aria-invalid={manualErrors["assumptions.maximumChartCount"] ? "true" : undefined}
                                      onChange={(event) =>
                                        updateManualDraft((current) => ({
                                          ...current,
                                          assumptions: {
                                            ...current.assumptions,
                                            maximumChartCount: event.target.value,
                                          },
                                        }))
                                      }
                                    />
                                    {manualErrors["assumptions.maximumChartCount"] && (
                                      <span className="field-error">
                                        {manualErrors["assumptions.maximumChartCount"]}
                                      </span>
                                    )}
                                  </label>
                                </div>
                              ) : (
                                <p className="aside">The detected-chart charge will remain excluded.</p>
                              )}
                              {hasSpreadsheet && (
                                <p className="aside">
                                  Chart counts apply to non-spreadsheet documents. Spreadsheet chart
                                  costs remain excluded.
                                </p>
                              )}
                            </div>
                          )}
                          </div>
                        )}
                      </>
                    )}
                  </section>
                )}

                {manualEndpointTab === "classify" && (
                  <section
                    className="endpoint-panel"
                    role="tabpanel"
                    id="classify-endpoint-panel"
                    aria-labelledby="classify-endpoint-tab"
                  >
                    <header className="endpoint-panel-heading">
                      <div>
                        <h4>Classify</h4>
                        <p>Choose a document category before later pipeline steps.</p>
                      </div>
                      <label className="endpoint-switch">
                        <span>{manualDraft.classify.enabled ? "On" : "Off"}</span>
                        <input
                          type="checkbox"
                          aria-label="Enable Classify endpoint"
                          checked={manualDraft.classify.enabled}
                          onChange={(event) =>
                            updateManualDraft((current) => ({
                              ...current,
                              classify: { ...current.classify, enabled: event.target.checked },
                            }))
                          }
                        />
                      </label>
                    </header>

                    {manualDraft.classify.enabled ? (
                      <div className="config-group">
                        <fieldset className="builder-section compact-builder-section">
                          <legend>Page Range</legend>
                          <div className="form-grid">
                            <label className="number-field">
                              Start
                              <input
                                type="number"
                                min="1"
                                step="1"
                                inputMode="numeric"
                                value={manualDraft.classify.start}
                                aria-invalid={manualErrors["classify.start"] ? "true" : undefined}
                                onChange={(event) =>
                                  updateManualDraft((current) => ({
                                    ...current,
                                    classify: { ...current.classify, start: event.target.value },
                                  }))
                                }
                              />
                              {manualErrors["classify.start"] && (
                                <span className="field-error">{manualErrors["classify.start"]}</span>
                              )}
                            </label>
                            <label className="number-field">
                              End
                              <input
                                type="number"
                                min="1"
                                step="1"
                                inputMode="numeric"
                                value={manualDraft.classify.end}
                                aria-invalid={manualErrors["classify.end"] ? "true" : undefined}
                                onChange={(event) =>
                                  updateManualDraft((current) => ({
                                    ...current,
                                    classify: { ...current.classify, end: event.target.value },
                                  }))
                                }
                              />
                              {manualErrors["classify.end"] && (
                                <span className="field-error">{manualErrors["classify.end"]}</span>
                              )}
                            </label>
                          </div>
                          <p className="aside">Classify can use up to 10 context pages.</p>
                        </fieldset>
                      </div>
                    ) : (
                      <p className="endpoint-empty">Turn on Classify to configure this endpoint.</p>
                    )}
                  </section>
                )}

                {manualEndpointTab === "extract" && (
                  <section
                    className="endpoint-panel"
                    role="tabpanel"
                    id="extract-endpoint-panel"
                    aria-labelledby="extract-endpoint-tab"
                  >
                    <header className="endpoint-panel-heading">
                      <div>
                        <h4>Extract</h4>
                        <p>Return structured fields from the document, parsing included.</p>
                      </div>
                      <label className="endpoint-switch">
                        <span>{manualDraft.extract.mode === "off" ? "Off" : "On"}</span>
                        <input
                          type="checkbox"
                          aria-label="Enable Extract endpoint"
                          aria-describedby={manualDraft.parse.enabled ? "extract-availability" : undefined}
                          checked={manualDraft.extract.mode !== "off"}
                          disabled={manualDraft.parse.enabled}
                          onChange={(event) =>
                            updateManualDraft((current) => ({
                              ...current,
                              extract: {
                                ...current.extract,
                                mode: event.target.checked
                                  ? current.extract.mode === "off"
                                    ? lastExtractMode.current
                                    : current.extract.mode
                                  : "off",
                              },
                            }))
                          }
                        />
                      </label>
                    </header>

                    {manualDraft.extract.mode !== "off" ? (
                      <>
                        <div className="config-group">
                          <div className="check-grid builder-section compact-builder-section">
                            <label className="check-field">
                              <input
                                type="checkbox"
                                checked={manualDraft.extract.includeImages}
                                onChange={(event) =>
                                  updateManualDraft((current) => ({
                                    ...current,
                                    extract: { ...current.extract, includeImages: event.target.checked },
                                  }))
                                }
                              />
                              Include Images
                            </label>
                            <label className="check-field">
                              <input
                                type="checkbox"
                                checked={manualDraft.extract.optimizeForLatency}
                                onChange={(event) =>
                                  updateManualDraft((current) => ({
                                    ...current,
                                    extract: {
                                      ...current.extract,
                                      optimizeForLatency: event.target.checked,
                                    },
                                  }))
                                }
                              />
                              Optimize for Latency <small>2× rate</small>
                            </label>
                            <label className="check-field">
                              <input
                                type="checkbox"
                                checked={manualDraft.extract.mode === "deep"}
                                onChange={(event) =>
                                  updateManualDraft((current) => ({
                                    ...current,
                                    extract: {
                                      ...current.extract,
                                      mode: event.target.checked ? "deep" : "standard",
                                    },
                                  }))
                                }
                              />
                              Deep Extract
                            </label>
                          </div>
                          <PageSelectionEditor
                            id="extract-pages"
                            legend="Page Range"
                            selection={manualDraft.extract.pageSelection}
                            errors={manualErrors}
                            errorField="extract.pageSelection"
                            onChange={(pageSelection) =>
                              updateManualDraft((current) => ({
                                ...current,
                                extract: { ...current.extract, pageSelection },
                              }))
                            }
                          />
                          {(hasSpreadsheet || manualDraft.extract.spreadsheet.configured) && (
                            <SpreadsheetSettings
                              endpoint="extract"
                              value={manualDraft.extract.spreadsheet}
                              errors={manualErrors}
                              onChange={(spreadsheet) =>
                                updateManualDraft((current) => ({
                                  ...current,
                                  extract: { ...current.extract, spreadsheet },
                                }))
                              }
                            />
                          )}
                          <ParsingAddOnControls
                            endpoint="extract"
                            value={manualDraft.extract.parsingAddOns}
                            errors={manualErrors}
                            hasSpreadsheetDocuments={hasSpreadsheet}
                            onChange={(parsingAddOns) =>
                              updateManualDraft((current) => ({
                                ...current,
                                extract: { ...current.extract, parsingAddOns },
                              }))
                            }
                          />
                        </div>

                        <div className="config-group lumos-config-group">
                          <h5>Additional inputs</h5>
                          <label className="check-field">
                            <input
                              type="checkbox"
                              checked={manualDraft.extract.mode === "conditional"}
                              onChange={(event) =>
                                updateManualDraft((current) => ({
                                  ...current,
                                  extract: {
                                    ...current.extract,
                                    mode: event.target.checked ? "conditional" : "standard",
                                  },
                                }))
                              }
                            />
                            Processing may use Standard or Deep Extract
                          </label>
                          <div className="form-grid">
                            <label className="number-field">
                              Expected fields per page
                              <input
                                type="number"
                                min="0"
                                step="1"
                                inputMode="numeric"
                                value={manualDraft.assumptions.extractFieldsPerPage}
                                aria-invalid={manualErrors["assumptions.extractFieldsPerPage"] ? "true" : undefined}
                                onChange={(event) =>
                                  updateManualDraft((current) => ({
                                    ...current,
                                    assumptions: {
                                      ...current.assumptions,
                                      extractFieldsPerPage: event.target.value,
                                    },
                                  }))
                                }
                              />
                              {manualErrors["assumptions.extractFieldsPerPage"] && (
                                <span className="field-error">
                                  {manualErrors["assumptions.extractFieldsPerPage"]}
                                </span>
                              )}
                            </label>
                            {manualDraft.extract.mode === "conditional" && (
                              <label className="number-field">
                                Expected Deep Extract share
                                <span>
                                  <input
                                    type="number"
                                    min="0"
                                    max="100"
                                    step="1"
                                    inputMode="decimal"
                                    value={manualDraft.assumptions.deepSharePercent}
                                    aria-invalid={manualErrors["assumptions.deepSharePercent"] ? "true" : undefined}
                                    onChange={(event) =>
                                      updateManualDraft((current) => ({
                                        ...current,
                                        assumptions: {
                                          ...current.assumptions,
                                          deepSharePercent: event.target.value,
                                        },
                                      }))
                                    }
                                  />
                                  %
                                </span>
                                {manualErrors["assumptions.deepSharePercent"] && (
                                  <span className="field-error">
                                    {manualErrors["assumptions.deepSharePercent"]}
                                  </span>
                                )}
                              </label>
                            )}
                          </div>
                        </div>
                      </>
                    ) : (
                      <p id="extract-availability" className="endpoint-empty">
                        {manualDraft.parse.enabled
                          ? "Turn off standalone Parse before enabling Extract."
                          : "Turn on Extract to configure this endpoint."}
                      </p>
                    )}
                  </section>
                )}

                {manualEndpointTab === "split" && (
                  <section
                    className="endpoint-panel"
                    role="tabpanel"
                    id="split-endpoint-panel"
                    aria-labelledby="split-endpoint-tab"
                  >
                    <header className="endpoint-panel-heading">
                      <div>
                        <h4>Split</h4>
                        <p>Separate a document into sections and partitions, parsing included.</p>
                      </div>
                      <label className="endpoint-switch">
                        <span>{manualDraft.split.mode === "off" ? "Off" : "On"}</span>
                        <input
                          type="checkbox"
                          aria-label="Enable Split endpoint"
                          aria-describedby={manualDraft.parse.enabled ? "split-availability" : undefined}
                          checked={manualDraft.split.mode !== "off"}
                          disabled={manualDraft.parse.enabled}
                          onChange={(event) =>
                            updateManualDraft((current) => ({
                              ...current,
                              split: {
                                ...current.split,
                                mode: event.target.checked
                                  ? current.split.mode === "off"
                                    ? lastSplitMode.current
                                    : current.split.mode
                                  : "off",
                              },
                            }))
                          }
                        />
                      </label>
                    </header>

                    {manualDraft.split.mode !== "off" ? (
                      <div className="config-group">
                        <label className="check-field builder-section compact-builder-section">
                          <input
                            type="checkbox"
                            checked={manualDraft.split.mode === "deep"}
                            onChange={(event) =>
                              updateManualDraft((current) => ({
                                ...current,
                                split: {
                                  ...current.split,
                                  mode: event.target.checked ? "deep" : "standard",
                                },
                              }))
                            }
                          />
                          Deep Split
                        </label>
                        <PageSelectionEditor
                          id="split-pages"
                          legend="Page Range"
                          selection={manualDraft.split.pageSelection}
                          errors={manualErrors}
                          errorField="split.pageSelection"
                          onChange={(pageSelection) =>
                            updateManualDraft((current) => ({
                              ...current,
                              split: { ...current.split, pageSelection },
                            }))
                          }
                        />
                        <ParsingAddOnControls
                          endpoint="split"
                          value={manualDraft.split.parsingAddOns}
                          errors={manualErrors}
                          hasSpreadsheetDocuments={hasSpreadsheet}
                          onChange={(parsingAddOns) =>
                            updateManualDraft((current) => ({
                              ...current,
                              split: { ...current.split, parsingAddOns },
                            }))
                          }
                        />
                      </div>
                    ) : (
                      <p id="split-availability" className="endpoint-empty">
                        {manualDraft.parse.enabled
                          ? "Turn off standalone Parse before enabling Split."
                          : "Turn on Split to configure this endpoint."}
                      </p>
                    )}
                  </section>
                )}

                {manualEndpointTab === "edit" && (
                  <section
                    className="endpoint-panel"
                    role="tabpanel"
                    id="edit-endpoint-panel"
                    aria-labelledby="edit-endpoint-tab"
                  >
                    <header className="endpoint-panel-heading">
                      <div>
                        <h4>Edit</h4>
                        <p>Apply configured edits to document pages.</p>
                      </div>
                      <label className="endpoint-switch">
                        <span>{manualDraft.edit.enabled ? "On" : "Off"}</span>
                        <input
                          type="checkbox"
                          aria-label="Enable Edit endpoint"
                          checked={manualDraft.edit.enabled}
                          onChange={(event) =>
                            updateManualDraft((current) => ({
                              ...current,
                              edit: { ...current.edit, enabled: event.target.checked },
                            }))
                          }
                        />
                      </label>
                    </header>

                    {manualDraft.edit.enabled ? (
                      <>
                        <div className="config-group">
                          <p className="builder-note">
                            Edit is priced separately and added to the estimate.
                          </p>
                        </div>
                        <div className="config-group lumos-config-group">
                          <h5>Additional inputs</h5>
                          <label className="number-field">
                            Fully prefilled pages
                            <input
                              type="number"
                              min="0"
                              max={documents.length > 0 ? documentTotalPages : undefined}
                              step="1"
                              inputMode="numeric"
                              value={manualDraft.edit.fullyPrefilledPages}
                              aria-invalid={manualErrors["edit.fullyPrefilledPages"] ? "true" : undefined}
                              onChange={(event) =>
                                updateManualDraft((current) => ({
                                  ...current,
                                  edit: {
                                    ...current.edit,
                                    fullyPrefilledPages: event.target.value,
                                  },
                                }))
                              }
                            />
                            {manualErrors["edit.fullyPrefilledPages"] && (
                              <span className="field-error">
                                {manualErrors["edit.fullyPrefilledPages"]}
                              </span>
                            )}
                          </label>
                          {documents.length > 0 && (
                            <p className="aside">Up to {documentTotalPages} uploaded pages.</p>
                          )}
                        </div>
                      </>
                    ) : (
                      <p className="endpoint-empty">Turn on Edit to configure this endpoint.</p>
                    )}
                  </section>
                )}

                {manualDraft.assumptions.unpricedCostFactors.length > 0 && (
                  <aside className="builder-exclusions" aria-label="Imported estimate exclusions">
                    <strong>Excluded from the estimate</strong>
                    <ul>
                      {manualDraft.assumptions.unpricedCostFactors.map((factor) => (
                        <li key={factor}>
                          {unpricedFactorLabel(factor, appliedRateDraft.advancedChart)}
                        </li>
                      ))}
                    </ul>
                  </aside>
                )}

              </div>
              <footer className="configurator-footer">
                <button type="button" onClick={applyPipeline}>Apply configuration</button>
              </footer>
            </div>
          </div>
        ) : (
          <div role="tabpanel" id="code-panel" aria-labelledby="code-tab">
            <p className="aside">
              Copy the JSON configuration for each operation in your Reducto pipeline and paste it
              here. Include every operation Lumos should price, such as both Parse and Extract.
            </p>
            <textarea
              aria-label="Reducto JSON configuration"
              className="json-editor"
              rows={20}
              spellCheck={false}
              placeholder={`{
  "enhance": {},
  "settings": {}
}

{
  "instructions": {
    "schema": { "type": "object" }
  },
  "settings": {}
}`}
              value={reductoCode}
              onChange={(event) => {
                setReductoCode(event.target.value);
                setPipelineDraftState("dirty");
                setPipelineError("");
                setImportApplied(false);
                setProfileCopyState("idle");
              }}
            />
            {reductoCode.trim() && codeImportSummary && (
              <p className="import-summary"><strong>Detected</strong> {codeImportSummary}</p>
            )}
            {reductoCode.trim() && codeImport.warnings.length > 0 && (
              <ul className="import-notes">
                {codeImport.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            )}
            {reductoCode.trim() && codeImport.error && (
              <p className="error" role="alert">{codeImport.error}</p>
            )}
            <div className="button-row">
              <button
                type="button"
                disabled={!codeImport.applicable}
                onClick={applyImportedPipeline}
              >
                Apply configuration
              </button>
              {importApplied && (
                <>
                  <span className="aside" role="status">Configuration applied</span>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setPipelineInputTab("profile")}
                  >
                    Review setup
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {pipelineDraftState === "applied" && (
          <div className="applied-configuration-actions">
            <button type="button" className="text-button" onClick={copyLumosProfile}>
              Copy Lumos profile
            </button>
            {profileCopyState !== "idle" && (
              <span
                className={profileCopyState === "error" ? "error" : "aside"}
                role={profileCopyState === "error" ? "alert" : "status"}
              >
                {profileCopyState === "copied"
                  ? "Lumos profile copied."
                  : "Copy failed. Copy the pipeline object from the request below."}
              </span>
            )}
          </div>
        )}
        {pipelineError && <p className="error" role="alert">{pipelineError}</p>}

        <h3>3. Policy</h3>
        <div className="button-row policy-controls">
          <label className="budget">
            Maximum cost, USD
            <input
              type="number"
              min="0"
              step="0.25"
              value={budget}
              onChange={(event) => setBudget(Math.max(0, Number(event.target.value)))}
            />
          </label>
          <button
            ref={rateCardButton}
            type="button"
            className="rate-card-link"
            aria-haspopup="dialog"
            aria-controls="rate-card-dialog"
            onClick={openRateCard}
          >
            {isCustomRateCard ? "Default rate card (custom)" : "Default rate card"}
          </button>
        </div>

        <h3>4. Estimate</h3>

        <dialog
          id="rate-card-dialog"
          ref={rateCardDialog}
          className="rate-card-dialog"
          aria-labelledby="rate-card-title"
          aria-describedby="rate-card-description"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.currentTarget.close();
            }
          }}
          onClose={() => {
            setRateErrors({});
            rateCardButton.current?.focus();
          }}
        >
          <div className="rate-card-header">
            <div>
              <h3 id="rate-card-title">Default rate card</h3>
              <p id="rate-card-description">
                Modifications to the default rates below affect the simulator only and remain in
                this browser session.
              </p>
            </div>
            <button
              type="button"
              aria-label="Close rate card"
              onClick={() => rateCardDialog.current?.close()}
            >
              Close
            </button>
          </div>
          <div ref={rateCardBody} className="rate-card-body">
            {pipelineDraftState !== "applied" && (
              <p className="aside">Apply a pipeline configuration to mark used rates.</p>
            )}
            {Object.keys(rateErrors).length > 0 && (
              <p className="rate-error-summary" role="alert">
                Review the highlighted rate card values.
              </p>
            )}
            {RATE_GROUPS.map((group) => (
              <fieldset className="rate-group" key={group.name}>
                <legend>{group.name}</legend>
                <div className="rate-grid">
                  {group.fields.map((field) => {
                    const error = rateErrors[field.key];
                    const inputId = `rate-${field.key}`;
                    const errorId = `${inputId}-error`;
                    return (
                      <label
                        className={`rate-field${usedPricing.rates.has(field.key) ? " rate-field-used" : ""}`}
                        key={field.key}
                        htmlFor={inputId}
                      >
                        <span className="rate-field-heading">
                          <span>{field.label}</span>
                          {usedPricing.rates.has(field.key) && <span className="used-label">Used</span>}
                        </span>
                        <span className="rate-input-row">
                          <span aria-hidden="true">$</span>
                          <input
                            ref={(input) => {
                              rateInputRefs.current[field.key] = input;
                            }}
                            id={inputId}
                            type="text"
                            inputMode="decimal"
                            autoComplete="off"
                            value={rateDraft[field.key]}
                            aria-invalid={error ? "true" : undefined}
                            aria-describedby={error ? errorId : undefined}
                            onChange={(event) => {
                              setRateDraft((current) => ({
                                ...current,
                                [field.key]: event.target.value,
                              }));
                              setRateErrors((current) => {
                                if (!current[field.key]) return current;
                                const next = { ...current };
                                delete next[field.key];
                                return next;
                              });
                            }}
                          />
                          <span className="rate-unit">
                            {"unit" in field ? field.unit : "/ 1,000 pages"}
                          </span>
                        </span>
                        {error && <span id={errorId} className="rate-field-error">{error}</span>}
                      </label>
                    );
                  })}
                </div>
                {group.name === "Spreadsheet" && (
                  <p className="aside spreadsheet-rate-note">
                    Accurate uses 1 credit per 1,000 cells. Fast and Disabled use 1 per
                    5,000. Consult your Reducto rate card.
                  </p>
                )}
              </fieldset>
            ))}

            <fieldset className="rate-group fixed-rules">
              <legend>Pricing rules</legend>
              <dl>
                <div className={usedPricing.rules.has("agentic") ? "rate-rule-used" : undefined}>
                  <dt>
                    Agentic Parse
                    {usedPricing.rules.has("agentic") && <span className="used-label">Used</span>}
                  </dt>
                  <dd>{FIXED_PRICING_RULES.agenticParseMultiplier}×</dd>
                </div>
                <div className={usedPricing.rules.has("latency") ? "rate-rule-used" : undefined}>
                  <dt>
                    Latency priority
                    {usedPricing.rules.has("latency") && <span className="used-label">Used</span>}
                  </dt>
                  <dd>{FIXED_PRICING_RULES.extractLatencyMultiplier}×</dd>
                </div>
                <div className={usedPricing.rules.has("batch") ? "rate-rule-used" : undefined}>
                  <dt>
                    Batch Parse
                    {usedPricing.rules.has("batch") && <span className="used-label">Used</span>}
                  </dt>
                  <dd>{FIXED_PRICING_RULES.batchParseDiscount * 100}% discount</dd>
                </div>
              </dl>
            </fieldset>
          </div>
          <div className="rate-card-actions">
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setRateDraft(ratesToDraft(DEFAULT_PRICING_UNIT_RATES));
                setRateErrors({});
              }}
            >
              Reset to default rates
            </button>
            <div>
              <button type="button" onClick={() => rateCardDialog.current?.close()}>
                Cancel
              </button>
              <button type="button" onClick={applyRateCard}>Apply rates</button>
            </div>
          </div>
        </dialog>

        {pipelineDraftState === "unconfigured" ? (
          <p className="empty">Apply a pipeline configuration to estimate these documents</p>
        ) : pipelineDraftState === "dirty" ? (
          <p className="empty" role="status" aria-live="polite">
            Apply the pipeline changes to refresh the estimate
          </p>
        ) : pipelineDraftState === "invalid" ? (
          <p className="empty">Fix the configuration and apply it before estimating</p>
        ) : estimateResult.error ? (
          <p className="error" role="alert">{estimateResult.error}</p>
        ) : !estimate ? (
          <p className="empty">Upload documents to see a cost estimate</p>
        ) : (
          <div className="estimate" aria-live="polite">
            <p className={`decision decision-${estimate.decision}`}>
              {estimate.decision.toUpperCase()} against a {money(budget)} limit
            </p>
            {hasEstimateRange ? (
              <dl className="range">
                <div><dt>{estimate.estimateComplete ? "Low" : "Known low"}</dt><dd>{money(estimate.low)}</dd></div>
                <div><dt>{estimate.estimateComplete ? "Likely" : "Known likely"}</dt><dd>{money(estimate.likely)}</dd></div>
                <div><dt>{estimate.estimateComplete ? "High" : "Known high"}</dt><dd>{money(estimate.high)}</dd></div>
              </dl>
            ) : (
              <dl className="range range-single">
                <div>
                  <dt>{estimate.estimateComplete ? "Estimate" : "Known estimate"}</dt>
                  <dd>{money(estimate.likely)}</dd>
                </div>
              </dl>
            )}
            {!estimate.estimateComplete && (
              <p className="error">
                Review required because this base estimate excludes {estimate.unpricedCostFactors.map((factor) => unpricedFactorLabel(factor, appliedRateDraft.advancedChart)).join(", ")}.
              </p>
            )}
            <p>
              {documents.length} documents, {estimate.totalPages} page{estimate.totalPages === 1 ? "" : "s"}
              {estimate.spreadsheetDocuments > 0
                ? `, ${estimate.spreadsheetCellsEstimated.toLocaleString()} estimated non-empty cells, ${estimate.spreadsheetCredits.toLocaleString()} credits`
                : ""}
              {estimateBreakdown.length > 0 ? `. ${estimateBreakdown.join("; ")}.` : "."}
              {parsingNote ? ` ${parsingNote}` : ""}
            </p>
            {estimate.spreadsheetDocuments > 0 && (
              <p className="aside">
                Spreadsheet estimates assume {rateMoney(appliedRates.spreadsheetCredit)} per
                credit. Consult your Reducto rate card.
              </p>
            )}
          </div>
        )}
      </section>

      <section id="api">
        <h2>API</h2>
        <h3><code>POST {appPath("/api/estimate")}</code></h3>
        <p>
          Send document metadata, the Lumos profile generated by the simulator, and an optional
          budget.
        </p>
        <div className="table-wrap">
          <table className="api-request-table">
            <thead>
              <tr><th>Request field</th><th>Use</th></tr>
            </thead>
            <tbody>
              <tr>
                <td><code>documents</code></td>
                <td>
                  Required document <strong>metadata</strong>. Send <code>name</code> and <code>pages</code> for ordinary documents. For spreadsheets, send <code>name</code> and optional <code>estimated_non_empty_cells</code>. Do not send file contents.
                </td>
              </tr>
              <tr>
                <td><code>pipeline</code></td>
                <td>
                  Required. The Lumos profile generated by the simulator, whether the configuration
                  was created manually or imported from Reducto.
                </td>
              </tr>
              <tr>
                <td><code>policy.max_total_usd</code></td>
                <td>Optional. Maximum acceptable job cost in USD. Defaults to <code>10</code>.</td>
              </tr>
              <tr>
                <td><code>processing_context</code></td>
                <td>
                  Optional. Set an Extract or Split input to <code>jobid</code> when it reuses an
                  already billed Parse result; otherwise Lumos assumes a document input.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <pre><code>{`const documents = [
  { name: "agreement.pdf", pages: 42 },
  { name: "model.xlsx", estimated_non_empty_cells: 125000 }
];

const pipeline = await loadSavedLumosProfile();

const response = await fetch("${appPath("/api/estimate")}", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ documents, pipeline, policy: { max_total_usd: 10 } })
});

if (!response.ok) return stopForEstimateError(await response.json());

const estimate = await response.json();

if (estimate.decision === "deny") return showCostWarning(estimate);
if (estimate.decision === "review") return askForApproval(estimate);
if (estimate.decision !== "allow") return stopForEstimateError(estimate);

const result = await reducto.pipeline.run({ input, pipeline_id });`}</code></pre>

        <p className="aside">
          Spreadsheet API estimates use Lumos&apos;s $0.01-per-credit default. Consult your Reducto rate card.
        </p>

        <p>
          The response includes the estimate, cost breakdown, usage, and a policy decision.
          Continue on <code>allow</code>, request approval on <code>review</code>, and stop on
          <code>deny</code>.
        </p>
        <p className="aside">
          Production use should protect this endpoint with an authenticated server-to-server
          integration.
        </p>

        {pipelineDraftState === "applied" && apiRequest && (
          <details className="api-preview">
            <summary>View this simulator&apos;s API request and response</summary>
            <div className="api-preview-body">
              <h3>Request preview</h3>
              <pre><code>{JSON.stringify(apiRequest, null, 2)}</code></pre>
              <h3>Response preview</h3>
              {isCustomRateCard && (
                <p className="aside">
                  The API preview uses default rates; simulator rate edits are excluded.
                </p>
              )}
              <pre><code>{JSON.stringify(apiResponse, null, 2)}</code></pre>
            </div>
          </details>
        )}
      </section>

      <section id="verify">
        <h2>Verify with Reducto</h2>
        <p>
          This optional test uploads the real non-spreadsheet files to Reducto, runs your deployed
          pipeline once per document, and returns Reducto&apos;s actual usage response without Lumos
          saving your API key or extracted document contents; because it starts paid work, the form
          asks you to confirm first. Spreadsheet files are not uploaded or verified here.
        </p>
        <details>
          <summary>Open the paid verification form</summary>
          <div className="verify-form">
            <label>
              Reducto API key
              <input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
            </label>
            <label>
              Deployed pipeline ID
              <input type="text" value={pipelineId} onChange={(event) => setPipelineId(event.target.value)} />
            </label>
            <label className="confirmation">
              <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
              I understand this uploads my files to Reducto and may incur charges.
            </label>
            <button type="button" disabled={liveState === "running"} onClick={() => void runReducto()}>
              {liveState === "running" ? "Running paid job…" : "Run paid Reducto job"}
            </button>
            <p className="aside">
              Lumos handles your files, API key, and extracted contents only for this request;
              Reducto&apos;s retention terms apply to the paid job.
            </p>
            {liveError && <p className="error" role="alert">{liveError}</p>}
            {liveResult !== null && <pre><code>{JSON.stringify(liveResult, null, 2)}</code></pre>}
          </div>
        </details>
      </section>

      <footer>
        <p>
          Sources: {" "}
          <a href="https://docs.reducto.ai/reference/credit-usage">pricing</a>, {" "}
          <a href="https://docs.reducto.ai/reference/page-billing-breakdown">billing breakdown</a>, and {" "}
          <a href="https://docs.reducto.ai/workflows/pipeline-basics">pipeline basics</a>.
        </p>
        <p>
          Created by <a href="https://varindersaini.com">Varinder Saini</a> · {" "}
          <a href="https://github.com/varinderp/lumos-reducto-preflight">Lumos GitHub</a>
        </p>
        <p>
          Please send feedback at {" "}
          <a href="mailto:varinderpsaini@gmail.com">varinderpsaini@gmail.com</a>
        </p>
        <details className="release-note">
          <summary aria-label={`Lumos version ${packageJson.version}; show release history`}>
            {`v${packageJson.version}`}
          </summary>
          <p><strong>v0.1.35</strong> — Added spreadsheet cell pricing.</p>
          <p><strong>v0.1.34</strong> — Added parsing add-on pricing.</p>
          <p><strong>v0.1.33</strong> — Added r‑1 Beta pricing.</p>
        </details>
      </footer>
    </main>
  );
}
