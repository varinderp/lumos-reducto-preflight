# Lumos — Product Specification v0.16

Status: working prototype

Date: 2026-08-31

## 1. Product definition

Lumos is a preflight cost layer for a deployed Reducto pipeline. A developer
supplies document metadata, the billable operations in the pipeline, and any
explicit workload assumptions. Lumos returns either one estimate or a low,
likely, and high range plus an allow, review, or deny budget decision before paid
processing begins.

The product has two primary surfaces:

1. A browser simulator organized as **1. Documents**, **2. Pipeline
   configuration**, **3. Policy**, and **4. Estimate**. The pipeline section's
   **Set up manually** builder has endpoint tabs for Parse (standalone),
   Classify, Extract, Split, and Edit, while **Import from Reducto** accepts
   supported JSON operation configurations copied from the deployed pipeline.
   The simulator begins unconfigured and prices documents only after one of
   those inputs is applied successfully. The active endpoint pane scrolls
   within its fixed-height window and chains continued wheel or touch movement
   to the page at its boundaries; the tabs and Apply action remain visible.
2. `POST /api/estimate` for the same calculation inside an application's upload
   flow.

The page also has an optional paid verification action. With explicit approval,
it uploads real files to Reducto, runs a deployed `pipeline_id`, and returns the
usage fields Reducto provides. Verification is separate from estimation.

## 2. Scope and terminology

The first release estimates these Reducto products:

- Parse
- Classify
- Extract
- Deep Extract
- Split
- Deep Split
- Edit

Under the public list rates effective September 1, 2026, parsing is included in
Extract and Split pricing. Lumos therefore does not expose or add another parsing
line to those estimates.

In the visual builder, **Parse (standalone)** denotes a separately priced direct
Parse job and is mutually exclusive with Extract and Split. Classify and Edit
remain available alongside it because they are additive products. This is a
simulator interaction rule, not an API schema change: the public API continues
to accept bundled Parse with Extract or Split for compatibility.

Lumos has its own cost-profile schema because a deployed Reducto pipeline is run
with `input` and `pipeline_id`; the run request does not contain the Studio
pipeline definition. The profile follows two rules:

- Documented Reducto settings retain their documented names and nesting.
- Pipeline-wide derived or uncertain estimator values live under
  `lumos_assumptions`; an external API caller may put a document-specific
  routing assumption on its matching document record.

Examples of documented Reducto settings used by Lumos:

- Parse agentic modes: `parse.enhance.agentic`
- Parse page selection: `parse.settings.page_range`
- Parse batch queue: `parse.queue_priority: "batch"`
- Classify: `page_range: { start, end }`
- Deep Extract: `settings.deep_extract: true`
- Extract latency priority: `settings.optimize_for_latency: true`
- Extract image context: `settings.include_images: true`
- Deep Split: `settings.deep_split: true`
- Split page selection: `parsing.settings.page_range`

The visual builder keeps these Reducto-native fields within their owning
endpoint. It produces cost-focused configuration fragments for estimation; it
is not a replacement for the complete Reducto pipeline editor. Accepted
cost-neutral settings from imported configurations are retained separately for
review and reapplication.

Examples of Lumos-owned inputs:

- `documents[].assumed_extract_route`
- `lumos_assumptions.conditional_extract_routing`
- `lumos_assumptions.likely_deep_extract_share`
- `lumos_assumptions.estimated_extract_fields_per_page`
- `lumos_assumptions.known_fully_prefilled_edit_pages`
- `lumos_assumptions.likely_complex_parse_share`
- `lumos_assumptions.advanced_chart_counts`
- `lumos_assumptions.unpriced_cost_factors`

These inputs appear in a visibly separate **Additional inputs** area while
remaining serialized under `lumos_assumptions`. They must never be presented as
Reducto pipeline settings.

Billing tags such as `page`, `html_page`, `docx_native_page`, `agentic`,
`complex`, `chart_agent`, and `billable_spreadsheet_pages` are returned usage
data. They are not editable pipeline settings.

## 3. User promise

> Estimate Reducto costs before processing begins.

The result is an estimate, not a quote. When Classify or application logic may
choose either Standard or Deep Extract, Lumos presents:

- Low: every unknown document uses Standard Extract.
- Likely: the developer's expected share uses Deep Extract.
- High: every unknown document uses Deep Extract.

Standalone Parse also returns a range because Reducto identifies Standard and
Complex pages during processing. An equal low and high value is displayed as one
estimate. It does not make the preflight result an exact bill.

## 4. Primary flow

1. A user selects one or more documents.
2. Lumos estimates page counts in browser memory where practical.
3. Every count remains editable.
4. The developer configures cost-relevant Reducto fields in the five endpoint
   tabs ordered Parse (standalone), Classify, Extract, Split, and Edit, supplies
   visibly separate **Additional inputs** where needed, or imports operation
   JSON from Reducto. The tab order does not define pipeline execution order.
