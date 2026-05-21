# optimike-obsidian-mcp - Directory Structure

Generated on: 2026-05-21 12:56:57

```
optimike-obsidian-mcp
├── .github
│   ├── workflows
│   │   └── runtime.yml
│   └── FUNDING.yml
├── docs
│   ├── assets
│   │   ├── hero-optimike-obsidian-mcp.png
│   │   ├── README.md
│   │   └── runtime-architecture-optimike-obsidian-mcp.png
│   ├── obsidian-api
│   │   ├── obsidian_rest_api_spec.json
│   │   └── obsidian_rest_api_spec.yaml
│   ├── headless-server-profile.fr.md
│   ├── headless-server-profile.md
│   ├── mcp-routing-guide.fr.md
│   ├── mcp-routing-guide.md
│   ├── obsidian_mcp_tools_spec.md
│   ├── runtime-capability-matrix.fr.md
│   ├── runtime-capability-matrix.md
│   └── tree.md
├── plugins
│   └── obsidian-bases-bridge
│       ├── src
│       │   └── main.ts
│       ├── esbuild.config.mjs
│       ├── manifest.json
│       ├── package.json
│       ├── README.md
│       └── tsconfig.json
├── scripts
│   ├── check-vault-exclusion-policy.mjs
│   ├── clean.ts
│   ├── fetch-openapi-spec.ts
│   ├── fix-wsl-eio-smartenv.ps1
│   ├── long-run-headless-server.mjs
│   ├── make-executable.mjs
│   ├── make-executable.ts
│   ├── smoke-headless-readonly.mjs
│   ├── smoke-headless-server-profile.mjs
│   ├── smoke-headless-status.mjs
│   ├── smoke-runtime.mjs
│   ├── snapshot-vault.mjs
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
│   │   │   ├── httpErrorHandler.ts
│   │   │   ├── httpTransport.ts
│   │   │   └── stdioTransport.ts
│   │   └── server.ts
│   ├── runtime
│   │   └── localBackend.ts
│   ├── services
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
├── smithery.yaml
├── tsconfig.json
└── typedoc.json
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
