---
name: Static blog validation
description: Validation rules for the mixed-generation static blog and its daily Field Note workflow.
---

The static blog contains older pages with different schemas, canonical conventions, and index sections. The daily Field Note template is the strict publication contract; historical deviations should be reported as warnings rather than blocking a new Field Note.

**Why:** Applying the newest template rules to every historical article produced false blocking failures and obscured the checks that protect new publications.

**How to apply:** Run the registered `blog` validation after adding an article. Treat errors on Field Note pages, broken files, malformed JSON-LD, and missing Field Note sitemap entries as blockers; review legacy warnings separately.