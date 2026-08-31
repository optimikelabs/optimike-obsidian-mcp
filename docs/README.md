# Documentation hub

French version: [README.fr.md](README.fr.md)

![Map of the Optimike Obsidian MCP documentation by reader need](assets/readme/documentation-hub.en.svg)

This page routes readers to one authoritative document for each question.
French operator guides are linked alongside their English equivalents.

## Start by role

| I am…                           | Start here                                            | Then use                                                                                                                                             |
| ------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| A new local user                | [Product overview](../README.md)                      | [Tool Surface Profiles](tool-surface-profiles.md), [Operations](../OPERATIONS.md)                                                                    |
| A Codex or local-agent operator | [Tool Surface Profiles](tool-surface-profiles.md)     | [Operations](../OPERATIONS.md), [Agent routing](mcp-routing-guide.md)                                                                                |
| A headless/server operator      | [Headless Server Profile](headless-server-profile.md) | [Runtime Matrix](runtime-capability-matrix.md), [Tool Surface Profiles](tool-surface-profiles.md), [Security](../SECURITY.md)                        |
| A gateway integrator            | [OSS Gateway Compatibility](gateway-compatibility.md) | [HTTP Security](http-multiclient-security.md), [Backpressure](http-concurrency-backpressure.md)                                                      |
| An MCP client integrator        | [Tool Surface Profiles](tool-surface-profiles.md)     | [Tool Surface](obsidian_mcp_tools_spec.md), [Runtime Matrix](runtime-capability-matrix.md)                                                           |
| An external-document operator   | [External Roots Setup](external-roots-setup.md)       | [External Roots ADR](adr/ADR-External-Document-Roots.md), [Reference Integrity ADR](adr/ADR-External-Reference-Integrity.md)                         |
| A Tasks/Operon operator         | [Operon MCP Contract](operon-mcp-contract.md)         | [CLI/API audit](operon-cli-audit.md), [Local Validation](operon-local-validation.md), [public ÉLYSIA profile](../profiles/elysia-tasks/README.fr.md) |
| A contributor or reviewer       | [Architecture decisions](adr/README.md)               | [Repository tree](tree.md), plugin READMEs                                                                                                           |

## Find the authoritative page

| Question                                                             | Authority                                                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Which server tool profile should a client expose?                    | [Tool Surface Profiles](tool-surface-profiles.md)                                     |
| Which tools exist?                                                   | [Tool Surface](obsidian_mcp_tools_spec.md)                                            |
| Which tools are available in each runtime?                           | [Runtime Capability Matrix](runtime-capability-matrix.md)                             |
| Why is a capability hidden, unavailable, or unauthorized?            | [Runtime Capability Doctor](capability-doctor.md)                                     |
| How do I run and maintain the service?                               | [Operations](../OPERATIONS.md)                                                        |
| How do Bridges recover after Local REST starts or reloads?           | [Bridge Lifecycle Recovery](bridge-lifecycle.md)                                      |
| How do I install, upgrade or roll back all three Bridges?            | [Bridge Bundle, Upgrade and Rollback](bridge-packaging.md)                            |
| Which tool should an agent choose inside its profile?                | [MCP Routing Guide](mcp-routing-guide.md)                                             |
| How are routing quality and profile decisions measured?              | [Tool Routing Evaluation P6](tool-routing-evaluation-p6.md)                           |
| How do I run without Obsidian Desktop?                               | [Headless Server Profile](headless-server-profile.md)                                 |
| How do external reads, handoff, move and link repair work?           | [External Roots Setup](external-roots-setup.md)                                       |
| What is the supported HTTP security boundary?                        | [Security](../SECURITY.md) and [HTTP ADR](adr/ADR-HTTP-External-Artifact-Delivery.md) |
| Which OSS gateway profile has been proven end to end?                | [OSS Gateway Compatibility](gateway-compatibility.md)                                 |
| How are Operon reads and mutations governed?                         | [Operon MCP Contract](operon-mcp-contract.md)                                         |
| How does governed atomic note replacement work?                      | [Governed Note Replacement](governed-note-replacement.md)                             |
| How do I find a lost pending governed operation?                     | [Pending Operation Cockpit P5](operation-cockpit-p5.md)                               |
| How do I append, prepend or replace body text without a lost update? | [Governed Text Patch P4](governed-text-patch-p4.md)                                   |
| How are named Obsidian Base formulas mutated safely?                 | [Governed Base Formula P2](governed-base-formula-p2.md)                               |
| How is one existing JSON Canvas graph mutated safely?                | [Governed Canvas P3](governed-canvas-p3.md)                                           |
| Why does MCP expose Operon functions instead of calling the CLI?     | [Operon CLI / Developer API audit](operon-cli-audit.md)                               |
| Why was an architecture decision made?                               | [ADR Index](adr/README.md)                                                            |
| What changed?                                                        | [Changelog](../CHANGELOG.md)                                                          |

