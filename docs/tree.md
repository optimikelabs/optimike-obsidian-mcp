# optimike-obsidian-mcp - Directory Structure

Generated on: 2026-07-29 10:22:06

```
optimike-obsidian-mcp
├── .github
│   ├── workflows
│   │   ├── operon-bridge.yml
│   │   └── runtime.yml
│   └── FUNDING.yml
├── docs
│   ├── adr
│   │   ├── ADR-External-Document-Roots.md
│   │   ├── ADR-External-Reference-Integrity.fr.md
│   │   ├── ADR-External-Reference-Integrity.md
│   │   ├── ADR-HTTP-External-Artifact-Delivery.md
│   │   ├── ADR-HTTP-Multiclient-Headless-Architecture.md
│   │   ├── ADR-Operon-Bridge.md
│   │   ├── M2-HTTP-Backpressure-Validation.md
│   │   └── README.md
│   ├── assets
│   │   ├── readme
│   │   │   ├── documentation-hub.en.svg
│   │   │   ├── documentation-hub.fr.svg
│   │   │   ├── manifest.json
│   │   │   ├── operations.en.svg
│   │   │   ├── operations.fr.svg
│   │   │   ├── overview.en.svg
│   │   │   ├── overview.fr.svg
│   │   │   ├── routing-guide.en.svg
│   │   │   ├── routing-guide.fr.svg
│   │   │   ├── runtime-profiles.en.svg
│   │   │   ├── runtime-profiles.fr.svg
│   │   │   ├── security.en.svg
│   │   │   └── security.fr.svg
│   │   └── README.md
│   ├── obsidian-api
│   │   ├── obsidian_rest_api_spec.json
│   │   └── obsidian_rest_api_spec.yaml
│   ├── agentgateway.transparent.example.yaml
│   ├── external-roots-setup.fr.md
│   ├── external-roots-setup.md
│   ├── external-roots.example.json
│   ├── gateway-compatibility.fr.md
│   ├── gateway-compatibility.md
│   ├── headless-multiclient-pilot.fr.md
│   ├── headless-multiclient-pilot.md
│   ├── headless-server-profile.fr.md
│   ├── headless-server-profile.md
│   ├── http-backpressure.env.example
│   ├── http-concurrency-backpressure.fr.md
│   ├── http-concurrency-backpressure.md
│   ├── http-multiclient-security.fr.md
│   ├── http-multiclient-security.md
│   ├── http-observability-contract.fr.md
│   ├── http-observability-contract.md
│   ├── kairelys-cutover.fr.md
│   ├── mcp-routing-guide.fr.md
│   ├── mcp-routing-guide.md
│   ├── obsidian_mcp_tools_spec.md
│   ├── operon-decision-report.md
│   ├── operon-local-validation.md
│   ├── operon-mcp-contract.md
│   ├── operon-migration-plan.md
│   ├── operon-rest-contract.md
│   ├── README.fr.md
│   ├── README.md
│   ├── runtime-capability-matrix.fr.md
│   ├── runtime-capability-matrix.md
│   └── tree.md
├── plugins
│   ├── obsidian-bases-bridge
│   │   ├── src
│   │   │   ├── filter-comparison.mjs
│   │   │   ├── filter-comparison.test.mjs
│   │   │   ├── link-normalization.mjs
│   │   │   ├── link-normalization.test.mjs
│   │   │   └── main.ts
│   │   ├── esbuild.config.mjs
│   │   ├── manifest.json
│   │   ├── package-lock.json
│   │   ├── package.json
│   │   ├── README.md
│   │   └── tsconfig.json
│   └── obsidian-operon-bridge
│       ├── src
│       │   ├── contract.test.ts
│       │   ├── contract.ts
│       │   ├── main.ts
│       │   ├── task-engine-runtime.test.ts
│       │   └── task-engine-runtime.ts
│       ├── esbuild.config.mjs
│       ├── manifest.json
│       ├── package-lock.json
│       ├── package.json
│       ├── README.md
│       └── tsconfig.json
├── profiles
│   └── elysia-tasks
│       ├── skills
│       │   └── elysia-task-gouverneur
│       │       ├── references
│       │       │   ├── admission-p90-j.md
│       │       │   ├── audits-et-triage.md
│       │       │   ├── contrat-de-sortie.md
│       │       │   ├── cycle-de-vie-projet.md
│       │       │   ├── operations-ponctuelles.md
│       │       │   ├── runtime-et-mutations.md
│       │       │   └── sante-et-performance.md
│       │       └── SKILL.md
│       ├── v1
│       │   ├── profile.json
│       │   └── schema.json
│       └── README.fr.md
├── scripts
│   ├── fixtures
│   │   └── external-references
│   │       ├── active.md
│   │       └── excluded.md
│   ├── check-vault-exclusion-policy.mjs
│   ├── clean.ts
│   ├── fetch-openapi-spec.ts
│   ├── fix-wsl-eio-smartenv.ps1
│   ├── generate-readme-visuals.mjs
│   ├── long-run-headless-server.mjs
│   ├── make-executable.mjs
│   ├── make-executable.ts
│   ├── migrate-kairelys-to-operon.ps1
│   ├── migrate-operon-to-kairelys.ps1
│   ├── run-external-move-pilot.mjs
│   ├── run-http.mjs
│   ├── run-inspector.mjs
│   ├── smoke-external-move-pilot.mjs
│   ├── smoke-external-roots-mcp.mjs
│   ├── smoke-external-roots.mjs
│   ├── smoke-headless-readonly.mjs
│   ├── smoke-headless-server-profile.mjs
│   ├── smoke-headless-status.mjs
│   ├── smoke-operon-mutations.mjs
│   ├── smoke-operon-rich-mutations.mjs
│   ├── smoke-runtime.mjs
│   ├── snapshot-vault.mjs
│   ├── test-agentgateway-compatibility.mjs
│   ├── test-backend-vault-adapter-cas.mjs
│   ├── test-doc-contract.mjs
│   ├── test-elysia-task-profile.mjs
│   ├── test-external-move-integrity.mjs
│   ├── test-external-reference-parser.mjs
│   ├── test-external-roots.mjs
│   ├── test-http-backpressure.mjs
│   ├── test-http-external-handoff.mjs
│   ├── test-http-headless-multiclient.mjs
│   ├── test-http-multiclient-rate-limiting.mjs
│   ├── test-http-observability-endpoints.mjs
│   ├── test-http-observability.mjs
│   ├── test-http-session-bounds.mjs
│   ├── test-launchers.mjs
│   ├── test-obsidian-cas.mjs
│   ├── test-obsidian-search-replace-cas.mjs
│   ├── test-operon-contract.mjs
│   ├── test-operon-service.mjs
│   ├── test-package-contents.mjs
│   ├── test-readme-visuals.mjs
│   ├── test-stdio-proxy-external-roots.mjs
│   ├── test-task-engine-migrations.ps1
│   ├── test-tool-annotations.mjs
│   └── tree.ts
├── src
│   ├── adapters
│   │   └── embed
│   │       ├── index.ts
│   │       ├── ollama.ts
│   │       └── openai.ts
│   ├── config
│   │   └── index.ts
│   ├── mcp-server
│   │   ├── tools
│   │   │   ├── basesCreateTool
│   │   │   │   ├── index.ts
│   │   │   │   ├── logic.ts
│   │   │   │   └── registration.ts
│   │   │   ├── basesGetSchemaTool
│   │   │   │   ├── index.ts
│   │   │   │   ├── logic.ts
│   │   │   │   └── registration.ts
│   │   │   ├── basesListTool
│   │   │   │   ├── index.ts
│   │   │   │   ├── logic.ts
│   │   │   │   └── registration.ts
│   │   │   ├── basesQueryTool
│   │   │   │   ├── index.ts
│   │   │   │   ├── logic.ts
│   │   │   │   └── registration.ts
│   │   │   ├── basesUpsertConfigTool
│   │   │   │   ├── index.ts
│   │   │   │   ├── logic.ts
│   │   │   │   └── registration.ts
│   │   │   ├── basesUpsertRowsTool
│   │   │   │   ├── index.ts
│   │   │   │   ├── logic.ts
│   │   │   │   └── registration.ts
│   │   │   ├── externalRootsTools
│   │   │   │   ├── index.ts
│   │   │   │   └── registration.ts
│   │   │   ├── listAllTasksTool
│   │   │   │   ├── index.ts
│   │   │   │   └── registration.ts
│   │   │   ├── obsidianDeleteNoteTool
│   │   │   │   ├── index.ts
│   │   │   │   ├── logic.ts
│   │   │   │   └── registration.ts
│   │   │   ├── obsidianGlobalSearchTool
│   │   │   │   ├── index.ts
│   │   │   │   ├── logic.ts
│   │   │   │   └── registration.ts
│   │   │   ├── obsidianListNotesTool
│   │   │   │   ├── index.ts
│   │   │   │   ├── logic.ts
│   │   │   │   └── registration.ts
│   │   │   ├── obsidianManageFrontmatterTool
│   │   │   │   ├── index.ts
│   │   │   │   ├── logic.ts
│   │   │   │   └── registration.ts
│   │   │   ├── obsidianManageTagsTool
│   │   │   │   ├── index.ts
│   │   │   │   ├── logic.ts
│   │   │   │   └── registration.ts
│   │   │   ├── obsidianReadNoteTool
│   │   │   │   ├── index.ts
│   │   │   │   ├── logic.ts
│   │   │   │   └── registration.ts
│   │   │   ├── obsidianSearchReplaceTool
│   │   │   │   ├── index.ts
│   │   │   │   ├── logic.ts
│   │   │   │   └── registration.ts
│   │   │   ├── obsidianUpdateNoteTool
│   │   │   │   ├── index.ts
│   │   │   │   ├── logic.ts
│   │   │   │   └── registration.ts
│   │   │   ├── operonTools
│   │   │   │   ├── index.ts
│   │   │   │   └── registration.ts
│   │   │   ├── queryTasksTool
│   │   │   │   ├── index.ts
│   │   │   │   └── registration.ts
│   │   │   ├── runtimeTools
│   │   │   │   ├── index.ts
│   │   │   │   └── registration.ts
│   │   │   ├── semanticSearchTool
│   │   │   │   ├── index.ts
│   │   │   │   ├── registration.ts
│   │   │   │   └── resolvePath.ts
│   │   │   └── tasksShared
│   │   │       ├── logic.ts
│   │   │       └── TaskParser.ts
│   │   ├── transports
│   │   │   ├── auth
│   │   │   │   ├── core
│   │   │   │   │   ├── authContext.ts
│   │   │   │   │   ├── authTypes.ts
│   │   │   │   │   └── authUtils.ts
│   │   │   │   ├── strategies
│   │   │   │   │   ├── jwt
│   │   │   │   │   │   └── jwtMiddleware.ts
│   │   │   │   │   └── oauth
│   │   │   │   │       └── oauthMiddleware.ts
│   │   │   │   └── index.ts
│   │   │   ├── httpBackpressure.ts
│   │   │   ├── httpErrorHandler.ts
│   │   │   ├── httpObservability.ts
│   │   │   ├── httpProtection.ts
│   │   │   ├── httpRequestState.ts
│   │   │   ├── httpTransport.ts
│   │   │   └── stdioTransport.ts
│   │   ├── server.ts
│   │   └── toolAnnotations.ts
│   ├── runtime
│   │   └── localBackend.ts
│   ├── services
│   │   ├── externalReferences
│   │   │   ├── backendVaultAdapter.ts
│   │   │   ├── canonicalReferenceParser.ts
│   │   │   ├── externalMoveCoordinator.ts
│   │   │   ├── externalMoveJournal.ts
│   │   │   └── index.ts
│   │   ├── obsidianRestAPI
│   │   │   ├── methods
│   │   │   │   ├── activeFileMethods.ts
│   │   │   │   ├── basesMethods.ts
│   │   │   │   ├── commandMethods.ts
│   │   │   │   ├── openMethods.ts
│   │   │   │   ├── patchMethods.ts
│   │   │   │   ├── periodicNoteMethods.ts
│   │   │   │   ├── searchMethods.ts
│   │   │   │   └── vaultMethods.ts
│   │   │   ├── vaultCache
│   │   │   │   ├── index.ts
│   │   │   │   └── service.ts
│   │   │   ├── index.ts
│   │   │   ├── service.ts
│   │   │   └── types.ts
│   │   ├── operon
│   │   │   ├── contract.ts
│   │   │   ├── index.ts
│   │   │   └── service.ts
│   │   ├── externalRootsService.ts
│   │   ├── externalTransferBroker.ts
│   │   ├── localBasesService.ts
│   │   ├── obsidianFormatService.ts
│   │   ├── runtimeState.ts
│   │   ├── semanticCache.ts
│   │   ├── smartEnv.ts
│   │   ├── vaultExclusions.ts
│   │   ├── vaultFileService.ts
│   │   └── writePolicy.ts
│   ├── types-global
│   │   └── errors.ts
│   ├── utils
│   │   ├── internal
│   │   │   ├── asyncUtils.ts
│   │   │   ├── errorHandler.ts
│   │   │   ├── index.ts
│   │   │   ├── logger.ts
│   │   │   └── requestContext.ts
│   │   ├── metrics
│   │   │   ├── index.ts
│   │   │   └── tokenCounter.ts
│   │   ├── obsidian
│   │   │   ├── index.ts
│   │   │   ├── obsidianApiUtils.ts
│   │   │   └── obsidianStatUtils.ts
│   │   ├── parsing
│   │   │   ├── dateParser.ts
│   │   │   ├── index.ts
│   │   │   └── jsonParser.ts
│   │   ├── security
│   │   │   ├── idGenerator.ts
│   │   │   ├── index.ts
│   │   │   ├── rateLimiter.ts
│   │   │   └── sanitization.ts
│   │   └── index.ts
│   ├── index.ts
│   └── stdio-proxy.ts
├── .clinerules
├── .env.server.example
├── .gitignore
├── .ncurc.json
├── CHANGELOG.md
├── Dockerfile
├── env.json
├── LICENSE
├── mcp.json
├── OPERATIONS.fr.md
├── OPERATIONS.md
├── package-lock.json
├── package.json
├── README_EMBEDDERS.md
├── README.fr.md
├── README.md
├── repomix.config.json
├── SECURITY.fr.md
├── SECURITY.md
├── smithery.yaml
├── tsconfig.json
└── typedoc.json
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
