# Cockpit des opérations en attente (P5)

English version: [operation-cockpit-p5.md](operation-cockpit-p5.md)

## Objectif

`obsidian_list_pending_operations` permet à un client MCP de reprendre après
un crash, une perte de transport ou une perte de contexte sans connaître déjà
le `planRef`. Il liste uniquement les opérations gouvernées Obsidian dont l'état
durable est `planned`, `applying` ou `outcome_unknown`.

Le cockpit est un inventaire, pas un exécuteur. Il n'appelle aucun backend, ne
lance ni status, ni apply, ni recovery, ne balaie pas les leases, ne purge pas
la rétention et ne modifie aucun journal.

## Contrat public

Entrée :

```json
{ "limit": 50, "cursor": "curseur-opaque-optionnel" }
```

Chaque ligne contient uniquement :

- `operationKind` ;
- le `planRef` métier accepté par les outils status/apply/recover de la famille ;
- `state` ;
- `admittedAt` et `updatedAt` ;
- `ageSeconds` borné ;
- `nextAction` : `apply`, `status` ou `recover`.

La réponse n'expose jamais de chemin du coffre, nom de cible, clé d'idempotence,
contenu de Note ou Canvas, valeur de formule/frontmatter, hash, binding backend,
propriétaire d'exécution, payload d'erreur ou chemin de journal. Le curseur
opaque est versionné et ne contient que la dernière clé publique de tri.

## Familles et routage

| `operationKind`               | Famille correspondante         |
| ----------------------------- | ------------------------------ |
| `obsidian.note.replace`       | `obsidian_note_replace_*`      |
| `obsidian.frontmatter.patch`  | `obsidian_frontmatter_patch_*` |
| `obsidian.base.formula.patch` | `bases_formula_patch_*`        |
| `obsidian.canvas.patch`       | `obsidian_canvas_patch_*`      |
| `obsidian.text.patch`         | `obsidian_text_patch_*`        |

Appeler l'action retournée uniquement dans cette famille métier. En
particulier, `applying` impose status ; ne jamais relancer apply à l'aveugle.
`outcome_unknown` signifie que l'effet du plan exact reste incertain et que le
recovery de la famille peut être nécessaire. Recovery n'est pas undo.

## Autorité durable et isolation

Le cockpit lit les trois journaux déjà ouverts par le runtime courant live ou
hybrid-live : Note (avec les projections Frontmatter et Text Patch), Base
Formula et Canvas. Il ne sonde aucun autre fichier SQLite ou profil de la
machine. Chaque journal conserve son namespace backend/profil et sa rétention.

Les terminaux stables (`committed`, `conflict`, `rejected`, `failed`) ne sont
jamais listés, même lorsqu'ils restent conservés pour replay ou audit.
`outcome_unknown` reste visible parce que son effet n'est pas prouvé et qu'un
recovery exact-plan peut encore être requis.

Operon reste autoritaire séparément via `operon_list_pending_recoveries`. Les
reçus diagnostiques `external_move` sont exclus tant que leur mutation reste
fail-closed. Les écritures directes de compatibilité n'ont pas de reçu durable
et ne peuvent pas apparaître dans ce cockpit.

## Disponibilité

L'outil est read-only et apparaît dans les quatre profils en `live` et
`hybrid-live`. Il est absent des runtimes headless et hybrid-degraded, qui ne
possèdent pas ces journaux live. Le write mode ne change pas l'inventaire ; les
outils apply/recover revalident toujours leurs propres gates de profil,
politique, Bridge, binding et autorisation.

## Vérification

```bash
npm run test:operation-cockpit
npm run test:operation-runtime
npm run test:profiles
npm run test:tool-routing
```

Les fixtures déterministes couvrent la pagination keyset globale, les
timestamps égaux, les cinq familles, l'exclusion des terminaux stables,
l'isolation des journaux, un journal fermé, les sentinelles privées,
l'inspection sans écriture, le stdio et plusieurs sessions MCP HTTP.

La gate de release est un canary live attesté sur le commit exact et une note
jetable du coffre Pilot 2 ouvert. Il utilise des journaux privés dans le dossier
temporaire de l'OS, liste le plan scellé avant apply, vérifie que le plan terminal
disparaît, puis restaure la note octet pour octet. Le dossier de récupération
n'est supprimé qu'après réattestation du contenu original, du chemin du coffre
nommé via Obsidian CLI et du binding Atomic Write. Si un plugin de date pris en
charge (`modified-time`) est actif, le canary le désactive uniquement pendant le
CAS exact de restauration, rétablit son état réel d'activation, puis revérifie
le hash original avant nettoyage.

```powershell
$env:MCP_WRITE_MODE = "guarded"
$env:OBSIDIAN_API_KEY = "<clé Local REST API>"
$env:OBSIDIAN_BASE_URL = "http://127.0.0.1:27233"
$env:OBSIDIAN_OPERATION_COCKPIT_CANARY_VAULT = "operon-bridge-pilot-vault-2.5.0"
$env:OBSIDIAN_OPERATION_COCKPIT_CANARY_PATH = "Canary/modified-time-settlement.md"
$env:OBSIDIAN_OPERATION_COCKPIT_CANARY_CONFIRM = "I_UNDERSTAND_THIS_NOTE_WILL_BE_TEMPORARILY_PATCHED"
$env:OBSIDIAN_OPERATION_COCKPIT_CANARY_EXPECTED_COMMIT = "<SHA candidat de 40 caractères>"
npm run smoke:operation-cockpit-live
```

La commande refuse un worktree sale, un commit différent, une intégration de
date ambiguë, un désaccord coffre nommé/backend ou un binding modifié. Un signal
ferme la gate aux nouvelles mutations tout en laissant la restauration exacte
active.
