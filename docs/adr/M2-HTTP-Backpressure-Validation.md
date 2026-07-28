# M2 HTTP backpressure validation gates

M2 is acceptable only when all of the following are proved on the stacked branch:

- global, per-identity, expensive-operation and mutation ceilings are never exceeded;
- the global and per-identity queues remain bounded;
- round-robin dispatch prevents one identity from starving another;
- timeout, cancellation, downstream error and success always leave aggregate in-flight state at zero;
- an admission failure returns `503` and `Retry-After` before the tool executes;
- the transport never retries a mutation;
- existing CAS, idempotency, external-move journal and Operon mutation contracts remain green;
- M1 session reservation and expiry proofs remain green on Ubuntu and Windows.

This milestone changes admission only. It does not change authorization, write policy, path confinement, mutation semantics, rollback or the HTTP absence of `external_move_*`.
