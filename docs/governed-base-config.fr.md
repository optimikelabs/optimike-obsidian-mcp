# Configuration gouvernée d'une Base

Version anglaise : [governed-base-config.md](governed-base-config.md)

La version 3.17.0 ajoute `bases_config_patch_plan`, `bases_config_patch_apply`,
`bases_config_patch_status` et `bases_config_patch_recover` : la modification
gouvernée d'une Base existante, en entier. Avant elle, seules les formules
(`bases_formula_patch_*`) et les propriétés des notes (`bases_rows_patch_*`)
pouvaient changer sans passer par `bases_upsert_config`, la réécriture complète
que le Bases Bridge refuse tant que l'écriture historique est coupée.

## Opérations

Un plan reçoit 1 à 64 opérations ordonnées, selon la
[syntaxe des Bases](https://obsidian.md/help/bases/syntax) :

| Opération | Effet |
| --- | --- |
| `set_filters` / `delete_filters` | filtres globaux : une expression comme `file.hasTag("book")` ou `{and\|or\|not: [...]}`, imbriqués |
| `set_formula` / `delete_formula` | une formule nommée |
| `set_property` / `delete_property` | un réglage d'une propriété (par exemple `displayName`), ou toute l'entrée |
| `set_summary` / `delete_summary` | un résumé personnalisé avec `values` |
| `add_view` / `delete_view` / `move_view` | une vue avec `type` et un `name` unique, à une position facultative ; une Base garde au moins une vue |
| `set_view_key` / `delete_view_key` | n'importe quelle clé de la vue nommée : `name` (renommer), `type`, `filters`, `order`, `sort`, `groupBy`, `groupOrder`, `summaries`, `limit`, ou une clé de vue ou de plugin |

Les vues se désignent par leur nom exact et unique. Une vue garde son `name` et
son `type`. Une section `formulas`, `properties` ou `summaries` vidée est retirée.
Les types de vue fournis par un plugin (comme `kanban`) sont acceptés avec
l'avertissement `base-view-type-plugin`.

## Garanties

Le plan lit la Base par le Bases Bridge Atomic V1, applique les modifications au
modèle de document YAML (commentaires, ordre des clés et valeurs non touchées
conservés) et compare le résultat à un modèle indépendant de la même intention :
toute autre différence refuse le plan. Le résultat doit passer
`obsidian_validate_format` `kind: base` sans erreur. La preuve du reçu indique
`semantic-identical-outside-authorized-paths`, liste les chemins modifiés et
signale `formattingPreserved: false` quand le fichier ne se relisait pas à
l'octet près avant la modification. Un fichier CRLF reste en CRLF. Les ancres,
alias, tags personnalisés, clés de fusion et fins de ligne mélangées sont refusés.

Apply, status et recover suivent le cycle des formules : même journal, même
remplacement atomique sur le SHA-256 exact et la liaison du backend, même grant
`allowAtomicBaseWrites`. Aucun changement de Bridge. La reprise ne rejoue que le
plan scellé ; ce n'est pas une annulation.

Les refus renvoient des codes `base_config_*` fermés et ne renvoient jamais les
valeurs soumises.

## Tests

```bash
npm run build && node scripts/test-base-config-patch.mjs
```