5. Lumos generates and applies a valid pipeline profile. Until then, Lumos shows
   no estimate.
6. The simulator derives each document's processing label from that pipeline;
   it does not ask for a separate per-document mode.
7. Any conditional Extract route stays unknown in the simulator, while an API
   caller may supply an explicit per-document routing assumption.
8. Lumos returns the cost estimate and budget decision.
9. The application approves, asks for review, or stops before calling Reducto.
10. After an approved production job, returned usage can be used for
   reconciliation.

Ordinary estimation does not call Reducto and does not incur a Reducto fee.

The simulator exposes only the four numbered section headings above. **1.
Documents** contains upload and editable page-count controls without a general
introductory paragraph or an always-visible spreadsheet warning; a spreadsheet
warning appears only when the selected input actually blocks estimation. **2.
Pipeline configuration** owns the manual/import inputs and the shared profile
copy action. **3. Policy** contains the `policy.max_total_usd` field labeled
**Maximum cost, USD** and the adjacent rate-card link. **4. Estimate** owns the
result without duplicating that link.

Editing an applied pipeline suppresses the estimate and announces the stale
state through the existing live status without a second ready-to-apply sentence.

## 5. Public rate-card snapshot

Lumos uses the published list rates effective September 1, 2026:

| Product | Published list rate |
| --- | ---: |
| Parse, Legacy Standard page | $15 / 1,000 pages |
| Parse, Legacy Complex page | $30 / 1,000 pages |
| Parse, Legacy agentic mode | 2× the applicable page rate |
| Parse, r‑1 Beta | $10 / 1,000 pages |
| Advanced Chart Agent | $0.06 per detected chart |
| Batch Parse | 20% usage discount on `/parse_async` with `queue_priority: "batch"` |
| Extract | $20 / 1,000 pages, parsing included |
| Deep Extract | $40 / 1,000 pages, parsing included |
| Extract latency priority | 2× the corresponding Extract rate |
| Split | $20 / 1,000 pages, parsing included |
| Deep Split | $40 / 1,000 pages, parsing included |
| Classify | $7.50 / 1,000 context pages; first five by default |
| Edit | $60 / 1,000 pages |
| Edit, fully prefilled page | $15 / 1,000 pages |

Legacy and non-Parse responses retain `reducto-public-2026-09-01`. An explicit
standalone r‑1 estimate returns `reducto-public-2026-09-01-r1-beta`.

Contract pricing may differ. The customer's contract and rate card remain the
source of truth.

### Simulator-only rate edits

The **Default rate card** or **Default rate card (custom)** link sits in **3.
Policy** beside the **Maximum cost, USD** control and opens an on-demand dialog
with all eleven numeric unit prices. **4. Estimate** does not repeat the link, and
the configuration footer contains only **Apply configuration**. Page prices
are edited as dollars per 1,000 pages, while Advanced Chart Agent is edited as
dollars per detected chart. The dialog marks the rates selected by the current
applied configuration.

Edits remain drafts until **Apply rates** is selected. Applied values replace
the corresponding built-in prices for simulator calculations during the current
browser session. Agentic Parse and Extract latency priority remain read-only 2x
multipliers, and Batch Parse remains a read-only 20% discount. Clearing or
refreshing the session restores the built-in rates.

Simulator rate edits are not part of the public request schema. The generated
API preview and `POST /api/estimate` continue to use the built-in public card,
and the UI identifies that separation whenever a custom simulator card is
active.

### Supported boundaries

- Legacy Parse remains the default at the current Standard/Complex rates. The
  pre-September 1 credit-based pricing model is not supported.
- r‑1 Parse is an opt-in Beta model for standalone Parse. It is priced at $10
  per 1,000 processed pages and supports page ranges plus the Batch Parse
  discount. Legacy Complex-page and Agentic multipliers do not apply to r‑1.
  r‑1 custom prompts, OCR return, and Advanced Chart retain the known base
  subtotal but make the estimate incomplete until their add-on pricing is
  modeled. Promptless Agentic scopes are rejected for r‑1 with guidance to
  remove them or choose Legacy.
- Extract profiles at 100 estimated fields per page are supported. Above 100,
  Lumos preserves the known page estimate and marks the unpublished dense-field
  surcharge as incomplete.
- Spreadsheet pricing is not guessed. Reducto measures spreadsheet usage from
  cells and directs customers to their own rate card, so Lumos returns an
  unsupported response until cell units and a rate are available. The deferred
  implementation is defined in `SPREADSHEET_SUPPORT_SPEC.md`.
