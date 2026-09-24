---
name: GitHub Pages publishing
description: Safe publication pattern for the static Strategic Flow showcase repository.
---

For static-site releases, use the connected GitHub integration to create one tree and one commit on the repository's main branch, then verify the Pages workflow and public URLs.

**Why:** Updating files one at a time through the Contents API can queue or cancel multiple Pages builds and leave the public site temporarily inconsistent.

**How to apply:** Read the current main ref, create blobs for the complete batch, create a tree from the current base tree, create one commit, update main without force, then poll the Pages workflow before checking cache-busted URLs.

When the workspace file differs from the current remote version, do not replace the remote file with the stale workspace copy. Apply only the requested change to the fetched remote blob and commit against its current tree.

**Why:** The workspace can lag behind GitHub Pages, and publishing its full file would silently erase unrelated live-site changes.

**How to apply:** Compare the remote file with the intended change, preserve remote-only content, and stop if the requested target no longer matches or the branch advances during the update.