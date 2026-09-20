# M4 independent review corrections

Codex identified two P1 findings on ba12beb and additional P2 findings on ba12beb/01f88e0. All corrections below are in this candidate; fresh exact-head CI and independent rereview remain separate gates.

Protected creation keys: the MCP adapter parses actual top-level YAML keys, including quoted/merged keys, and invokes the existing protected metadata policy at both plan and apply. Creating an empty document does not authorize seeding protected keys. This YAML dependency stays in the MCP adapter, not in the shared dependency-free Bridge contract.

Delayed restart: plugin timestamp evidence is restricted to the <=five-minute window anchored to the durable apply timestamp. Reading a day later may verify an early timestamp but cannot admit a timestamp generated near the late read. First-observation settling delay remains required; no author-attribution guarantee is made.

Multiple automatic dates: reconcile qualified missing fields in their observed order and position, not alphabetic policy order. Every intermediate delta still passes the shared one-timestamp verifier. Unrelated metadata, body changes, late timestamps and replacement of a preexisting creation date remain rejected. Regression cases cover reversed custom field names, insertion between ordinary fields and CRLF.

Standalone Bridge: moved YAML key parsing to the MCP-only adapter. The shared contract again depends only on Node builtins and local pure modules. Added a separate Windows/Linux job that installs only Bridge dependencies, with no root npm ci. Locally, Bridge check passed with the root node_modules path physically unavailable: typecheck, 49 tests and bundle build.

Additional local evidence: root compilation, protected/quoted/merged-key and policy-change regressions, one-day restart/lost-reply proof and all previous creation/protocol cases. Pilot2 remains NOT_RUN. No temporary workflow or recipe is introduced by these corrections.
