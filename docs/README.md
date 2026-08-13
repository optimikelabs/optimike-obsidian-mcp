# Documentation hub

French version: [README.fr.md](README.fr.md)

![Map of the Optimike Obsidian MCP documentation by reader need](assets/readme/documentation-hub.en.svg)

This page routes each reader to the document that owns the relevant contract.

## Main entry points

| Need | Authority |
| --- | --- |
| Discover the product | [Overview](../README.md) |
| Run and maintain the service | [Operations](../OPERATIONS.md) |
| Inspect tool contracts | [Tool Surface](obsidian_mcp_tools_spec.md) |
| Check availability by runtime | [Runtime Matrix](runtime-capability-matrix.md) |
| Understand governed atomic note replacement | [Tool contract](obsidian_mcp_tools_spec.md#governed-atomic-note-replacement) |
| Route an agent | [MCP Routing Guide](mcp-routing-guide.md) |
| Deploy headless | [Headless Server Profile](headless-server-profile.md) |
| Review the security boundary | [Security](../SECURITY.md) |
| Configure external documents | [External Roots Setup](external-roots-setup.md) |
| Operate Operon | [Operon MCP Contract](operon-mcp-contract.md) |
| Compare MCP and CLI surfaces | [CLI / API Audit](operon-cli-audit.md) |
| Review decisions | [ADR Index](adr/README.md) |
| Read changes | [Changelog](../CHANGELOG.md) |

## Capability families

### Obsidian vault

- notes, metadata, and tags: [Tool Surface](obsidian_mcp_tools_spec.md#core-notes);
- governed atomic whole-note replacement: [Tool contract](obsidian_mcp_tools_spec.md#governed-atomic-note-replacement);
- Bases: [Tool Surface](obsidian_mcp_tools_spec.md#bases);
- Canvas and validation: [Tool Surface](obsidian_mcp_tools_spec.md#canvas-and-format-validation).

### Tasks and execution

- Tasks-compatible reads: [Tool Surface](obsidian_mcp_tools_spec.md#tasks);
- governed Operon mutations: [Operon MCP Contract](operon-mcp-contract.md);
- CLI and Developer API limits: [audit](operon-cli-audit.md);
- Atomic Write implementation: [plugin README](../plugins/obsidian-atomic-write-bridge/README.md).

### Runtime and search

- modes and availability: [Runtime Matrix](runtime-capability-matrix.md);
- cache, health, maintenance, and semantic search: [Operations](../OPERATIONS.md);
- deployment and threats: [Security](../SECURITY.md).

### External documents

- configuration: [External Roots Setup](external-roots-setup.md);
- routing: [MCP Routing Guide](mcp-routing-guide.md#external-document-routing);
- local move and exact repair: [Reference Integrity ADR](adr/ADR-External-Reference-Integrity.md);
- HTTP delivery: [HTTP ADR](adr/ADR-HTTP-External-Artifact-Delivery.md).

## Documentation ownership

- README files explain the product and first successful run.
- Operations guides own commands and troubleshooting.
- The tool surface owns names and semantics.
- The runtime matrix owns mode availability.
- ADRs own decisions, boundaries, and rejected alternatives.
- The changelog owns released and unreleased changes.