- Advanced Chart Agent is priced for standalone Parse when chart-count bounds are
  supplied. Without them, the page estimate remains visible but incomplete. Per
  the product decision for this rate snapshot, the add-on is treated as included
  when Parse is bundled into Extract or Split.
- `settings.include_images: true` is documented as increasing Extract cost, but
  no numeric adjustment appears in the September 1 public list-rate table. The
  importer surfaces that omission, marks the dollar result incomplete, and
  prevents an `allow` decision.

## 6. Cost-profile request

```json
{
  "documents": [
    {
      "name": "contract.pdf",
      "pages": 18
    }
  ],
  "pipeline": {
    "parse": null,
    "classify": {
      "page_range": { "start": 1, "end": 5 }
    },
    "extract": {
      "settings": { "deep_extract": false, "optimize_for_latency": false, "include_images": false }
    },
    "split": null,
    "edit": null,
    "lumos_assumptions": {
      "conditional_extract_routing": false,
      "estimated_extract_fields_per_page": 24
    }
  },
  "policy": {
    "max_total_usd": 10
  }
}
```

`conditional_extract_routing` tells Lumos to model both Standard Extract and Deep
Extract outcomes. This field belongs to Lumos. When disabled, Lumos follows the
documented `settings.deep_extract` value. It is invalid to enable conditional
routing while explicitly selecting Deep Extract.

The public API also accepts the optional per-document
`assumed_extract_route`. An application may use `"standard"` or `"deep"` when
its own business logic already knows the route, or omit the field to preserve
the unknown conditional range. The browser simulator intentionally omits this
override: its visible processing labels come from the applied pipeline, and a
conditional configuration remains unknown before routing.

An Extract profile supplies a whole-number
`estimated_extract_fields_per_page` bound for the dense-field check. If it is
omitted, Lumos keeps the page estimate visible but marks the unpublished
field-density component incomplete.

For standalone Parse, `likely_complex_parse_share` defaults visibly to `0.5`.
When Advanced Chart Agent is enabled, `advanced_chart_counts` may supply
non-negative whole-number `likely` and `maximum` values, with `likely` no greater
than `maximum`. The low chart count is zero. If the counts are omitted, Lumos
returns the known page range with `estimate_complete: false`.

`queue_priority` accepts Reducto's `"auto"` and `"batch"` values. It is an
execution-time `/parse_async` choice, so a Studio operation configuration does
not establish it; developers add it to the standalone Parse section of the
Lumos profile when modeling batch work.

The request has no simulator rate-card field. Unknown top-level fields remain
invalid, including attempts to send browser-only rate overrides to the API.

A production server loads the copied profile from its own configuration store
and adds per-upload values before calling Lumos:

```js
const pipeline = await loadLumosProfileFromServerStorage();

const response = await fetch("https://your-lumos-site/api/estimate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    documents: uploadedDocuments.map(({ name, pages }) => ({ name, pages })),
    pipeline,
    policy: { max_total_usd: 10 },
  }),
});
```

### Endpoint reference

`POST /api/estimate` receives document metadata only, never document files or
their contents. Its request fields are:

| Field | Required | Meaning |
| --- | --- | --- |
| `documents` | Yes | An array of metadata rows. Each item contains the original filename in `name` and its page count in `pages`; file contents are not accepted. |
| `pipeline` | Yes | The Lumos profile generated after the simulator applies a configuration, whether it was set up manually or imported from Reducto. The application stores this profile. |
| `policy.max_total_usd` | No | The maximum acceptable job cost in USD. It defaults to `10` when omitted. |

**Copy Lumos profile** sits in a shared action row beneath the simulator's manual
and import panels. It is available only for a clean, valid applied
configuration. Manual setup and Reducto imports are both converted to the same
canonical `PublicPipeline`; the action copies only that profile, excluding
documents, policy, simulator-only rate edits, and preserved raw Reducto JSON.
Lumos does not host profiles, issue profile IDs, or persist copied profiles; the
integrating application owns profile storage.

The response supplies estimates, operation breakdown, usage, and an `allow`,
`review`, or `deny` decision. A production deployment protects the call as an
authenticated server-to-server integration. The API contract, bundled Parse
compatibility, pricing behavior, and strict Lumos profile schema remain
unchanged.

After a configuration is applied, the API section shows a collapsed **View this
simulator's API request and response** disclosure. Expanding it reveals
**Request preview** and **Response preview** without a duplicate profile-copy
action. Dirty, invalid, unconfigured, and cleared states hide the disclosure.

## 7. Reducto JSON configuration import

### 7.1 Purpose and interaction

The **Pipeline configuration** area has two inputs for the same Lumos cost
profile:

1. **Set up manually** builds cost-focused endpoint fragments
   with visual controls.
2. **Import from Reducto** imports operation configurations copied from the
   Reducto pipeline.

