# Lumos Spreadsheet Support Specification

Status: Deferred
Pricing source: Customer-provided Reducto rate card only

## 1. Purpose

Lumos may inspect spreadsheet files before Reducto processing and estimate their
usage without uploading them. Spreadsheet dollar estimates remain unavailable
until the developer supplies the applicable customer rate card.

Reducto measures spreadsheet usage by cells rather than ordinary document pages.
Its public pricing documentation does not publish a current spreadsheet dollar
rate and instructs customers to consult their rate card.

## 2. Official Reducto behavior

Supported spreadsheet formats include XLSX, XLSM, XLS, XLTX, XLTM, CSV, and QPW.

The Reducto configuration field is:

```json
{
  "spreadsheet": {
    "clustering": "accurate"
  }
}
```

Supported clustering values:

| Value | Reducto behavior |
| --- | --- |
| `accurate` | Default; model-assisted table-boundary detection for complex layouts |
| `fast` | Rule-based table detection using empty rows and columns |
| `disabled` | Treats each sheet as one table |

Reducto documents Accurate clustering as costing five times as much per cell as
Fast. The pricing page lists historical usage ratios but does not provide a
current public dollar rate. Lumos must therefore use the customer's actual rate
card.

After processing, Reducto may return the `billable_spreadsheet_pages` billing
tag, which represents spreadsheet billing derived from cell count. Lumos must
not fabricate this response tag during preflight estimation.

## 3. Local inspection

Spreadsheet inspection must occur entirely in browser memory. Lumos must not
upload the workbook to Reducto or a Lumos server during ordinary estimation.

For each workbook, Lumos may derive:

- File format and workbook size
- Sheet count and sheet visibility
- Non-empty cells per sheet
- Used-range rows, columns, and cells
- Formula-cell count
- Merged-range count
- Selected clustering mode
- Sheets excluded by the supplied Reducto configuration
- Inspection warnings and confidence

Lumos should retain both non-empty-cell and used-range counts because Reducto's
public documentation does not precisely define which local workbook cells will
become billable cells.

Files and derived measurements must be discarded when the estimate is cleared
or the browser session ends.

## 4. Usage range

Lumos must describe its values as locally observed cell estimates, not Reducto
billing facts.

Proposed fields:

```json
{
  "cell_estimate": {
    "low": 12500,
    "likely": 14800,
    "high": 17600,
    "basis": "local_workbook_inspection",
    "confidence": "medium"
  }
}
```

Suggested interpretation:

- `low`: cells clearly containing locally observable values or formulas
- `likely`: Lumos's best locally derived processed-cell estimate
- `high`: bounded workbook used-range cells that could reasonably be processed

If a reliable bound cannot be produced, the affected value must be `null`.
Lumos must explain which workbook features caused the uncertainty.

These bounds are Lumos estimation conventions, not documented Reducto billing
formulas.

## 5. Customer rate card

A dollar estimate requires an explicit rate for the selected clustering mode
and all applicable rounding, minimum, or downstream product rules.

Example Lumos-only input:

```json
{
  "customer_rate_card": {
    "id": "customer-reducto-2026",
    "currency": "USD",
    "spreadsheet": {
      "accurate": {
        "unit_size_cells": 1000,
        "price_per_unit": 0.00
      },
      "fast": {
        "unit_size_cells": 1000,
        "price_per_unit": 0.00
      },
      "disabled": {
        "unit_size_cells": 1000,
        "price_per_unit": 0.00
      }
    }
  }
}
```

The actual schema must also support any rate-card rounding, minimum charge,
effective date, and applicable Extract or Deep Extract charges. Lumos must not
assume that historical credit ratios define the customer's current dollar rate.

## 6. Estimate statuses

### `rate_card_required`

Use when local cells can be inspected but no applicable customer rate exists.

```json
{
  "status": "rate_card_required",
  "estimate_usd": null,
  "decision": "review"
}
```

### `needs_input`

Use when the workbook cannot be inspected reliably or a required rate-card rule
is missing.

### `estimated`

Use when local cell bounds and all applicable customer rates are available.

```json
{
  "status": "estimated",
  "estimate_usd": {
    "low": 1.25,
    "likely": 1.48,
    "high": 1.76
  },
  "has_range": true
}
```

A collapsed range remains an estimate until reconciled with Reducto's returned
usage.

### `unsupported_format`

Use when the browser inspector cannot safely read a Reducto-supported
spreadsheet format. The file may still be processable by Reducto, but Lumos
cannot estimate it locally.

## 7. Budget decisions

Lumos may return `allow` only when every spreadsheet charge has a complete rate
and the estimated high value is within the threshold.

It may return `deny` when the complete estimated low value exceeds the
threshold.

All incomplete, partially priced, or rate-card-required spreadsheet estimates
must return `review`.

For a mixed document batch:

- Show the priced non-spreadsheet amount as `known_non_spreadsheet_subtotal_usd`
- Show spreadsheet usage separately
- Keep the complete batch total `null`
- Never label the known subtotal as the total
- Never return `allow` while spreadsheet charges remain unresolved

## 8. Security requirements

- Inspect files in browser memory only
- Do not execute macros, formulas, scripts, or external workbook links
- Do not fetch linked workbook data
- Apply compressed-size, expanded-size, row, column, sheet, and cell limits
- Detect encrypted or malformed workbooks
- Protect against ZIP bombs and parser resource exhaustion
- Do not store filenames, workbook contents, or cell values in analytics
- Clear files and derived measurements with the browser session

## 9. Explicit non-goals

The first spreadsheet release will not:

- Invent a public spreadsheet dollar rate
- Convert legacy credits into current dollars
- Claim to reproduce Reducto's exact billable-cell calculation
- Execute formulas or macros
- Reproduce Reducto's Accurate clustering model locally
- Upload sample sheets to Reducto during ordinary estimation
- Generate `billable_spreadsheet_pages` before Reducto returns it
- Estimate downstream LLM, token, storage, or infrastructure costs
- Guarantee the final Reducto bill
- Automatically approve a job containing unresolved spreadsheet charges

## 10. Acceptance criteria

1. Spreadsheet uploads are never priced as ordinary pages.
2. The configuration accepts only `accurate`, `fast`, or `disabled`.
3. Missing customer pricing returns `rate_card_required`, null USD totals, and
   `review`.
4. Locally derived cell values are labeled as estimates.
5. Mixed batches never hide unresolved spreadsheet charges inside a partial
   total.
6. Customer rates are applied only to their declared clustering mode and
   effective period.
7. Encrypted, malformed, or locally unsupported workbooks do not receive
   guessed estimates.
8. No spreadsheet content leaves browser memory during ordinary estimation.
9. Actual Reducto usage can later be reconciled without treating Lumos's local
   counts as returned billing facts.

## 11. Official sources

- [Reducto usage and pricing](https://docs.reducto.ai/reference/credit-usage)
- [Spreadsheet processing configuration](https://docs.reducto.ai/configs/parse/spreadsheet)
- [Per-page billing breakdown](https://docs.reducto.ai/reference/page-billing-breakdown)
- [Supported upload formats](https://docs.reducto.ai/upload/overview)
