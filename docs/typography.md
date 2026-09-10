---
title: Interface typography
description: Maintain readable type, controls, and supporting text across themes and screens.
---

# Interface typography

Use the shared `--hq-text-*` roles from `src/workspace.css` instead of one-off pixel sizes. The scale is relative to the browser's root font preference; do not fix the root size or simulate readable text by zooming the application.

| Role | Size | Use |
| --- | --- | --- |
| Caption | 0.75rem | Eyebrows, compact status labels, event timestamps |
| Metadata | 0.8125rem | Attribution, secondary facts, identifiers |
| Supporting copy | 0.875rem | Field help, detail descriptions, form labels |
| Interface copy | 0.9375rem | Activity descriptions, navigation, ordinary controls |
| Body | 1rem | Default text, item titles, mobile text inputs |
| Section heading | 1.125rem | Goal objectives and section headings |

Tailwind's `text-xs`, `text-sm`, and `text-base` utilities map to metadata, interface, and body roles in `src/index.css`, so shared shadcn controls follow the same scale. Geist Sans remains the reading face; use Geist Mono for short identifiers and timestamps, not paragraphs.

Keep Activity descriptions and event titles the same size on desktop and mobile. Preserve their complete text, wrapping long identifiers instead of truncating descriptions or goals. Let narrow form rows stack and navigation scroll rather than reducing text to fit. Pair larger copy with comfortable line height, and preserve visible keyboard focus.

The typography browser checks cover both themes, narrow layouts, exact goal and description text, keyboard dialogs, and an enlarged root font. They complement the full form and accessibility suites.

## Status and visual hierarchy

Use the shared status icons and badges to pair a readable label with a semantic color: green for successful results, red for failures, amber for warnings or overdue checks, blue for information or activity, and neutral for unknown, disabled, or unobserved states. Colors use the `--hq-success`, `--hq-danger`, `--hq-warning`, and `--hq-info` theme families. Do not use color alone to convey meaning.

Choose the status from the evidence and its freshness. A live connection describes delivery, not provider health. Collected GitHub coverage is informational even when the collected checks report failures. Expired evidence must not retain a green success indicator. Keep error and warning colors distinct.

Give dialogs a concise description, recognizable section icons, and a visible action footer. Keep primary fields and operational warnings visible; place optional context, explanatory help, and diagnostic timings in labeled disclosures. Show a short summary of saved optional settings in the closed section. Collapsing a section preserves its draft, and validation opens any section containing an invalid field before focusing the first error. Keep consequential review details available before approval.