The manual helper reads: **Standard Extract is selected as an example. Apply the
configuration to use it.** Document totals appear above the configurator. The
fixed-height workspace has five endpoint tabs in this navigation order: Parse
(standalone), Classify, Extract, Split, and Edit. Every tab displays the
endpoint's On/Off status. Only the active endpoint pane scrolls; at its top and
bottom boundaries, continued wheel or touch movement scrolls the outer page.
The endpoint tab strip and **Apply configuration** stay visible. This navigation
order does not define pipeline execution order.

Redundant settings subheadings are omitted. Estimator-owned values appear under
**Additional inputs**, while their JSON namespace remains `lumos_assumptions`:

- **Parse (standalone)** begins with a Legacy / r‑1 (Beta) model selector. The
  r‑1 choice carries a linked **New** label that opens Reducto's announcement.
  Legacy exposes agentic Text, Table, and Figure scopes; Advanced Chart Agent
  under Figure; `queue_priority`; and `settings.page_range`. Its assumptions
  are expected Complex-page share and, when needed, likely and maximum chart
  counts. r‑1 keeps queue priority and page range, but hides Legacy-only
  complexity and Agentic controls.
- **Classify** exposes its context `page_range` and has no estimator assumption.
- **Extract** is described as **Return structured fields from the document,
  parsing included.** It exposes `settings.include_images`,
  `settings.optimize_for_latency`, `settings.deep_extract`, and its page range.
  Its assumptions are conditional Standard/Deep routing, expected Deep Extract
  share, and expected fields per page.
- **Split** is described as **Separate a document into sections and partitions,
  parsing included.** It exposes `settings.deep_split` and
  `parsing.settings.page_range` and has no estimator assumption.
- **Edit** enables the endpoint and keeps known fully prefilled pages in its
  Additional inputs area. Its visible note is **Edit is priced separately and
  added to the estimate.** It is an additive line item at the built-in
  rates of $60 per 1,000 pages or $15 per 1,000 known fully prefilled pages;
  applied session-only simulator rates may replace those values.

The manual surface deliberately covers fields that affect the current cost
model. It generates Reducto-shaped, cost-focused fragments rather than complete
deployable endpoint configurations. Full Extract schemas, Parse formatting and
retrieval options, Split descriptions, and other cost-neutral authoring remain
available through import and are not recreated by the manual editor.

The manual UI prevents **Parse (standalone)** from being enabled with Extract or
Split and preserves its entered values while it is off. Classify and Edit remain
additive and may be enabled alongside it. Imported Parse plus Extract or Split
profiles remain supported: imported Parse JSON is preserved, the review builder
represents parsing as included downstream rather than enabling the standalone
tab, and any applicable Parse page range is transferred to a downstream
operation that lacks its own range. Reapplication remains cost-equivalent.
Extract and Split retain independent ranges. The public API continues to accept
its existing bundled-Parse profile shape.

The import path is a browser-only convenience layer and does not call Reducto.
It previews the inferred operations, generated Lumos profile, and any warnings
before the user applies it. Each fully validated operation also receives a safe,
deep-cloned per-endpoint review copy. This preserves accepted cost-neutral JSON
and exact cost fields without merging endpoint-local nested Parse settings.
Studio Split aliases remain visible in the imported copy while pricing uses the
normalized canonical profile.

Both inputs use **Apply configuration**. A successful import shows
**Configuration applied**, and **Review setup** opens **Set up manually** with
mapped cost fields hydrated in its endpoint panes. Imported
cost-neutral fields remain preserved but are not presented as editable Lumos
assumptions or added to the public estimate request. The generated Lumos profile
is available from the shared **Copy Lumos profile** action and remains visible
inside the collapsed API **Request preview**.

A successful import replaces the entire applied pipeline profile. It starts from
a neutral profile, enables only operations established by the pasted
configurations, and sets every other operation to `null`. It must never
shallow-merge into the prior profile. This prevents a previous Classify, Split,
or Edit setting from surviving an Extract-only import. Uploaded document rows,
edited page counts, and the budget remain unchanged.

### 7.2 Accepted JSON and operation inference

The importer accepts:

- one top-level JSON object;
- two or more top-level JSON objects placed next to one another and separated by
  whitespace; or
- an array of top-level configuration objects.

Each object represents the configuration copied from one operation inside the
Reducto pipeline. A user with Parse followed by Extract pastes both operation
configurations. The importer combines the detected operations into one Lumos
profile while retaining the boundary between their settings. It also preserves
each accepted raw endpoint object for review, including cost-neutral fields that
the cost-focused builder does not edit. The Lumos profile is then represented by
the populated visual builder rather than an editable canonical JSON surface.

Lumos infers Parse, Extract, Split, Classify, and Edit from documented,
operation-specific keys. A generic object whose operation cannot be determined
unambiguously must be rejected rather than assigned the cheapest operation.

