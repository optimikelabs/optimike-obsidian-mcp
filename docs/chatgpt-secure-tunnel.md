# ChatGPT through OpenAI Secure MCP Tunnel

French version: [chatgpt-secure-tunnel.fr.md](chatgpt-secure-tunnel.fr.md)

Optimike can connect directly to ChatGPT through OpenAI Secure MCP Tunnel. Chat On Steroids is not a runtime dependency for this path.

```text
ChatGPT
  -> OpenAI-hosted tunnel endpoint
  -> official tunnel-client on your machine
  -> Optimike stdio proxy (selected tool profile)
  -> Obsidian / configured external roots
```

Secure MCP Tunnel is an outbound transport for a private MCP server. It does not publish Optimike as a public ChatGPT plugin. Each operator needs an eligible ChatGPT workspace, a Platform tunnel association, a `tunnel_id`, and a runtime API key with **Tunnels Read + Use**.

## Install the official tunnel client

Use the download from Platform tunnel settings or the latest public release from [openai/tunnel-client](https://github.com/openai/tunnel-client/releases/latest). Do not copy the binary from another desktop application.

On Windows, this repository includes a checksum-verifying installer:

```powershell
pwsh -NoProfile -File scripts/install-openai-tunnel-client.ps1
```

Pin a reviewed version when reproducibility matters:

```powershell
pwsh -NoProfile -File scripts/install-openai-tunnel-client.ps1 -Version 0.0.14
```

The script downloads the official Windows archive and `SHA256SUMS.txt`, refuses a digest mismatch, checks the binary-reported version, and installs into `%LOCALAPPDATA%\Optimike\tunnel-client\vX.Y.Z\windows-<arch>` without placing a secret in the repository. It also creates the stable launcher `%LOCALAPPDATA%\Optimike\tunnel-client\tunnel-client.cmd`; rerunning the installer re-downloads the signed release inputs and refuses a drifted existing executable.

## Connect Optimike

Build Optimike first. The explicit `full` profile exposes the complete live tool surface; choose a smaller profile when that is sufficient.

```powershell
npm install
npm run build
```

Use the official client profile workflow. Keep the API key in a protected process or service environment, never in Git, a vault note, a command transcript, or the MCP command.

```powershell
$tunnelClient = Join-Path $env:LOCALAPPDATA "Optimike\tunnel-client\tunnel-client.cmd"

& $tunnelClient init `
  --sample sample_mcp_stdio_local `
  --profile optimike-full `
  --tunnel-id tunnel_0123456789abcdef0123456789abcdef `
  --mcp-command "node C:/path/to/optimike-obsidian-mcp/dist/stdio-proxy.js --tool-profile full"

& $tunnelClient doctor --profile optimike-full --explain
& $tunnelClient run --profile optimike-full
```

Then create a developer-mode app in ChatGPT, choose **Tunnel** as the connection type, and select the associated tunnel. Confirm the local client is live and ready before testing the app.

## Load local configuration and external roots

The process launched by `tunnel-client` must receive the same configuration as a local stdio client. Keep Obsidian secrets and private paths outside Git. To inject the tool profile and external-roots file explicitly, create a local PowerShell launcher such as `C:\Users\you\.config\optimike\start-chatgpt-mcp.ps1`:

```powershell
$ErrorActionPreference = "Stop"
$repository = "C:\path\to\optimike-obsidian-mcp"
$externalRoots = "C:\Users\you\.config\optimike\external-roots.json"

$env:MCP_TOOL_PROFILE = "full"
$env:MCP_EXTERNAL_ROOTS_FILE = $externalRoots

Set-Location -LiteralPath $repository
& node (Join-Path $repository "dist\stdio-proxy.js")
exit $LASTEXITCODE
```

The tunnel child inherits the `tunnel-client` process environment. Required keys can therefore come from the secret manager or service that starts the tunnel without being written into this script. Reference the launcher from the profile:

```powershell
& $tunnelClient init `
  --sample sample_mcp_stdio_local `
  --profile optimike-full `
  --tunnel-id tunnel_0123456789abcdef0123456789abcdef `
  --mcp-command 'pwsh -NoProfile -File "C:/Users/you/.config/optimike/start-chatgpt-mcp.ps1"'
```

To add a folder, first copy [`external-roots.example.json`](external-roots.example.json) outside the repository, then append an entry to `roots`. This example is strictly read-only:

```json
{
  "id": "my-documents",
  "path": "D:\\Documents\\References",
  "capabilities": ["visible", "readable"],
  "include": ["**/*.md", "**/*.txt", "**/*.json"],
  "exclude": ["**/.git/**", "**/node_modules/**", "**/*.zip"],
  "limits": {
    "maxDepth": 8,
    "maxFileBytes": 1048576,
    "maxListEntries": 500,
    "maxTextChars": 200000
  }
}
```

Do not replace existing entries; append the new root to the same `roots` array. Use `visible` + `readable` unless an external move is explicitly required. See [External Roots Setup](external-roots-setup.md) for the complete schema, ceilings, and confinement rules.

External-root configuration is loaded when the MCP process starts. After changing the JSON file, stop this profile's `tunnel-client` and start it again:

```powershell
$healthFile = Join-Path $env:TEMP "optimike-tunnel-health.url"

& $tunnelClient doctor --profile optimike-full --explain
& $tunnelClient run `
  --profile optimike-full `
  --health.listen-addr 127.0.0.1:0 `
  --health.url-file $healthFile
```

The `run` command stays active in the foreground. Leave it running and open a second PowerShell window to read the URL from `$healthFile`, check `/healthz` and `/readyz`, then call `external_roots_list`, `external_list`, and `external_read` on a small canary file. Use `Ctrl+C` in the first window when the client should stop. With a service or supervisor, restart only the instance tied to the Optimike profile; do not kill every `tunnel-client` process on the machine.

Adding an external root does not require an Obsidian or Bridge restart. Bridges own native vault operations. After a Bridge upgrade, follow [Bridge Bundle, Upgrade and Rollback](bridge-packaging.md), reload Obsidian, then verify `obsidian_runtime_status`. A Local REST API reload by itself is recovered automatically by the [Bridge lifecycle supervisor](bridge-lifecycle.md).

## Refresh after an Optimike upgrade

The server runtime and a ChatGPT conversation do not own the same lifecycle.

1. Restart the Optimike backend and the `tunnel-client` instance for the affected profile.
2. Confirm the tunnel client's `/healthz` and `/readyz` endpoints.
3. In ChatGPT, open **Settings -> Plugins -> your Optimike app -> Refresh**.
4. Start a new conversation and verify a small set of tool names from the selected profile.

For an external-roots JSON change only, restarting `tunnel-client` is enough: it recreates the stdio proxy with the new configuration. After rebuilding `dist`, restart the Optimike backend as well. When tool names change, refresh the ChatGPT app and start a new conversation; an existing conversation keeps its initial bindings.

In the Optimike 3.9.1 pilot, the app refresh discovered the new tools immediately, while conversations created before the refresh retained their original 77-tool binding. A new conversation received all 87 `full` tools. Treat the tools actually injected into the current conversation as the client-facing authority; `obsidian_runtime_status` describes backend capability and cannot retroactively change a conversation's tool binding.

## Operational boundary

- `tunnel-client` is transport only. Optimike owns tool registration, policy, journals, schemas, and backend behavior.
- The browser extension used by Chat On Steroids is not required for Optimike over Secure MCP Tunnel.
- The local machine, Optimike backend, Obsidian Desktop for live capabilities, and `tunnel-client` must remain available.
- Use `status` or the operation cockpit after a lost mutation response. Never retry a mutation merely because the tunnel or conversation lost the reply.
- Follow the [Security guide](../SECURITY.md), [Tool Surface Profiles](tool-surface-profiles.md), and [Operations guide](../OPERATIONS.md).

OpenAI's current transport documentation: [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).
