---
name: Static count audits
description: Method for auditing claimed totals in static HTML and structured content.
---

When auditing site-wide public totals, scan rendered text after removing HTML tags as well as structured metadata. Include suffix forms such as `N+` and labels split across elements. Distinguish overall archive or dataset totals from pattern-specific occurrences, cohort counts, company-list “others” formulas, actual record counts, and unrelated dates, scores, or prices. Change only values in the requested class.

**Why:** Static pages can separate a number and its label into different DOM elements, while raw adjacency-only searches can miss visible claims. Replacing subgroup metrics or the “others” value in a named-company formula can also falsify otherwise valid data.

**How to apply:** Build a tag-stripped text scan with source offsets, review number contexts, preserve subgroup numerators and formulas, and verify rendered page text plus structured data after publishing. Keep the real-record count separate from any requested public total.