Supported pricing mappings include:

| Reducto JSON configuration | Generated Lumos profile | Meaning |
| --- | --- | --- |
| Parse configuration | `parse` is present | Standalone Parse unless Extract or Split is also present |
| nonempty `enhance.agentic` | `parse.enhance.agentic` | Apply the standalone Parse agentic multiplier |
| `advanced_chart_agent: true` | Parse chart mode plus an incomplete chart factor until counts are supplied | Price detected charts only from explicit `lumos_assumptions` inputs |
| Extract `instructions.schema` | `extract` is present | Standard Extract unless Deep Extract is explicitly enabled |
| `settings.deep_extract: true` | `extract.settings.deep_extract: true` | Deep Extract |
| `settings.deep_extract: false` or omitted | `extract.settings.deep_extract: false` | Standard Extract |
| `settings.optimize_for_latency: true` | `extract.settings.optimize_for_latency: true` | Apply Reducto's documented 2× Extract cost |
| `settings.include_images: true` | `extract.settings.include_images: true` plus an unpriced Lumos factor | Preserve the setting and require review for its unquantified increase |
| Classify configuration with `page_range` | `classify.page_range` | Price Classify context pages |
| Split configuration | `split` is present | Standard Split unless Deep Split is enabled |
| `settings.deep_split: true` | `split.settings.deep_split: true` | Current documented Deep Split setting |
| top-level `deep_split` and `split_options` | `split.settings.deep_split` and Split presence | Studio compatibility shape normalized to the documented Lumos profile |
| Edit operation configuration | `edit` is present | Price Edit pages |
| bounded `instructions.schema` | `lumos_assumptions.estimated_extract_fields_per_page` | Conservative static leaf-field bound for density validation |

The current official Deep Split shape is `settings.deep_split`. Reducto Studio
may supply `deep_split` and `split_options` at the top level; Lumos accepts that
shape as compatibility input, warns about normalization, and stores the mode at
`split.settings.deep_split`.

A Parse object is inferred from documented Parse groups and settings such as
`enhance`, `formatting`, `retrieval`, and Parse-specific `settings`. The common
default `spreadsheet` group may also appear on that object, but it is not proof
that the uploaded document is a spreadsheet.

Paste Parse alongside Extract or Split so Lumos can account for Parse page
ranges and other cost-relevant Parse options within the downstream operation.
Lumos does not add a separate Parse line because the current Extract and Split
prices include parsing. A standalone Legacy Parse configuration receives a
Standard/Complex estimate range. A standalone r‑1 configuration receives the
known $10-per-1,000-pages subtotal and the r‑1 Beta rate-card identifier.

Imported standalone Parse JSON with `settings.model: "r-1"` selects r‑1.
Missing `settings.model` is treated as Legacy and produces a short import notice
so existing profiles remain unchanged. `settings.model: "legacy"` is also
accepted explicitly. Bundled Parse continues to use downstream pricing and is
not switched to a separately priced r‑1 job.

If standalone Parse enables Advanced Chart Agent without chart-count assumptions,
Lumos records `parse.advanced_chart_count`. The Standard/Complex page estimate
remains visible and the result requires review. When the same Parse configuration
is bundled into Extract or Split, agentic work, complexity, and Advanced Chart
Agent do not add a separate Parse charge under this rate snapshot.

Page numbers are 1-indexed and inclusive. Overlapping ranges count once, and a
range ending past the uploaded document stops at its last page. Multiple
conflicting non-null range locations for the same operation are blocked rather
than selecting the smaller workload. Nested Extract and Split Parse settings
remain isolated to their owning operation; a separate top-level Parse step may
feed both.

Current `include_images: true` produces a visible warning because Reducto says
it increases cost without publishing a numeric adjustment in the September 1
list-rate table. The normalized profile preserves the setting and records the
factor under `lumos_assumptions.unpriced_cost_factors`; the known base estimate
remains visible, but the policy result cannot be `allow`.

The number of static leaf definitions is knowable only for a bounded JSON
schema. It is a conservative input, not a prediction of which page will produce
each field. Arrays, `additionalProperties`, an omitted schema, and other
unbounded shapes record `extract.field_density` as an unpriced cost factor and
require review rather than claiming exact density.

### 7.3 Browser and parsing safety

JSON import runs entirely in browser memory. Lumos must:

- split adjacent top-level values with a structure-aware JSON scanner;
- accept only objects or arrays of objects as operation configurations;
- parse every value as JSON data without executing any pasted content;
- never follow paths, URLs, references, or credential-shaped values found in
  the configuration;
- never send the pasted configuration or inferred profile to Reducto;
- never persist pasted configuration in browser storage or server logs; and
- keep the previously applied profile unchanged until a complete import passes
  validation and the user applies it.

