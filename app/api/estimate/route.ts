import {
  DEFAULT_PRICING_UNIT_RATES,
  estimatePipeline,
  normalizeRequest,
  R1_RATE_CARD,
  RATE_CARD,
  type PublicEstimateRequest,
} from "@/lib/pricing";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as PublicEstimateRequest;
    const input = normalizeRequest(payload);
    const estimate = estimatePipeline(input);
    const hasSpreadsheets = estimate.spreadsheetDocuments > 0;
    const usd = (value: number) => Number(value.toFixed(hasSpreadsheets ? 6 : 4));

    return Response.json({
      decision: estimate.decision,
      estimate: {
        low_usd: usd(estimate.low),
        likely_usd: usd(estimate.likely),
        high_usd: usd(estimate.high),
        currency: "USD",
      },
      breakdown: {
        parse_low_usd: usd(estimate.parseLow),
        parse_likely_usd: usd(estimate.parseLikely),
        parse_high_usd: usd(estimate.parseHigh),
        classify_usd: usd(estimate.classifyCost),
        extract_low_usd: usd(estimate.extractLow),
        extract_likely_usd: usd(estimate.extractLikely),
        extract_high_usd: usd(estimate.extractHigh),
        split_usd: usd(estimate.splitCost),
        split_low_usd: usd(estimate.splitLow),
        split_likely_usd: usd(estimate.splitLikely),
        split_high_usd: usd(estimate.splitHigh),
        edit_usd: usd(estimate.editCost),
        ...(hasSpreadsheets
          ? { spreadsheet_usd: usd(estimate.spreadsheetCost) }
          : {}),
        parsing_add_ons: estimate.parsingAddOns,
      },
      usage: {
        documents: input.documents.length,
        pages: estimate.totalPages,
        parse_pages_priced: estimate.parsePages,
        parse_cost_multiplier: estimate.parseCostMultiplier,
        parse_batch_discount: estimate.parseBatchDiscount,
        classify_pages_priced: estimate.classifyPages,
        extract_pages_priced: estimate.extractPages,
        split_pages_priced: estimate.splitPages,
        extract_cost_multiplier: estimate.extractCostMultiplier,
        ocr_pages: {
          parse: estimate.parsingAddOns.parse.ocr_pages,
          extract: estimate.parsingAddOns.extract.ocr_pages,
          split: estimate.parsingAddOns.split.ocr_pages,
        },
        prompted_pages: {
          parse: estimate.parsingAddOns.parse.prompted_pages,
          extract: estimate.parsingAddOns.extract.prompted_pages,
          split: estimate.parsingAddOns.split.prompted_pages,
        },
        charts: {
          parse: estimate.parsingAddOns.parse.charts,
          extract: estimate.parsingAddOns.extract.charts,
          split: estimate.parsingAddOns.split.charts,
        },
        ...(hasSpreadsheets
          ? {
              spreadsheets: {
                documents: estimate.spreadsheetDocuments,
                estimated_non_empty_cells: estimate.spreadsheetCellsEstimated,
                documents_missing_cell_count:
                  estimate.spreadsheetDocumentsMissingCellCount,
                credits: estimate.spreadsheetCredits,
                clustering: estimate.spreadsheetClustering,
                max_cell_count: estimate.spreadsheetMaxCellCount,
                base_endpoint: estimate.spreadsheetBaseEndpoint,
              },
            }
          : {}),
      },
      assumptions_used: {
        ...(estimate.parseMode === "standalone" &&
        estimate.parseModel === "legacy" &&
        estimate.parsePages > 0
          ? { likely_complex_parse_share: estimate.parseLikelyComplexShare }
          : {}),
        ...(estimate.parseAdvancedChartCounts && estimate.parsePages > 0
          ? {
              advanced_chart_counts: {
                likely: estimate.parseAdvancedChartCounts.likely,
                maximum: estimate.parseAdvancedChartCounts.high,
              },
            }
          : {}),
        ...(input.pipeline.extractMode === "conditional" && estimate.extractPages > 0
          ? { likely_deep_extract_share: input.pipeline.deepShare }
          : {}),
      },
      rate_card: estimate.parseModel === "r-1" ? R1_RATE_CARD : RATE_CARD,
      ...(hasSpreadsheets
        ? {
            spreadsheet_rate_basis: {
              usd_per_credit: DEFAULT_PRICING_UNIT_RATES.spreadsheetCredit,
              basis: "lumos_default",
              note: "Consult your Reducto rate card.",
            },
          }
        : {}),
      has_range: estimate.low !== estimate.high,
      estimate_complete: estimate.estimateComplete,
      unpriced_cost_factors: estimate.unpricedCostFactors,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "The estimate request is invalid." },
      { status: 400 },
    );
  }
}
