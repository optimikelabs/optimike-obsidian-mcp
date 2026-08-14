from pathlib import Path
import json


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    Path(path).write_text(content, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    source = read(path)
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one anchor, found {count}: {old[:100]!r}")
    write(path, source.replace(old, new, 1))


def insert_before(path: str, heading: str, block: str) -> None:
    replace_once(path, heading, block.rstrip() + "\n\n" + heading)


package_path = Path("package.json")
package = json.loads(package_path.read_text(encoding="utf-8"))
for item in [
    "docs/governed-frontmatter-p1.md",
    "docs/governed-frontmatter-p1.fr.md",
    "docs/adr/ADR-Governed-Frontmatter-P1.md",
    "docs/operon-cli-audit.md",
    "docs/operon-cli-audit.fr.md",
    "docs/tree.md",
]:
    if item not in package["files"]:
        package["files"].append(item)
package["scripts"]["test:governed-frontmatter"] = (
    "npm run build && node scripts/test-governed-frontmatter-model.mjs "
    "&& node scripts/test-frontmatter-p1-compiler.mjs "
    "&& node scripts/test-governed-frontmatter-mcp.mjs "
    "&& node scripts/test-governed-frontmatter-http.mjs"
)
package["scripts"]["smoke:governed-frontmatter-live"] = (
    "npm run build && node scripts/smoke-governed-frontmatter-live.mjs"
)
package["scripts"]["test:docs"] = (
    "npm run test:visuals && node scripts/test-doc-contract.mjs "
    "&& node scripts/test-governed-frontmatter-doc-contract.mjs"
)
package_path.write_text(
    json.dumps(package, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
)

replace_once(
    "CHANGELOG.md",
    "## [Unreleased]\n\n",
    """## [Unreleased]

### Added

- Governed source-preserving Frontmatter P1 surface:
  `obsidian_frontmatter_patch_plan`, `obsidian_frontmatter_patch_apply`,
  `obsidian_frontmatter_patch_status`, and
  `obsidian_frontmatter_patch_recover`.
- Executable authority/admission model, conservative top-level YAML compiler,
  real stdio and HTTP multi-session gates, and a fail-closed live Obsidian
  canary with exact backup/restoration.

### Changed

- Frontmatter intentions compile into complete Markdown candidates and reuse the
  released P0 journal, leases, attempt fencing, CAS, receipts, status, and
  exact-plan recovery. No second transaction engine or generic public
  `operation_*` surface is introduced.
- P0 accepts optional internal projection metadata and expected source proof
  while preserving direct note-replacement digest semantics.

### Security

- Every byte outside explicitly authorized top-level Frontmatter entry ranges
  remains unchanged. Ambiguous YAML and comment ownership fail closed; cache
  state is never an admission or mutation authority.

""",
)

insert_before(
    "docs/obsidian_mcp_tools_spec.md",
    "## Metadata And Tags",
    """## Governed Frontmatter Projection (P1)

Available only in `live`, or `hybrid` with a reachable Local REST API and
Atomic Write Bridge. P1 compiles bounded top-level Frontmatter intentions into
complete Markdown and delegates one sealed child plan to the existing P0
operation runtime.

- `obsidian_frontmatter_patch_plan`: compile source-preserving `set` and
  `delete` operations, prove the authorized ranges, revalidate source
  SHA-256/backend binding, and persist no effect.
- `obsidian_frontmatter_patch_apply`: apply only the exact sealed child plan
  with the matching public idempotency key.
- `obsidian_frontmatter_patch_status`: read/reconcile the projected P0 receipt
  without obtaining executor authority.
- `obsidian_frontmatter_patch_recover`: recover the exact child plan; recovery
  is not undo and accepts no new patch.

Unsupported or ambiguous YAML fails closed. The Markdown body, line endings,
comments, ordering, quoting, indentation, and all non-target source ranges
remain byte-identical. See [the P1 contract](governed-frontmatter-p1.md).""",
)

insert_before(
    "docs/runtime-capability-matrix.md",
    "## Safety Notes",
    """## Governed Frontmatter P1

`obsidian_frontmatter_patch_plan`, `obsidian_frontmatter_patch_apply`,
`obsidian_frontmatter_patch_status`, and
`obsidian_frontmatter_patch_recover` are registered only in `live`, or
`hybrid` with API credentials. They reuse the default-off Atomic Write Bridge
and P0 durable authority. They are absent from every headless mode and degraded
hybrid operation.""",
)
insert_before(
    "docs/runtime-capability-matrix.fr.md",
    "## Notes de sécurité",
    """## Frontmatter gouvernée P1

`obsidian_frontmatter_patch_plan`, `obsidian_frontmatter_patch_apply`,
`obsidian_frontmatter_patch_status` et
`obsidian_frontmatter_patch_recover` ne sont enregistrés qu’en `live`, ou en
`hybrid` avec identifiants API. Ils réutilisent l’Atomic Write Bridge désactivé
par défaut et l’autorité durable P0. Ils sont absents des modes headless et du
mode hybrid dégradé.""",
)

replace_once(
    "README.md",
    "| Notes                   | Read, list, search, update, frontmatter and tags                       | Vault; Local REST API for the full live surface    |",
    "| Notes                   | Read/search/update plus governed atomic note and source-preserving Frontmatter plans | Vault; Local REST API + Atomic Write Bridge for governed CAS |",
)
replace_once(
    "README.md",
    "- bundled **Optimike Atomic Write Bridge**: opt-in SHA-256 compare-and-replace backing governed whole-note `plan → apply → status → recover`; opaque `planRef`, lost response → `status`, exact-plan recovery ≠ undo ([contract](docs/governed-note-replacement.md));",
    "- bundled **Optimike Atomic Write Bridge**: opt-in SHA-256 compare-and-replace backing governed whole-note and source-preserving Frontmatter `plan → apply → status → recover`; opaque `planRef`, lost response → `status`, exact-plan recovery ≠ undo ([note contract](docs/governed-note-replacement.md), [P1 contract](docs/governed-frontmatter-p1.md));",
)
replace_once(
    "README.fr.md",
    "| Notes                   | Lecture, liste, recherche, mise à jour, frontmatter et tags          | Coffre ; Local REST API pour la surface live complète |",
    "| Notes                   | Lecture/recherche/update plus plans gouvernés de note atomique et Frontmatter source-preserving | Coffre ; Local REST API + Atomic Write Bridge pour le CAS gouverné |",
)
replace_once(
    "README.fr.md",
    "- **Optimike Atomic Write Bridge** inclus : compare-and-replace SHA-256 opt-in pour le remplacement gouverné d’une note complète `plan → apply → status → recover` ; `planRef` opaque, réponse perdue → `status`, recovery du plan exact ≠ undo ([contrat](docs/governed-note-replacement.fr.md)) ;",
    "- **Optimike Atomic Write Bridge** inclus : compare-and-replace SHA-256 opt-in pour les plans gouvernés de note complète et Frontmatter source-preserving `plan → apply → status → recover` ; `planRef` opaque, réponse perdue → `status`, recovery exact ≠ undo ([note](docs/governed-note-replacement.fr.md), [P1](docs/governed-frontmatter-p1.fr.md)) ;",
)

insert_before(
    "docs/README.md",
    "## Capability families",
    "Governed source-preserving Frontmatter: [P1 contract](governed-frontmatter-p1.md).",
)
insert_before(
    "docs/README.fr.md",
    "## Familles de capacités",
    "Frontmatter gouvernée source-preserving : [contrat P1](governed-frontmatter-p1.fr.md).",
)

insert_before(
    "OPERATIONS.md",
    "## Tasks: How It Works Now",
    """## Governed frontmatter P1

P1 accepts bounded top-level `set`/`delete` intentions and compiles them without
globally serializing YAML. All non-target source bytes remain identical. The
safe client sequence is `obsidian_frontmatter_patch_plan → apply → status →
recover`; after an uncertain response, call status first. The P1 receipt is a
projection of the same P0 child operation and journal.

Run deterministic gates with:

```bash
npm run test:governed-frontmatter
```

The live gate requires an explicitly disposable note and reserved canary keys
that are absent before the run:

```bash
OBSIDIAN_FRONTMATTER_CANARY_PATH="Canary/Frontmatter P1.md" \\
OBSIDIAN_FRONTMATTER_CANARY_CONFIRM=I_UNDERSTAND_THIS_NOTE_WILL_BE_TEMPORARILY_PATCHED \\
OBSIDIAN_API_KEY="<local-rest-api-key>" MCP_WRITE_MODE=guarded \\
npm run smoke:governed-frontmatter-live
```

The script announces an operating-system temporary recovery directory, writes
a private backup before mutation, proves add/set/delete, replay/status/stale
conflict and exact SHA restoration, then deletes the private run directory only
after restoration is verified.""",
)
insert_before(
    "OPERATIONS.fr.md",
    "## Tasks : comment ça marche maintenant",
    """## Frontmatter gouvernée P1

P1 accepte des intentions top-level `set`/`delete` bornées et les compile sans
resérialiser globalement le YAML. Tous les bytes hors cible restent identiques.
La séquence sûre est `obsidian_frontmatter_patch_plan → apply → status →
recover` ; après une réponse incertaine, appeler d’abord status. Le reçu P1
projette le même child plan et le même journal P0.

Gates déterministes :

```bash
npm run test:governed-frontmatter
```

Canary live sur une note explicitement jetable :

```powershell
$env:OBSIDIAN_FRONTMATTER_CANARY_PATH = "Canary/Frontmatter P1.md"
$env:OBSIDIAN_FRONTMATTER_CANARY_CONFIRM = "I_UNDERSTAND_THIS_NOTE_WILL_BE_TEMPORARILY_PATCHED"
$env:OBSIDIAN_API_KEY = "<cle-local-rest-api>"
$env:MCP_WRITE_MODE = "guarded"
npm run smoke:governed-frontmatter-live
```

Le script annonce un dossier temporaire système de récupération, écrit un
backup privé avant mutation, prouve add/set/delete, replay/status/conflit périmé
et la restauration exacte du SHA, puis ne supprime le dossier privé qu’après
vérification de la restauration.""",
)

insert_before(
    "SECURITY.md",
    "## Dependency and release checks",
    """## Governed frontmatter boundary

P1 changes only explicitly authorized top-level Frontmatter source ranges.
Unsupported YAML or ambiguous comment ownership fails closed. It never treats
cache content as admission, CAS, commit, or recovery authority. P1 uses the P0
journal and attempt fencing; no observer can borrow executor authority and no
second recovery engine exists.

The durable projection stores hashes and ranges, not patched values or compiled
Markdown. Protected keys and the current write mode are checked at planning and
before every possible P0 effect.""",
)
insert_before(
    "SECURITY.fr.md",
    "## Contrôles dépendances et release",
    """## Frontière Frontmatter gouvernée

P1 ne modifie que les plages source top-level explicitement autorisées. Tout
YAML non supporté ou commentaire d’appartenance ambiguë échoue fermé. Le cache
ne devient jamais une autorité d’admission, de CAS, de commit ou de recovery. P1
réutilise le journal et le fencing P0 ; aucun observateur ne peut emprunter
l’autorité d’un exécuteur et aucun second moteur de récupération n’est créé.

La projection durable conserve hashes et plages, jamais les valeurs patchées ni
le Markdown compilé. Les clés protégées et le write mode courant sont contrôlés
au planning puis avant chaque effet P0 possible.""",
)

annotations = Path("scripts/test-tool-annotations.mjs")
source = annotations.read_text(encoding="utf-8")
old = '''  "obsidian_note_replace_recover",
];'''
new = '''  "obsidian_note_replace_recover",
  "obsidian_frontmatter_patch_plan",
  "obsidian_frontmatter_patch_apply",
  "obsidian_frontmatter_patch_status",
  "obsidian_frontmatter_patch_recover",
];'''
if source.count(old) != 1:
    raise SystemExit("tool annotation governed-list anchor missing")
source = source.replace(old, new, 1)
source = source.replace(
    "governed note tools are unique",
    "governed note/frontmatter tools are unique",
)
annotations.write_text(source, encoding="utf-8")

package_test = Path("scripts/test-package-contents.mjs")
source = package_test.read_text(encoding="utf-8")
old = '''  "docs/governed-note-replacement.fr.md",
  "docs/adr/README.md",'''
new = '''  "docs/governed-note-replacement.fr.md",
  "docs/governed-frontmatter-p1.md",
  "docs/governed-frontmatter-p1.fr.md",
  "docs/adr/ADR-Governed-Frontmatter-P1.md",
  "docs/adr/README.md",'''
if source.count(old) != 1:
    raise SystemExit("package required-files anchor missing")
source = source.replace(old, new, 1)
old = '''  "scripts/smoke-atomic-note-mcp-live.mjs",'''
new = '''  "scripts/smoke-atomic-note-mcp-live.mjs",
  "scripts/test-governed-frontmatter-mcp.mjs",
  "scripts/test-governed-frontmatter-http.mjs",
  "scripts/smoke-governed-frontmatter-live.mjs",'''
if source.count(old) != 1:
    raise SystemExit("package script anchor missing")
package_test.write_text(source.replace(old, new, 1), encoding="utf-8")

print("Integrated P1 docs and package metadata.")