Malformed JSON, scalar top-level values, ambiguous operation identity,
conflicting operation settings, duplicate incompatible configurations, unknown
cost-relevant structures, and invalid pricing value types fail closed. A failed
import returns no estimate and leaves the applied profile unchanged. Ambiguity
inside an otherwise valid static schema may instead produce an applicable,
incomplete estimate and `review` through `extract.field_density`.

### 7.4 Blocks, cautions, and incomplete estimates

The importer must block these cases instead of inventing a profile:

- **Operation cannot be inferred:** a generic settings object without enough
  documented operation-specific context cannot establish a billable product.
- **Conflicting configuration:** incompatible duplicate operation objects or
  multiple non-null page selections cannot be resolved by choosing the cheaper
  interpretation.
- **Spreadsheet input:** an uploaded spreadsheet filename or document metadata
  identifying spreadsheet input enters the existing unsupported state. Reducto
  measures this work from cells and directs customers to their own rate card, so
  a page-based dollar estimate is invalid.

Every `spreadsheet` group is informational rather than proof of spreadsheet
input, even when settings such as `split_large_tables.enabled` are true.
Studio-generated Parse configurations may include that group for ordinary
documents, and per-operation configuration contains no input file. The importer
may show a nonblocking caution, but only an uploaded spreadsheet filename or
document metadata identifying spreadsheet input enters the spreadsheet
unsupported state.

Documented settings with an unquantified charge, such as Extract image context,
remain applicable only as incomplete estimates. Lumos shows the known base,
records the missing factor, and returns `review` unless that known base already
exceeds the budget, in which case it returns `deny`.

Configuration compatibility and billing are separate concerns. Accepting a
Studio compatibility shape must never change Lumos from its explicit September
1, 2026 rate-card snapshot.

## 8. Calculation rules

For each request, Lumos must:

1. Validate page counts and route assumptions.
2. Reject spreadsheet page-price guesses.
3. Validate that a Classify `page_range` contains whole, 1-indexed page numbers
   and covers one to ten pages, following Reducto's Classify configuration guide.
4. Count each PDF range inclusively and stop at the document's last page. For
   non-PDF documents, ignore `page_range` and use the documented default context
   of the first five available pages.
5. When Extract has a normalized `settings.page_range`, price the union of its
   inclusive ranges, stop each range at the document's last page, and reject a
   selection that contains no page in a document.
6. When Split has `parsing.settings.page_range`, apply the same inclusive union,
   end-capping, and empty-selection rules to the priced Split pages.
7. When a bundled `parse.settings.page_range` is supplied directly, apply it to
   the downstream Extract and/or Split priced pages and reject conflicting
   endpoint-owned selections.
8. For standalone Parse, price the low bound with all Standard pages, the high
   bound with all Complex pages, and the likely value from
   `likely_complex_parse_share`, defaulting to 50%.
9. Multiply the standalone Parse page component by two when any agentic mode is
   configured.
10. When Advanced Chart Agent is enabled, add $0.06 for each supplied likely and
   maximum chart count, using zero for the low count. Without counts, keep the
   page estimate visible and mark the chart component incomplete.
11. Apply the 20% discount only to standalone `/parse_async` work explicitly
    marked with `queue_priority: "batch"`.
12. Price Standard or Deep Extract from the configured branch.
13. Multiply the Extract amount by two when
   `settings.optimize_for_latency: true`.
14. When routing is conditional, calculate all three branch scenarios.
15. Price Standard or Deep Split from `settings.deep_split`.
16. Price Edit pages and apply the lower rate only to a supplied number of known
   fully prefilled pages.
17. Sum independently billed products without adding bundled parsing.
18. Compare the low and high values with the USD policy.
19. When an imported setting has a documented but unquantified charge, label the
    estimate incomplete and return `review` unless the known base already exceeds
    the budget, in which case return `deny`.

Budget decisions:

```text
allow  = high estimate is within the limit
deny   = low estimate is above the limit
review = the limit falls inside the range
```

Example for a 100-page document classified from the first five pages and then
sent to Standard Extract:

```text
Classify: 5 × $7.50 / 1,000 = $0.0375
Extract: 100 × $20 / 1,000 = $2.00
Total: $2.0375
```

## 9. Estimate response

The API returns:

- `decision`
- `estimate.low_usd`
- `estimate.likely_usd`
- `estimate.high_usd`
- `breakdown` for Parse, Classify, Extract, Split, and Edit
- document, total-page, priced Parse-page, priced Classify-page, priced
  Extract-page, and priced Split-page usage
- `assumptions_used` for active Parse, chart, and conditional-routing assumptions
- `rate_card`
- `has_range`
- `estimate_complete`
- `unpriced_cost_factors`

