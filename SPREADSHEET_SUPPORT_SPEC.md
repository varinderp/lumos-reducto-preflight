# Lumos Spreadsheet Support Specification

Status: implemented in v0.1.35
Pricing sources: [Reducto usage and pricing](https://docs.reducto.ai/reference/credit-usage) and [spreadsheet configuration](https://docs.reducto.ai/configs/parse/spreadsheet)

## 1. Purpose

Lumos estimates spreadsheet usage from a user- or application-supplied count of
expected non-empty cells. It does not open, parse, inspect, or upload workbook
contents during estimation, and it never treats spreadsheet files as ordinary
pages.

Reducto documents spreadsheet usage in credits rather than a universal dollar
price. Lumos therefore uses `$0.01 / credit` as an explicit Lumos default and
advises customers to consult their Reducto rate card.

## 2. Request metadata

The `documents` array accepts two mutually exclusive shapes:

```json
{
  "name": "contract.pdf",
  "pages": 18
}
```

```json
{
  "name": "model.xlsx",
  "estimated_non_empty_cells": 100000
}
```

`estimated_non_empty_cells` is optional. A missing count is valid, but the
spreadsheet contribution is excluded and the estimate is marked incomplete. A
zero count contributes zero credits and does not by itself make the estimate
incomplete. Supplied counts must be finite, safe, nonnegative whole numbers.

Spreadsheet identity comes only from the original filename. Lumos recognizes
XLS, XLSX, XLSM, XLTX, XLTM, CSV, and QPW case-insensitively, including URLs
whose path ends in one of those extensions. A `spreadsheet` settings object by
itself does not classify a file as a spreadsheet.

## 3. Configuration

Standalone Parse uses Reducto's top-level spreadsheet group:

```json
{
  "parse": {
    "spreadsheet": {
      "clustering": "accurate",
      "max_cell_count": 200000
    }
  }
}
```

Extract and Split retain the same group under their nested Parse settings:

```json
{
  "extract": {
    "parsing": {
      "spreadsheet": {
        "clustering": "fast",
        "max_cell_count": 200000
      }
    }
  }
}
```

`clustering` accepts `accurate`, `fast`, or `disabled` and defaults to
`accurate` when omitted. `max_cell_count` is an optional Reducto safety limit;
it is never used as an estimated count. If a supplied estimate exceeds an
applicable limit, Lumos rejects the request because Reducto would reject the
workbook before processing.

Imported cost-neutral spreadsheet fields such as `include`, `exclude`, and
`split_large_tables` remain available for review and reapplication, but they do
not change Lumos's current calculation.

## 4. Calculation

Lumos prorates partial credits without rounding:

| Clustering | Usage | Lumos default USD calculation |
| --- | ---: | ---: |
| Accurate | 1 credit / 1,000 cells | `(cells / 1,000) × $0.01` |
| Fast | 1 credit / 5,000 cells | `(cells / 5,000) × $0.01` |
| Disabled | 1 credit / 5,000 cells | `(cells / 5,000) × $0.01` |

Examples:

- 100,000 Accurate cells = 100 credits = `$1.00`.
- 100,000 Fast or Disabled cells = 20 credits = `$0.20`.
- 1,500 Accurate cells = 1.5 credits = `$0.015`.

For a Parse or Extract estimate, the spreadsheet cell amount is charged once.
Spreadsheet rows are excluded from page counts, page ranges, Legacy complexity,
Agentic and latency multipliers, Batch discounts, conditional or Deep Extract
rates, Classify pages, Split pages, and Edit pages. Ordinary files in the same
request retain their existing page calculations.

Spreadsheet contributions from Split, Classify, Edit, OCR data return,
prompted blocks or custom regions, and Advanced Chart remain unpriced until
their billing behavior is confirmed. If any of those operations are selected,
Lumos returns the known subtotal and identifies the excluded factor instead of
guessing. Chart-count assumptions in a mixed batch apply to the ordinary
documents; the spreadsheet chart contribution remains excluded.

For Extract with `processing_context.extract_input: "jobid"`, Lumos keeps the
cell-based Extract base while suppressing nested parsing add-ons already billed
on the original Parse job. This matches the existing treatment of ordinary
Extract base pricing. For Split `jobid` reuse, the Parse base is already billed;
only the unpriced spreadsheet Split contribution remains for review.

## 5. Simulator

- Each spreadsheet row exposes **Estimated non-empty cells** instead of pages.
- Page totals and spreadsheet cell and credit totals are shown separately.
- Parse and Extract expose compact spreadsheet clustering and safety-limit
  settings when spreadsheet input or imported spreadsheet settings are present.
- The rate card includes **Spreadsheet credit (Lumos default)** at
  `$0.01 / credit`.
- A custom spreadsheet credit rate changes simulator calculations only and
  remains in page state for the current browser session.
- The generated API preview always uses the Lumos default `$0.01 / credit`.
- Reset, Cancel, Apply, and Clear session follow the same atomic rate-card
  behavior as every other simulator rate.

No spreadsheet library or workbook-inspection path is included.

## 6. API response

For requests containing spreadsheet filenames, `POST /api/estimate` adds:

- `breakdown.spreadsheet_usd`;
- `usage.spreadsheets.documents`;
- `usage.spreadsheets.estimated_non_empty_cells`;
- `usage.spreadsheets.documents_missing_cell_count`;
- `usage.spreadsheets.credits`;
- `usage.spreadsheets.clustering`;
- `usage.spreadsheets.max_cell_count`;
- `usage.spreadsheets.base_endpoint`; and
- `spreadsheet_rate_basis`, which reports `$0.01 / credit` as a Lumos default
  and tells the caller to consult its Reducto rate card.

These fields are omitted from responses that contain no spreadsheet input.
Existing page-pricing rate-card identifiers remain unchanged.

## 7. Completeness and policy

Missing cell counts and unpriced spreadsheet factors set
`estimate_complete: false`. The known subtotal remains numeric.

```text
deny   = known low subtotal exceeds the budget
review = an excluded spreadsheet cost remains, or the budget falls in a range
allow  = the estimate is complete and its high value is within the budget
```

An incomplete spreadsheet estimate can therefore return `deny`, but never
`allow`.

## 8. Privacy and non-goals

- Lumos receives metadata, not workbook contents, through the estimate API.
- The simulator keeps selected files and entered counts in browser memory.
- Lumos does not execute formulas, macros, scripts, or external links.
- Lumos does not infer non-empty-cell counts from `max_cell_count`.
- Lumos does not claim that `$0.01 / credit` is every customer's price.
- Lumos does not price unresolved spreadsheet contributions for Split,
  Classify, Edit, OCR, prompted processing, or charts.
- Lumos does not guarantee the final Reducto bill.

## 9. Acceptance criteria

1. All seven supported extensions use cell metadata and never page pricing.
2. Accurate, Fast, and Disabled calculations match the documented credit ratios
   and prorate partial credits.
3. Missing counts return the known subtotal as incomplete.
4. Known counts above `max_cell_count` fail validation, while the limit never
   becomes the estimated count.
5. Parse or Extract charges the spreadsheet base once, including mixed batches.
6. Ordinary document calculations remain compatible at the API boundary and
   numerically identical in the estimator.
7. Unpriced spreadsheet operations preserve the known subtotal and require
   review unless the known subtotal already requires deny.
8. Custom simulator rates cannot enter the API request or change its default
   calculation.
9. Imported settings hydrate the builder and survive profile copying without
   treating configuration alone as spreadsheet input.
10. No workbook parsing or upload is performed during estimation.