Governed source-preserving Frontmatter: [P1 contract](governed-frontmatter-p1.md).
Governed source-preserving Base formulas: [P2 contract](governed-base-formula-p2.md).

## Capability families

### Vault and Obsidian structure

- notes, metadata and tags: [Tool Surface](obsidian_mcp_tools_spec.md#core-notes);
- Bases: [Tool Surface](obsidian_mcp_tools_spec.md#bases);
- Canvas and validation: [Tool Surface](obsidian_mcp_tools_spec.md#canvas-and-format-validation).

### Tasks and execution

- Tasks-compatible reads: [Tool Surface](obsidian_mcp_tools_spec.md#tasks);
- governed Operon contract: [Operon MCP Contract](operon-mcp-contract.md);
- MCP versus CLI boundary: [Operon CLI / Developer API audit](operon-cli-audit.md);
- bundled bridge implementation: [Operon Bridge README](../plugins/obsidian-operon-bridge/README.md);
- bundled Bases implementation: [Bases Bridge README](../plugins/obsidian-bases-bridge/README.md).
- governed atomic note replacement: [contract](governed-note-replacement.md) and [Atomic Write Bridge README](../plugins/obsidian-atomic-write-bridge/README.md).
- governed Markdown body text patches: [P4 contract](governed-text-patch-p4.md).
- lost-plan and uncertain-operation inventory: [P5 cockpit](operation-cockpit-p5.md).

### Search and runtime

- public exposure profiles: [Tool Surface Profiles](tool-surface-profiles.md);
- routing corpus, deterministic metrics and profile decisions: [P6 evaluation](tool-routing-evaluation-p6.md);
- semantic search and providers: [Operations](../OPERATIONS.md#semantic-search-what-is-persisted-and-what-is-not);
- runtime modes: [Runtime Capability Matrix](runtime-capability-matrix.md);
- live profile/backend/grant diagnosis: [Runtime Capability Doctor](capability-doctor.md);
- cache, health and maintenance: [Operations](../OPERATIONS.md).
- verified Bridge release bundle and rollback: [Bridge Packaging](bridge-packaging.md).

### External documents

- configuration and client workflows: [External Roots Setup](external-roots-setup.md);
- semantic routing for agents: [MCP Routing Guide](mcp-routing-guide.md#external-document-routing);
- HTTP delivery boundary: [HTTP ADR](adr/ADR-HTTP-External-Artifact-Delivery.md);
- diagnostic local-move planning, redacted evidence and deferred mutation:
  [Reference Integrity ADR](adr/ADR-External-Reference-Integrity.md).

## Documentation ownership

- README files explain the product and first successful run.
- Tool Surface Profiles owns `standard`, `authoring`, `tasks`, `full`, profile selection and client-facing exposure semantics.
- Operations guides own local runtime and troubleshooting.
- The tool surface owns tool names and semantics.
- The runtime matrix owns backend-mode availability.
- The routing guide owns canonical precedence between overlapping tools.
- Setup guides own configuration examples.
- ADRs own decisions, status, boundaries and rejected alternatives.
- The changelog records releases and unreleased changes.

Do not copy limits, environment-variable contracts or tool registries into
multiple pages when a link to the owning page is sufficient.
