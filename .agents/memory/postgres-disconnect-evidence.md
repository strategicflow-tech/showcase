---
name: PostgreSQL disconnect evidence
description: Interpret clustered connection termination logs without overclaiming the cause.
---

Treat simultaneous PostgreSQL messages such as `terminating connection due to administrator command` as evidence that the server terminated sessions, not as proof of application pool exhaustion. `Connection terminated unexpectedly` and `ECONNRESET` alone are less specific. App logs may not distinguish a database restart, failover, maintenance action, or network interruption.

**Why:** Production logs reviewed on 2026-09-25 showed clustered connection losses, including an administrator-termination burst, while short surrounding windows showed no app restart and no `/directory`-specific errors. The available production SQL view was read-only and exposed only its own query session, so it could not establish runtime pool usage.

**How to apply:** Correlate connection-drop bursts with deploy/restart records and provider-side database logs. Use in-process pool wait/connection metrics to test the pool-exhaustion hypothesis; never treat read-replica activity counts as measurements of the app's live pool.