# M5 independent review correction — evaluated Base snapshot

Codex identified an A-B-A selection race on eb39324: surrounding reads of Base A do not prove that the query evaluated A rather than a transient B.

Bases Bridge 1.2.2 now captures path/SHA/binding from the exact YAML bytes parsed by readBaseConfig and carries that immutable snapshot into its fallback query response. The row reader requires this proof and compares it with its preflight snapshot. It refuses old Bridges without the proof, mismatched evaluated YAML and another backend binding. A reread is not used to manufacture query provenance.

The existing second read remains an additional drift check. No atomicity is claimed between Base selection and the note CAS, no metadata-cache freshness is invented, and no native-engine completeness is promised.

Local Linux and sealed GitHub preparation run 35540939312 passed 23 selection fixtures, 15 durable CAS/MCP cases and Bases Bridge check (34 tests, typecheck and bundle). The exact prepared objects are attached to this candidate. The regression includes unchanged surrounding A reads with a B query proof, a missing proof and a foreign binding; the Bridge test guards same-read provenance.

The latest M4 packaging fix is inherited without dropping the M5 contract or changing any dependency range. All ABA/package preparation workflows and recipes are absent from this tree. Fresh exact-head Windows/Linux CI and independent rereview remain separate gates; Pilot2 is NOT_RUN and no merge is authorized here.
