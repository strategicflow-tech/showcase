---
name: Audit deployment separation
description: Keep the email-audit app deployment separate from the strategicflow.tech static marketing site.
---

The email-audit deployment must serve its recovered application tree and backend, while the marketing site continues to use the repository-root static files for strategicflow.tech.

**Why:** Publishing the repository root as a static Replit site caused the audit subdomain to serve the marketing homepage and removed the audit app's server routes.

**How to apply:** Keep the audit deployment on its backend run command and public application tree; treat deployment configuration changes as pending until the owner republishes.