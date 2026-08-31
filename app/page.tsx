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
import {
  DEFAULT_PRICING_UNIT_RATES,
  estimatePipeline,
  FIXED_PRICING_RULES,
  normalizeRequest,
  RATE_CARD,
  type PricingUnitRates,
  type PublicPipeline,
} from "@/lib/pricing";
import {
  DEFAULT_MANUAL_PIPELINE_DRAFT,
  manualErrorEndpoint,
  manualDraftToPipeline,
  pipelineToManualDraft,
  type ManualEndpoint,
  type ManualPageSelectionDraft,
  type ManualPipelineDraft,
  type ManualPipelineErrors,
} from "@/lib/manual-pipeline";
import { importReductoCode, type ReductoCodeImportResult } from "@/lib/reducto-code-import";
import { serializeLumosProfile } from "@/lib/profile-copy";
import { simulatorModeLabel } from "@/lib/simulator-mode";

type DocumentRow = {
  id: string;
  name: string;
  pages: number;
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
      { key: "parseStandard", label: "Standard Parse", perThousand: true },
      { key: "parseComplex", label: "Complex Parse", perThousand: true },
      { key: "advancedChart", label: "Advanced Chart", perThousand: false },
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
] as const satisfies ReadonlyArray<{
  name: string;
  fields: ReadonlyArray<{ key: RateFieldKey; label: string; perThousand: boolean }>;
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

const DEMO_PAGES = [4, 8, 11, 3, 7, 5, 9, 2, 8, 6, 5, 4, 7, 3, 8];
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
      pageSelection: {
        ...draft.parse.pageSelection,
        ranges: draft.parse.pageSelection.ranges.map((range) => ({ ...range })),
      },
    },
    classify: { ...draft.classify },
    extract: {
      ...draft.extract,
      pageSelection: {
        ...draft.extract.pageSelection,
        ranges: draft.extract.pageSelection.ranges.map((range) => ({ ...range })),
      },
    },
    split: {
      ...draft.split,
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

function makeDemoDocuments(): DocumentRow[] {
  return DEMO_PAGES.map((pages, index) => ({
    id: `demo-${index}`,
    name: `data-room-${String(index + 1).padStart(2, "0")}.pdf`,
    pages,
    note: "Example metadata",
  }));
}

function money(value: number) {
  const decimalPlaces = value < 1 ? 4 : 2;
  const factor = 10 ** decimalPlaces;
  const rounded = Math.round((value + Number.EPSILON) * factor) / factor;
  return `$${rounded.toFixed(decimalPlaces)}`;
}

function isSpreadsheetName(name: string) {
  return /\.(?:xls|xlsx|xlsm|xltx|xltm|csv|qpw)(?:[?#].*)?$/i.test(name);
}

function importSummary(result: ReductoCodeImportResult) {
  const operationNames = result.detected.operations.map((operation) => {
    if (operation === "extract") {
      return result.detected.extractMode === "deep" ? "Deep Extract" : "Standard Extract";
    }
    if (operation === "parse") {
      return result.pipeline?.parse?.enhance?.agentic?.length ? "Agentic Parse" : "Parse";
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
  if (factor === "parse.advanced_chart_count") {
    return `the $${advancedChartRate}-per-detected-chart charge because no chart count was provided`;
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
  } else if (/\.(xls|xlsx|csv)$/.test(name)) {
    note = "Spreadsheet calculations are currently unsupported";
  }

  return {
    id: crypto.randomUUID(),
    name: file.name,
    pages,
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
  const documentTotalPages = documents.reduce((total, document) => total + document.pages, 0);
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
    if (standaloneParse) {
      rates.add("parseStandard");
      rates.add("parseComplex");
      const agenticModes = pipeline.parse?.enhance?.agentic ?? [];
      if (agenticModes.length > 0) rules.add("agentic");
      if (agenticModes.some((mode) => mode.advanced_chart_agent === true)) {
        rates.add("advancedChart");
      }
      if (pipeline.parse?.queue_priority === "batch") rules.add("batch");
    }
    if (pipeline.classify != null) rates.add("classify");
    if (pipeline.extract != null) {
      if (pipeline.lumos_assumptions?.conditional_extract_routing) {
        rates.add("extract");
        rates.add("deepExtract");
      } else if (pipeline.extract.settings?.deep_extract) {
        rates.add("deepExtract");
      } else {
        rates.add("extract");
      }
      if (pipeline.extract.settings?.optimize_for_latency) rules.add("latency");
    }
    if (pipeline.split != null) {
      rates.add(pipeline.split.settings?.deep_split ? "deepSplit" : "split");
    }
    if (pipeline.edit != null) {
      rates.add("edit");
      if ((pipeline.lumos_assumptions?.known_fully_prefilled_edit_pages ?? 0) > 0) {
        rates.add("editPrefilled");
      }
    }
    return { rates, rules };
  }, [pipeline, pipelineDraftState]);

  const estimateResult = useMemo(() => {
    if (!documents.length || hasSpreadsheet || pipelineDraftState !== "applied") {
      return { estimate: null, error: "" };
    }
    try {
      const normalized = normalizeRequest({
        documents: documents.map(({ name, pages }) => ({ name, pages })),
        pipeline,
        policy: { max_total_usd: budget },
      });
      return { estimate: estimatePipeline(normalized, appliedRates), error: "" };
    } catch (error) {
      return {
        estimate: null,
        error: error instanceof Error ? error.message : "The estimate inputs are invalid.",
      };
    }
  }, [documents, pipeline, budget, hasSpreadsheet, pipelineDraftState, appliedRates]);
  const estimate = estimateResult.estimate;

  const publicEstimateResult = useMemo(() => {
    if (!documents.length || hasSpreadsheet || pipelineDraftState !== "applied") {
      return { estimate: null, error: "" };
    }
    try {
      const normalized = normalizeRequest({
        documents: documents.map(({ name, pages }) => ({ name, pages })),
        pipeline,
        policy: { max_total_usd: budget },
      });
      return { estimate: estimatePipeline(normalized), error: "" };
    } catch (error) {
      return {
        estimate: null,
        error: error instanceof Error ? error.message : "The estimate inputs are invalid.",
      };
    }
  }, [documents, pipeline, budget, hasSpreadsheet, pipelineDraftState]);
  const apiEstimate = isCustomRateCard ? publicEstimateResult.estimate : estimate;
  const hasEstimateRange = estimate != null && estimate.low !== estimate.high;
  const configuredMode =
    pipelineDraftState === "applied"
      ? simulatorModeLabel(pipeline)
      : "Awaiting pipeline config";

  const apiRequest = useMemo(
    () =>
      pipelineDraftState === "applied"
        ? {
            documents: documents.map(({ name, pages }) => ({ name, pages })),
            pipeline,
            policy: { max_total_usd: budget },
          }
        : null,
    [documents, pipeline, budget, pipelineDraftState],
  );

  const apiResponse = useMemo(
    () =>
      pipelineDraftState !== "applied"
        ? { error: "Apply the pipeline changes before requesting an estimate." }
        : apiEstimate
        ? {
            decision: apiEstimate.decision,
            estimate: {
              low_usd: Number(apiEstimate.low.toFixed(4)),
              likely_usd: Number(apiEstimate.likely.toFixed(4)),
              high_usd: Number(apiEstimate.high.toFixed(4)),
              currency: "USD",
            },
            breakdown: {
              parse_low_usd: Number(apiEstimate.parseLow.toFixed(4)),
              parse_likely_usd: Number(apiEstimate.parseLikely.toFixed(4)),
              parse_high_usd: Number(apiEstimate.parseHigh.toFixed(4)),
              classify_usd: Number(apiEstimate.classifyCost.toFixed(4)),
              extract_low_usd: Number(apiEstimate.extractLow.toFixed(4)),
              extract_likely_usd: Number(apiEstimate.extractLikely.toFixed(4)),
              extract_high_usd: Number(apiEstimate.extractHigh.toFixed(4)),
              split_usd: Number(apiEstimate.splitCost.toFixed(4)),
              edit_usd: Number(apiEstimate.editCost.toFixed(4)),
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
            },
            assumptions_used: {
              ...(apiEstimate.parseMode === "standalone"
                ? { likely_complex_parse_share: apiEstimate.parseLikelyComplexShare }
                : {}),
              ...(apiEstimate.parseAdvancedChartCounts
                ? {
                    advanced_chart_counts: {
                      likely: apiEstimate.parseAdvancedChartCounts.likely,
                      maximum: apiEstimate.parseAdvancedChartCounts.high,
                    },
                  }
                : {}),
              ...(pipeline.lumos_assumptions?.conditional_extract_routing
                ? {
                    likely_deep_extract_share:
                      pipeline.lumos_assumptions.likely_deep_extract_share ?? 0.25,
                  }
                : {}),
            },
            rate_card: RATE_CARD,
            has_range: apiEstimate.low !== apiEstimate.high,
            estimate_complete: apiEstimate.estimateComplete,
            unpriced_cost_factors: apiEstimate.unpricedCostFactors,
          }
        : hasSpreadsheet
          ? {
              error: "Spreadsheet pricing needs billable cell counts and your Reducto rate card.",
            }
          : estimateResult.error
            ? { error: estimateResult.error }
            : { decision: "awaiting_documents", estimate: null },
    [apiEstimate, documents.length, estimateResult.error, hasSpreadsheet, pipeline, pipelineDraftState],
  );

  const estimateBreakdown = estimate
    ? [
        estimate.parseMode === "standalone"
          ? `Parse ${money(estimate.parseLow)}–${money(estimate.parseHigh)} across ${estimate.parsePages} priced pages`
          : null,
        pipeline.classify != null ? `Classify ${money(estimate.classifyCost)}` : null,
        pipeline.extract != null
          ? `Extract ${
              estimate.extractLow === estimate.extractHigh
                ? money(estimate.extractLikely)
                : `${money(estimate.extractLow)}–${money(estimate.extractHigh)}`
            } across ${estimate.extractPages} priced pages`
          : null,
        pipeline.split != null
          ? `Split ${money(estimate.splitCost)} across ${estimate.splitPages} priced pages`
          : null,
        pipeline.edit != null ? `Edit ${money(estimate.editCost)}` : null,
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

    let validatedUnpricedCostFactors: string[] = [];
    try {
      const normalized = normalizeRequest({
        documents: documents.length > 0 && !hasSpreadsheet
          ? documents.map(({ name, pages }) => ({ name, pages }))
          : [{ name: "validation.pdf", pages: 1_000_000 }],
        pipeline: result.pipeline,
      });
      validatedUnpricedCostFactors = estimatePipeline(
        normalized,
        appliedRates,
      ).unpricedCostFactors;
    } catch (error) {
      const invalidEndpoint = manualSetupErrorEndpoint(error);
      const errorField = invalidEndpoint === "classify"
        ? "classify.start"
        : invalidEndpoint === "parse" || invalidEndpoint === "extract" || invalidEndpoint === "split"
          ? `${invalidEndpoint}.pageSelection`
          : "setup";
      setManualErrors({ [errorField]: manualSetupError(error) });
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
    setManualDraft((current) => ({
      ...current,
      assumptions: {
        ...current.assumptions,
        unpricedCostFactors: [...validatedUnpricedCostFactors],
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
      const normalized = normalizeRequest({
        documents: documents.length > 0 && !hasSpreadsheet
          ? documents.map(({ name, pages }) => ({ name, pages }))
          : [{ name: "validation.pdf", pages: 1_000_000 }],
        pipeline: codeImport.pipeline,
      });
      estimatePipeline(normalized, appliedRates);
      const hydratedDraft = cloneManualDraft(
        pipelineToManualDraft(codeImport.pipeline, codeImport.configurations),
      );
      setPipeline(codeImport.pipeline);
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
      const response = await fetch("/api/reducto", { method: "POST", body });
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

  function clearSession() {
    const dialog = rateCardDialog.current;
    if (dialog?.open) dialog.close();
    setDocuments([]);
    setPipeline(DEFAULT_PIPELINE);
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
            href="/waiver.png"
            aria-haspopup="dialog"
            aria-controls="budget-example"
            onClick={(event) => {
              const dialog = budgetPreview.current;
              if (dialog && typeof dialog.showModal === "function") {
                event.preventDefault();
                if (!dialog.open) dialog.showModal();
              }
            }}
          >
            <strong>protect budgets</strong>
          </a>{", and help teams use resources more efficiently and transparently."}
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
              src="/waiver.png"
            width={1040}
            height={1512}
              sizes="(max-width: 960px) calc(100vw - 56px), 880px"
              alt="An email requesting a waiver after test runs processed about 198,000 pages, followed by a response approving a credit for the overage."
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
          <a href="/reducto-lumos.jpg" aria-label="Open the Lumos workflow image at full size">
            <Image
              src="/reducto-lumos.jpg"
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
          <button type="button" className="text-button" onClick={() => setDocuments(makeDemoDocuments())}>
            Load 15-document example
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
          accept=".pdf,.png,.jpg,.jpeg,.gif,.heic,.bmp,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.csv"
          onChange={onFileChange}
        />

        {documents.length === 0 ? (
          <p className="empty">Awaiting documents</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Document</th><th>Pages</th><th>Mode</th><th /></tr>
              </thead>
              <tbody>
                {documents.map((document) => (
                  <tr key={document.id}>
                    <td>{document.name}<small>{document.note}</small></td>
                    <td>
                      <input
                        aria-label={`Pages in ${document.name}`}
                        type="number"
                        min="1"
                        value={document.pages}
                        onChange={(event) =>
                          updateDocument(document.id, { pages: Math.max(1, Number(event.target.value)) })
                        }
                      />
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
                ))}
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
            ? `${documents.length} document${documents.length === 1 ? "" : "s"}, ${documentTotalPages} page${documentTotalPages === 1 ? "" : "s"}`
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
                        </div>

                        <div className="config-group lumos-config-group">
                          <h5>Additional inputs</h5>
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
                            </div>
                          )}
                        </div>
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
                            {field.perThousand ? "/ 1,000 pages" : "/ detected chart"}
                          </span>
                        </span>
                        {error && <span id={errorId} className="rate-field-error">{error}</span>}
                      </label>
                    );
                  })}
                </div>
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
              Reset to public rates
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
        ) : hasSpreadsheet ? (
          <p className="empty">
            Spreadsheet calculations are currently unsupported because Reducto prices them from
            cell usage using the customer&apos;s rate card.
          </p>
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
              {documents.length} documents, {estimate.totalPages} pages
              {estimateBreakdown.length > 0 ? `. ${estimateBreakdown.join("; ")}.` : "."}
              {parsingNote ? ` ${parsingNote}` : ""}
            </p>
          </div>
        )}
      </section>

      <section id="api">
        <h2>API</h2>
        <h3><code>POST /api/estimate</code></h3>
        <p>
          Send document metadata, the Lumos profile generated by the simulator, and an optional
          budget. Lumos receives metadata, not files.
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
                  Required. An array of document metadata. Each item contains the original filename
                  in <code>name</code> and the page count in <code>pages</code>. Do not send file contents.
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
            </tbody>
          </table>
        </div>
        <pre><code>{`const documents = [
  { name: "agreement.pdf", pages: 42 }
];

const pipeline = await loadSavedLumosProfile();

const response = await fetch("/api/estimate", {
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
                  The API preview uses public rates; simulator rate edits are excluded.
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
          This optional test uploads the real files to Reducto, runs your deployed pipeline once per
          document, and returns Reducto&apos;s actual usage response without Lumos saving your API key
          or extracted document contents; because it starts paid work, the form asks you to confirm first.
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
        <p>Created by <a href="https://varindersaini.com">Varinder Saini</a></p>
        <p aria-label="Lumos version">{`v${packageJson.version}`}</p>
      </footer>
    </main>
  );
}
