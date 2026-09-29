# Voluntary image import — V1 candidate contract

This optional family creates one verified local image from one explicitly selected server-local source. It is not a general download, publication, image-display or note-editing pipeline.

## Intention and exposure

Referencing or displaying a remote image does not authorize downloading or importing it. Reusing an existing local image must not create another copy or recompress it. Only a deliberate import request (or an explicitly authorized workflow policy) selects this family. No clipping-specific behavior, background aspiration, bulk migration, overwrite, rename or automatic cleanup is introduced.

`asset_import_plan`, `asset_import_apply` and `asset_import_status` are a complete optional family in the `full` profile, with a live/hybrid-live governed runtime. Unconfigured installations retain their previous 87-tool full live surface. The cross-runtime catalogue includes 94 names, including the three conditional asset tools; its `assumedStaticRequirements` describe configured potential, not default exposure. Other profiles and unsupported runtime modes do not acquire these tools.

## Explicit server configuration

The operator chooses `MCP_ASSET_FOLDER`, an existing vault-relative directory, configures `OBSIDIAN_VAULT`, and enables mutation with `MCP_ASSET_IMPORT_ENABLED=true` plus `MCP_WRITE_MODE=full`. Enabling asset import without either the vault root or asset folder is a configuration error. There is no implicit destination and no directory creation. `MCP_ASSET_WEBP_QUALITY` defaults to 75 and accepts 1–100. An example application policy is `X/Images`, but the generic server does not hard-code it. Existing plugin settings are never changed by these tools.

Sources must already be present on the MCP server inside a configured ExternalRoot with both `readable` and `handoff` capabilities. The root's include/exclude/size and verified-read rules still apply. Direct HTTP access additionally requires a non-development identity carrying `external:read`, including status and terminal apply replay. Local stdio retains its explicit local-root boundary. Do not copy API keys, source bytes or private physical paths into prompts.

## Input and lifecycle

A plan takes `source: {rootId, relativePath, sha256}`, an explicit filename stem `name`, and an `idempotencyKey`. The source SHA-256 must come from the authorized original. Optional `quality` selects the conversion quality; `preserveOriginal: true` requires `exceptionReason`. Unknown keys, raw base64, URLs, arbitrary absolute paths and client-local paths are rejected.

Planning verifies the original digest, decodes it in a bounded child process, applies the image policy and freezes the exact output with its dimensions, format, size and hash in the existing private operation journal. The destination is observed absent and its native parent identity is sealed. No vault asset or note is created during planning.

Apply takes only the returned `planRef` and matching key. Write and source policy are rechecked; the existing journal reserves the attempt before the exclusive native write. The destination cannot be overwritten. Acknowledged and verified bytes yield a usable local embed. The optional insertion in a note is a separate existing governed note/text operation, never a two-resource transaction.

Status observes the exact sealed operation and file without another import, conversion or deletion. A lost reply is followed by status, not by a second import request. Matching observed bytes establish state, not authorship or Obsidian indexing. Later drift or a missing file removes the usable embed from the response. Pending operations appear in the existing cockpit with `apply` or `status`; no synthetic `recover` tool is added.

## Image and resource limits

Sources are capped at 8 MiB; outputs at 2 MiB; decoded images at 16,777,216 pixels across at most 32 frames. There are at most two active conversion/native workers and two in-flight plan constructions per process; the journal admits at most 32 pending imports. Workers have a finite deadline, fixed decoder pixel limits and bounded IPC payloads. This is process isolation, not an operating-system security sandbox or a guarantee about all native allocations.

Rasters normally become WebP without resizing; EXIF orientation is applied. Alpha is preserved. Bounded inert SVG and supported animation are preserved byte-for-byte. The accepted SVG subset rejects active content and external references before decoding. APNG and unqualified AVIF image sequences are refused rather than silently flattened. A requested original preservation remains subject to validation and output limits. A format exception is not permission to skip validation.

## Native creation boundary and uncertain effects

Creation is presently Windows x64, fixed local NTFS only. The writer opens and holds ordinary parent directories, verifies locality on the opened root handle, refuses reparse points and unexpected hardlinks, binds parent identity, and uses native exclusive creation. Unsupported platforms, UNC/remote/removable/non-NTFS targets or unavailable native dependencies fail closed; there is no generic path-write fallback.

An error or process interruption after file creation may leave a partial/unverified file. The operation records an uncertain outcome, preserves that file and never overwrites or deletes it automatically. This deliberate preservation is not rollback or successful import. Subsequent status may establish matching state, but otherwise an operator must resolve the retained residue under a separately authorized action. No automatic destructive cleanup is claimed.

## Evidence boundaries

Repository tests cover native concurrent creation, parent replacement, conversion, source/write permissions, sealed corruption, idempotency, response loss, restart and actual SDK in-memory MCP calls through the native writer. These tests are isolated and do not touch installed vault assets. They do not certify transport from a ChatGPT upload to this server, a remote upload endpoint, TLS reachability or Desktop indexing. End-to-end HTTP/server qualification remains `NOT_RUN`; a loopback address or signed URL alone does not solve client ingress.

Use `npm run test:assets` for the bounded repository suite. Exact-SHA CI and distinct review must pass before candidate readiness. Deployment, installing/configuring plugins and upgrading the real vault require a separate authorization and local gate.
