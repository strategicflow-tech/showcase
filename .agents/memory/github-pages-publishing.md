---
name: GitHub Pages publishing
description: Safe publication pattern for the static Strategic Flow showcase repository.
---

For static-site releases, use the connected GitHub integration to create one tree and one commit on the repository's main branch, then verify the Pages workflow and public URLs.

**Why:** Updating files one at a time through the Contents API can queue or cancel multiple Pages builds and leave the public site temporarily inconsistent.

**How to apply:** Read the current main ref, create blobs for the complete batch, create a tree from the current base tree, create one commit, update main without force, then poll the Pages workflow before checking cache-busted URLs.