# M4 independent review corrections

Codex reviewed ba12bebfb98392f199270953163d19a2281f62f9 and identified two P1 findings.

The creation adapter now supplies parsed top-level YAML keys to the existing MCP protected-key policy at both plan and apply. Quoted keys and YAML merges cannot bypass the check; an empty prior document does not authorize seeding protected metadata. Qualified plugin-generated dates are still a separately sealed settlement allowance, not permission for the caller to set protected keys.

Delayed restart reconciliation now checks plugin timestamps in the bounded window anchored to the durable apply timestamp (at most five minutes), rather than stretching the verifier window to the eventual recovery read. Reading a day later may verify an unchanged early timestamp, but does not admit a timestamp generated a day later. The first-observation quiet delay remains required. No authorship or indefinite timestamp-window guarantee is made.

Local Linux affected evidence: root build; protected-key/quoted/merged YAML and policy-change regressions; a one-day-late restart with lost reply and zero redispatch; late timestamp and body drift negatives; 13 prior durable create cases and in-memory MCP protocol tests. Fresh exact-head Windows/Linux CI and independent rereview must be checked separately. Pilot2 remains NOT_RUN.
