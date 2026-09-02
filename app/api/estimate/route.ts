import {
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

    return Response.json({
      decision: estimate.decision,
      estimate: {
        low_usd: Number(estimate.low.toFixed(4)),
        likely_usd: Number(estimate.likely.toFixed(4)),
        high_usd: Number(estimate.high.toFixed(4)),
        currency: "USD",
      },
      breakdown: {
        parse_low_usd: Number(estimate.parseLow.toFixed(4)),
        parse_likely_usd: Number(estimate.parseLikely.toFixed(4)),
        parse_high_usd: Number(estimate.parseHigh.toFixed(4)),
        classify_usd: Number(estimate.classifyCost.toFixed(4)),
        extract_low_usd: Number(estimate.extractLow.toFixed(4)),
        extract_likely_usd: Number(estimate.extractLikely.toFixed(4)),
        extract_high_usd: Number(estimate.extractHigh.toFixed(4)),
        split_usd: Number(estimate.splitCost.toFixed(4)),
        split_low_usd: Number(estimate.splitLow.toFixed(4)),
        split_likely_usd: Number(estimate.splitLikely.toFixed(4)),
        split_high_usd: Number(estimate.splitHigh.toFixed(4)),
        edit_usd: Number(estimate.editCost.toFixed(4)),
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
      },
      assumptions_used: {
        ...(estimate.parseMode === "standalone" && estimate.parseModel === "legacy"
          ? { likely_complex_parse_share: estimate.parseLikelyComplexShare }
          : {}),
        ...(estimate.parseAdvancedChartCounts
          ? {
              advanced_chart_counts: {
                likely: estimate.parseAdvancedChartCounts.likely,
                maximum: estimate.parseAdvancedChartCounts.high,
              },
            }
          : {}),
        ...(input.pipeline.extractMode === "conditional"
          ? { likely_deep_extract_share: input.pipeline.deepShare }
          : {}),
      },
      rate_card: estimate.parseModel === "r-1" ? R1_RATE_CARD : RATE_CARD,
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
