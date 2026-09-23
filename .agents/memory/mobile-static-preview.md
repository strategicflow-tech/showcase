---
name: Static mobile page preview
description: Reliable viewport checks for static HTML pages in this workspace
---

Use Chromium direct screenshots with explicit `--window-size` values for static-page mobile checks. A same-origin iframe probe can report a default 500px viewport even when the direct screenshot uses the requested width, so trust the direct render for visual verification.

**Why:** The local static page preview is not a browser test runner, and iframe-based measurements can inherit a misleading default viewport.

**How to apply:** Check the required widths directly, inspect the relevant lower-page sections with a temporary scroll helper if needed, and delete any helper files before finishing.