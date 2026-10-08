# Configuration for your installation

The `operational` profile prefers governed writes; `full` retains compatibility tools. Select a profile for your clients and workflows. Permissions remain independent of catalog selection.

Clients sharing an HTTP backend and authenticated identity also share its quota. When receiving `429`, check counters and `Retry-After` before changing limits. `MCP_HTTP_IDENTITY_RATE_LIMIT_MAX` sets a workload-appropriate ceiling; for example, `1000` requests per 15-minute window may suit a busy local installation. This is an optional example, not a mandatory default or per-client isolation. Retain a finite limit and HTTP protections, and choose the ceiling for your exposure and usage. See [HTTP protections](http-multiclient-security.md).

Local REST API `5.4.0` was exercised on the read and governed-write paths described in [the performance follow-up](governed-performance.md), not every tool or plugin. Without a compatible FDM completion signal, certification retains its conservative wait. The [optional FDM integration](fdm-completion.md) concerns a specifically qualified add-on, not the unchanged upstream FDM plugin. Installers choose their plugins and settings.

FDM means **Frontmatter Date Manager**, the plugin that owns automatic note date
updates. The optional add-on signals completed processing to Atomic Write Bridge,
so the MCP can verify final bytes sooner without owning timestamp writes.
Installation is restricted to the audited FDM 1.6.0 build, with explicit backup
and rollback in [the procedure](fdm-completion.md#optional-installation-and-rollback).
