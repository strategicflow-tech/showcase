---
name: Existing secret operations
description: Safe handling of already-configured Replit secrets when an authenticated production action must be triggered.
---

Use `requestSecrets` only when a secret needs to be collected from the user; it does not return already-configured secret values. For an existing secret needed by an internal authenticated request, pass the environment variable directly to the command or request without echoing, logging, or returning it.

**Why:** The secret callback is intentionally non-readable, while some maintenance endpoints still require a job-token header.

**How to apply:** Use an environment-variable expansion in a non-verbose shell request, capture only the endpoint response, and never include the header value in output or code logs.