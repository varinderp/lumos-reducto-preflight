import { estimatePipeline, normalizeRequest, RATE_CARD, type PublicEstimateRequest } from "@/lib/pricing";

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
        edit_usd: Number(estimate.editCost.toFixed(4)),
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
      },
      assumptions_used: {
        ...(estimate.parseMode === "standalone"
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
      rate_card: RATE_CARD,
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
