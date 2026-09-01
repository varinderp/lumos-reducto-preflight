import type { PublicEstimateRequest } from "./pricing";

export const SIMULATOR_EXAMPLE_REQUEST = {
  documents: [
    { name: "data-room-01.pdf", pages: 100 },
    { name: "data-room-02.pdf", pages: 1_000 },
    { name: "data-room-03.pdf", pages: 100 },
    { name: "data-room-04.pdf", pages: 100 },
    { name: "data-room-05.pdf", pages: 1_000 },
  ],
  pipeline: {
    parse: null,
    classify: {
      page_range: { start: 1, end: 3 },
    },
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
      parsing: {
        settings: {
          page_range: { start: 6, end: 8 },
        },
      },
    },
    edit: {},
    lumos_assumptions: {
      conditional_extract_routing: true,
      likely_deep_extract_share: 0.4,
      estimated_extract_fields_per_page: 12,
      known_fully_prefilled_edit_pages: 20,
    },
  },
  policy: {
    max_total_usd: 100,
  },
} satisfies PublicEstimateRequest;
