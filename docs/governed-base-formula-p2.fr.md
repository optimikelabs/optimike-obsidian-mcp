# Formules Base gouvernées P2

English version: [governed-base-formula-p2.md](governed-base-formula-p2.md)

P2 ajoute la première mutation gouvernée d’un fichier Obsidian `.base`
existant. La surface reste volontairement plus étroite qu’une édition YAML
arbitraire : elle sait uniquement définir ou supprimer des entrées nommées dans
le mapping top-level `formulas`.

## Surface MCP publique

- `bases_formula_patch_plan`
- `bases_formula_patch_apply`
- `bases_formula_patch_status`
- `bases_formula_patch_recover`

`plan` n’écrit rien. Il lit les bytes exacts via Bases Bridge Atomic V1,
compile l’intention bornée, puis scelle le hash initial, le YAML futur complet,
l’identité du backend, l’idempotence et la preuve de préservation dans le
journal durable privé. `apply` n’accepte que ce plan opaque. Après une réponse
perdue, appeler `status` ; `recover` ne peut reprendre que le même plan scellé
depuis un état durable incertain. Recovery n’est pas undo.

## Garantie exacte

Le compilateur accepte des noms de formules conservateurs, un unique mapping
top-level `formulas` en style bloc, LF ou CRLF, et 32 opérations au maximum. Il
refuse ancres, alias, tags, merge keys, doublons ou collisions de casse, fins de
ligne mélangées, layout YAML ambigu et suppression de la dernière formule. La
casse exacte d’une clé existante est conservée. Tous les bytes hors des plages
de formules autorisées restent identiques. Un fichier sans saut de ligne final
reste supporté : une formule ajoutée reçoit exactement un séparateur de ligne
détecté avant sa nouvelle entrée de mapping.

Bases Bridge Atomic V1 ne cible que les `.base` existantes. Son CAS est lié à
une empreinte stable appareil/installation/coffre et s’exécute via
`Vault.process` avec précondition SHA-256 exacte. Le reçu prouve les hashes
bruts avant/après et la préservation de source. Il ne prétend pas prouver la
validité métier de toute formule dans toute future version d’Obsidian, ni la
fin des effets UI, index ou plugins.

## Gates d’écriture et migration du legacy

Les deux interrupteurs Bases Bridge sont désactivés par défaut :

- **Autoriser le CAS atomique des Bases** active uniquement Atomic V1 typé.
- **Compatibilité : écritures de configuration historiques** réactive
  temporairement les remplacements complets via `PUT /bases/:id/config` et
  `POST /bases`.

La validation seule du legacy reste disponible. Sans le toggle de
compatibilité, les effets `bases_upsert_config` et `bases_create` échouent au
Bridge : ils ne peuvent plus contourner silencieusement la surface gouvernée.
Les upserts de propriétés de notes relèvent d’un autre domaine frontmatter.

En mode `guarded`, la limite configurée de taille d’écriture s’applique au YAML
suivant complet et scellé lors du plan initial, du replay idempotent du plan,
de l’apply et du recover. Aucune phase ne se limite à la taille de l’expression
ou au nombre d’opérations.

## Gate déterministe

```bash
npm run test:governed-base
```

La suite prouve la préservation des bytes, les refus fermés, le CAS Base typé,
plan/apply/status durable, le replay idempotent et une traversée MCP stdio
complète. La publication exige en plus le canary live dans le coffre pilote
Operon Bridge, sur une copie jetable exacte de `PROJETS.base`, avec backup,
conflit de plan périmé, restauration et égalité finale du SHA.
