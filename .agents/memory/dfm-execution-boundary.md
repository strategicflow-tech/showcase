---
name: DFM execution boundary
description: The database-only scope for applying structured Decision Friction fixes.
---

The initial execution/write layer targets stored audit records in PostgreSQL only. Do not connect it to Resend, another email service, a CMS, or another external delivery or publishing target without a new explicit user request.

**Why:** The first real target was intentionally limited to the project's own stored audit record so the apply, precondition, and attempt-logging path could be validated without external effects.

**How to apply:** Keep execution writes within the audit-record store and use explicitly scoped credentials. Treat email or CMS execution as a separate scope requiring user direction.