No field should claim that an estimate is exact before the pipeline runs.
Unknown request, document, pipeline, operation, settings, and Lumos-assumption
fields are rejected at the API boundary instead of being ignored.

## 10. Files and retention

- Selected files stay in browser memory during ordinary simulation.
- Draft and applied simulator rate values stay in page state only. They are not
  written into pipeline JSON, browser storage, uploaded files, or API requests.
- Pasted Reducto JSON configurations and import previews stay in browser memory
  and are cleared with page state.
- The initial simulator has no applied pipeline and therefore no estimate.
- Dirty, invalid, and unconfigured pipeline states suppress both the simulator
  result and its collapsed API request/response disclosure until a valid
  profile is applied.
- Document processing labels are derived from the applied configuration; the
  simulator neither displays a route selector nor sends
  `assumed_extract_route` in its estimate request.
- Page detection is best effort and every count is editable.
- Lumos does not use browser storage for document content.
- Clearing the session removes selected files and results from page state.
- The optional verification request does not persist the API key, files, or
  extracted contents in Lumos.
- Files intentionally sent through verification are then governed by Reducto's
  retention and billing terms.

Supported upload types in the current interface are a documented subset of
Reducto formats: PDF, PNG, JPEG, GIF, HEIC, BMP, DOC, DOCX, PPT, PPTX, XLS,
XLSX, and CSV. Spreadsheet uploads are recognized but not assigned a public
dollar estimate.

## 11. Paid verification

Verification must:

- require a Reducto API key and deployed `pipeline_id`;
- require an explicit acknowledgement that paid processing will begin;
- upload each real file to Reducto;
- call the documented Pipeline endpoint with `input` and `pipeline_id`;
- return job IDs and usage only;
- omit extracted document contents;
- clear the browser's API-key state after a successful run.

Reducto pipeline responses may contain nested results for the operations that ran.
Those returned results are real response data and are separate from the Lumos
cost-profile input.

## 12. Acceptance criteria

1. No removed or invented parsing option appears in the simulator, API schema,
   response, tests, README, or specification.
2. The default profile uses documented `page_range`, `deep_extract`, and
   `deep_split` names where applicable.
3. Every non-Reducto value appears under **Additional inputs** while remaining
   serialized inside `lumos_assumptions`.
4. Standard and Deep Extract calculations match the September 1 list rates.
5. Standard and Deep Split calculations match the September 1 list rates.
6. Classify rejects ranges longer than Reducto's documented limit of ten pages.
7. Spreadsheet inputs return an unsupported error rather than a page-based
   dollar value.
8. Parsing is never added on top of Extract or Split.
9. Equal bounds are reported with `has_range: false`, not as an exact bill.
10. Paid verification cannot run without explicit confirmation.
11. A successful JSON configuration import replaces the full pipeline profile
    and cannot retain an omitted operation from a previous profile.
12. One or more adjacent JSON objects, or an array of objects, are parsed as data
    in browser memory and are never executed.
13. Extract and `settings.deep_extract` import to Standard and Deep Extract
    respectively, and supported page ranges change the matching Extract and
    Split priced-page sets.
14. `settings.optimize_for_latency: true` doubles the modeled Extract cost, while
    `include_images: true` produces an incomplete estimate that cannot return
    `allow`.
15. Array, schemaless, and otherwise unbounded Extract schemas also produce an
    incomplete estimate that cannot return `allow`.
16. Malformed JSON, ambiguous operations, conflicting settings, and unknown
    cost-relevant structures fail closed with no estimate, while ambiguous static
    schemas may apply with `extract.field_density` and `review`.
17. Standalone Parse returns Standard/Complex low, likely, and high values,
    applying agentic, chart-count, and batch settings only where documented.
18. Parse configurations can accompany Extract or Split without adding a
    separate Parse, agentic, complexity, or chart charge.
19. `settings.deep_split` is canonical, and top-level `deep_split` plus
    `split_options` is accepted only as a clearly labeled Studio compatibility
    shape.
20. Spreadsheet inputs remain unsupported rather than receiving a page-based
    price, while any `spreadsheet` configuration group alone stays informational.
21. Exactly 100 Extract fields remains complete, while more than 100 keeps the
    known page estimate visible and marks the dense surcharge incomplete.
22. A chart-enabled standalone Parse without chart counts still returns its
    known page estimate with `estimate_complete: false`.
23. A direct Extract profile without a field-density bound remains numeric but
    incomplete, and an older bundled Parse range is transferred to downstream
    operations that otherwise have no range before builder reapplication.
24. The simulator starts unconfigured, and uploading documents alone cannot
    produce an estimate. Applying a valid configuration enables pricing; dirty
    or invalid edits pause it, and clearing the session returns to the
    unconfigured state.
