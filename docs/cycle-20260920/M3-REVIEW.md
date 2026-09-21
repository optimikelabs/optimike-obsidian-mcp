# M3 review corrections

Independent Codex review of `2d3741022456a13c61482f5b6944860360ff31c2` found two P2 issues. Both are corrected in this checkpoint.

1. An identity-checked pre-effect conflict receipt returned by backend status now reconciles the durable applying/unknown row to conflict. It no longer remains indefinitely pending after a lost apply response. The regression exercises lost conflict, status, repeat apply and exactly one dispatch.
2. Completed backend receipts use bounded TTL/LRU retention rather than permanently filling 128 entries / 8 MiB. They are retained through the five-second graph observation window, then may be evicted under pressure; ten minutes without access expires a completed receipt on subsequent admission. In-flight and uncertain receipts are never evicted by this policy. Exhaustion by uncertain entries deliberately remains fail-closed. Durable MCP rows still prevent replay. The backend acknowledgement window is not a durable history: an evicted status becomes outcome_unknown; historical MCP committed outcome survives, but graph postflight may become indeterminate. This is not proof of absence or permission to redispatch.

Local regression evidence: root TypeScript build; 13 durable move scenarios; Bridge typecheck/unit tests/build, including 140 sequential moves and retention of uncertain effects. Fresh exact-SHA GitHub CI and rereview must be checked separately. Pilot2 remains NOT_RUN.

All temporary object-preparation workflows and recipe files are excluded from this source tree. Current branch HEAD is the candidate authority; this file does not self-reference its own commit.
