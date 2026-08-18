# Documentation hub

French version: [README.fr.md](README.fr.md)

![Map of the Optimike Obsidian MCP documentation by reader need](assets/readme/documentation-hub.en.svg)

This page routes each question to one authoritative document. Optimike MCP 3.0 separates runtime capability from the tool surface exposed to a client session.

## Start by role

| I am… | Start here | Then use |
| --- | --- | --- |
| A new local user | [Product overview](../README.md) | [Tool surface profiles](tool-surface-profiles.md), [Operations](../OPERATIONS.md) |
| A Codex or local-agent operator | [Tool surface profiles](tool-surface-profiles.md) | [Agent routing](mcp-routing-guide.md), [Operations](../OPERATIONS.md) |
| A headless/server operator | [Headless Server Profile](headless-server-profile.md) | [Runtime Matrix](runtime-capability-matrix.md), [Security](../SECURITY.md) |
| A gateway integrator | [OSS Gateway Compatibility](gateway-compatibility.md) | [HTTP Security](http-multiclient-security.md), [Backpressure](http-concurrency-backpressure.md) |
| An MCP client integrator | [Tool surface profiles](tool-surface-profiles.md) | [Tool name registry](obsidian_mcp_tools_spec.md), [Runtime Matrix](runtime-capability-matrix.md) |
| An external-document operator | [External Roots Setup](external-roots-setup.md) | [External Roots ADR](adr/ADR-External-Document-Roots.md), [Reference Integrity ADR](adr/ADR-External-Reference-Integrity.md) |
| A Tasks/Operon operator | [Operon MCP Contract](operon-mcp-contract.md) | [CLI/API audit](operon-cli-audit.md), [Local Validation](operon-local-validation.md), [public ÉLYSIA profile](../profiles/elysia-tasks/README.fr.md) |
| A contributor or reviewer | [Architecture decisions](adr/README.md) | [V3 surface ADR](adr/ADR-Tool-Surface-Profiles-V3.md), [Repository tree](tree.md) |

## Find the authoritative page

| Question | Authority |
| --- | --- |
| Which profile should this client use? | [Tool surface profiles](tool-surface-profiles.md) |
| Which public tool names exist in 3.0? | [Tool Surface](obsidian_mcp_tools_spec.md) |
| Which tools can this runtime structurally register? | [Runtime Capability Matrix](runtime-capability-matrix.md) |
| How do I run and maintain the service? | [Operations](../OPERATIONS.md) |
| Which tool family owns an intent? | [MCP Routing Guide](mcp-routing-guide.md) |
| How do I run without Obsidian Desktop? | [Headless Server Profile](headless-server-profile.md) |
| How do external reads, handoff, move and link repair work? | [External Roots Setup](external-roots-setup.md) |
| What is the supported HTTP security boundary? | [Security](../SECURITY.md) and [HTTP ADR](adr/ADR-HTTP-External-Artifact-Delivery.md) |
| How is a session bound to a tool profile? | [V3 surface ADR](adr/ADR-Tool-Surface-Profiles-V3.md) |
| Which OSS gateway profile has been proven end to end? | [OSS Gateway Compatibility](gateway-compatibility.md) |
| How are Operon reads and mutations governed? | [Operon MCP Contract](operon-mcp-contract.md) |
| How does governed atomic note replacement work? | [Governed Note Replacement](governed-note-replacement.md) |
| How are source-preserving Frontmatter changes governed? | [Governed Frontmatter P1](governed-frontmatter-p1.md) |
| How are named Base formulas mutated safely? | [Governed Base Formula P2](governed-base-formula-p2.md) |
| How is one existing JSON Canvas graph mutated safely? | [Governed Canvas P3](governed-canvas-p3.md) |
| Why does MCP expose Operon functions instead of a CLI passthrough? | [Operon CLI / Developer API audit](operon-cli-audit.md) |
| What changed? | [Changelog](../CHANGELOG.md) |

## 3.0 public contract

- Profiles are selected before `tools/list`: `standard`, `authoring`, `tasks`, `full`.
- Direct stdio accepts `--tool-profile` or `MCP_TOOL_PROFILE`.
- HTTP uses `/mcp/{profile}`; `/mcp` is the compatibility alias of `/mcp/full`.
- Sessions cannot switch profile.
- Hidden tools are not callable.
- Governed families are exposed atomically.
- Semantic search uses only `smart_semantic_search`; the two former aliases were removed.

## Capability families

### Vault and Obsidian structure

- core reads and semantic search: [Tool Surface](obsidian_mcp_tools_spec.md#core-vault-and-search);
- direct and governed Notes: [Tool Surface](obsidian_mcp_tools_spec.md#direct-note-operations);
- Frontmatter and tags: [Tool Surface](obsidian_mcp_tools_spec.md#frontmatter-and-tags);
- Bases: [Tool Surface](obsidian_mcp_tools_spec.md#bases);
- Canvas: [Tool Surface](obsidian_mcp_tools_spec.md#canvas).

### Tasks and execution

- Tasks-compatible reads: [Tool Surface](obsidian_mcp_tools_spec.md#tasks-compatible-markdown);
- governed Operon contract: [Operon MCP Contract](operon-mcp-contract.md);
- MCP versus CLI boundary: [Operon CLI / Developer API audit](operon-cli-audit.md);
- bundled bridge implementation: [Operon Bridge README](../plugins/obsidian-operon-bridge/README.md).

### Runtime and transport

- profile selection: [Tool surface profiles](tool-surface-profiles.md);
- runtime modes: [Runtime Capability Matrix](runtime-capability-matrix.md);
- cache, health and maintenance: [Operations](../OPERATIONS.md);
- multi-client HTTP boundary: [HTTP Security](http-multiclient-security.md) and [V3 surface ADR](adr/ADR-Tool-Surface-Profiles-V3.md).

### External documents

- configuration and workflows: [External Roots Setup](external-roots-setup.md);
- semantic routing: [MCP Routing Guide](mcp-routing-guide.md#external-documents);
- HTTP delivery: [HTTP ADR](adr/ADR-HTTP-External-Artifact-Delivery.md);
- local move, link repair and rollback: [Reference Integrity ADR](adr/ADR-External-Reference-Integrity.md).

## Documentation ownership

- README files explain the product and first successful run.
- Tool-surface profiles own discovery/session contracts.
- Operations guides own runtime configuration and troubleshooting.
- Tool Surface owns public names and concise semantics.
- Runtime Matrix owns structural mode availability.
- Domain contracts own governed mutation guarantees.
- ADRs own decisions, boundaries and rejected alternatives.
- The changelog records releases and migrations.

Do not duplicate tool lists, limits or environment-variable contracts when a link to the owning page is sufficient.