25. Simulator document rows have no manual Extract-route selector or
    `assumed_extract_route` request field. Their visible processing labels come
    from the applied pipeline, while the public API continues to accept the
    optional per-document routing override.
26. The simulator rate card displays all eleven unit prices, applies valid edits
    atomically, and restores the public values when the session is cleared.
27. Invalid, blank, negative, non-finite, scientific-notation, or range-inverting
    rate edits leave the previously applied simulator rates unchanged.
28. Custom simulator rates can change the estimate and budget decision without
    changing the API request, public API calculation, or response rate-card ID.
29. The visual builder maps every enabled operation to a valid canonical object
    and every disabled operation to `null`; simulator users never enter boolean
    operation values or see object-shape validation errors.
30. Reviewing and reapplying an imported configuration preserves exact supported
    cost fields, page ranges, incomplete-cost factors, and accepted cost-neutral
    endpoint JSON, while the public API continues to reject boolean operation
    values.
31. The visual builder renders Parse (standalone), Classify, Extract, Split, and
    Edit in that exact order with On/Off status; only the active pane scrolls,
    continued wheel or touch movement chains to the page at its boundaries, and
    the tab strip plus Apply configuration action remain visible.
32. Every pane keeps actual Reducto settings in their owning endpoint and keeps
    estimator-owned values in a visibly separate **Additional inputs** area.
33. The manual builder produces cost-focused fragments rather than claiming to
    replace complete Reducto endpoint configuration, and imported neutral fields
    remain preserved for review.
34. The builder revision does not change the public API request, response,
    built-in rate-card behavior, or spreadsheet unsupported boundary.
35. Parse (standalone) is mutually exclusive with Extract and Split in the
    visual builder while retaining its inactive values; Classify and Edit remain
    additive, and imported or API-supplied bundled Parse profiles remain
    accepted and cost-equivalent.
36. Edit is shown and calculated as a separate line item at the applicable
    built-in or session-only custom rate.
37. **Copy Lumos profile** appears in the shared pipeline-configuration action
    row only for a clean, valid applied configuration, copies exactly the
    generated Lumos profile, and reports accessible success or failure
    without copying documents, policy, simulator rates, or raw imported JSON.
38. The API section starts with `POST /api/estimate`, a compact request-field
    table, the fail-closed JavaScript example, a concise response summary, and a
    server-to-server authentication warning; it does not render the former
    three-step integration guide.
39. The simulator renders **1. Documents**, **2. Pipeline configuration**, **3.
    Policy**, and **4. Estimate** in order; Policy contains the **Maximum cost,
    USD** field and the single Default/custom rate-card link, while Estimate and
    the configuration footer contain no duplicate rate-card action.
40. A clean applied configuration exposes one collapsed **View this simulator's
    API request and response** disclosure containing **Request preview** and
    **Response preview** and no duplicate profile-copy action.
41. The UI uses **Set up manually** and **Additional inputs**, omits redundant
    settings subheadings and ready-to-apply copy, and retains an accessible live
    stale-estimate status.
42. Spreadsheet pricing, the API contract, estimator calculations, pricing
    behavior, importer behavior, and policy decisions remain unchanged.
43. Missing or explicit `legacy` standalone Parse profiles preserve the prior
    Standard/Complex estimates and the existing public rate-card identifier.
44. Explicit `r-1` standalone Parse profiles use $10 per 1,000 processed pages,
    honor page ranges and Batch discount, ignore Legacy complexity and Agentic
    multipliers, and return the r‑1 Beta rate-card identifier.
45. r‑1 custom prompts, OCR return, or Advanced Chart preserve the known base
    subtotal but make the estimate incomplete with the excluded feature named;
    promptless r‑1 Agentic scopes are rejected with corrective guidance.
46. The footer version is an accessible disclosure, collapsed by default, whose
    v0.1.33 note reads exactly **Added r‑1 Beta pricing.**

## 13. Official sources

- https://docs.reducto.ai/reference/credit-usage
- https://docs.reducto.ai/reference/pricing-migration
- https://reducto.ai/blog/parse-r-1-model
- https://docs.reducto.ai/configs/classify/configuration
- https://docs.reducto.ai/configs/extract/deep-extract
- https://docs.reducto.ai/extract/overview
- https://docs.reducto.ai/configs/parse/page-ranges
- https://docs.reducto.ai/configs/parse/chart-extraction
- https://docs.reducto.ai/workflows/batch-queue
- https://docs.reducto.ai/v/legacy/migration-guide
- https://docs.reducto.ai/extract/response-format
- https://docs.reducto.ai/configs/split/deep-split
- https://docs.reducto.ai/api-reference/edit
- https://docs.reducto.ai/reference/page-billing-breakdown
- https://docs.reducto.ai/workflows/pipeline-basics
- https://docs.reducto.ai/upload/overview
