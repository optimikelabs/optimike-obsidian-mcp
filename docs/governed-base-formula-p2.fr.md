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

Ancres, alias, tags et merge keys sont identifiés depuis les nœuds YAML parsés,
pas par simple recherche de caractères. Les mêmes indicateurs restent du
contenu ordinaire dans les scalaires quotés, les scalaires bloc et les
commentaires. Les scalaires de formule multilignes hors style bloc échouent
fermés, car leurs frontières source ne font pas partie de la V1.
Les ranges des nœuds parsés définissent aussi les fins d’entrées et le point
d’ajout : une ligne de scalar bloc qui ressemble à une ligne vide ou à un
commentaire reste attachée à sa formule d’origine.

Bases Bridge Atomic V1 ne cible que les `.base` existantes. Son CAS est lié à
une empreinte stable appareil/installation/coffre et s’exécute via
`Vault.process` avec précondition SHA-256 exacte. Le reçu prouve les hashes
bruts avant/après et la préservation de source. Il ne prétend pas prouver la
validité métier de toute formule dans toute future version d’Obsidian, ni la
fin des effets UI, index ou plugins.

## Vérification par le moteur d’Obsidian

Avant de sceller, `plan` demande à la route moteur du Bases Bridge d’évaluer
deux fois toutes les formules de la Base : telle qu’enregistrée et telle que
prévue. Une formule que la Base prévue fait passer en `syntax_error` ou
`runtime_error`, et qui n’avait pas déjà ce statut, refuse le plan avec le
code `base_formula_engine_error` : rien n’est scellé ni écrit. Le champ
`formulaCheck` du refus donne, par formule, jusqu’à trois messages du moteur,
les fonctions inconnues appelées (appels `name(` et `.name(` absents du
registre de fonctions de l’Obsidian installé, avec le type quand il se déduit),
les fonctions valides pour ce type et jusqu’à trois noms proches. Les erreurs
déjà présentes dans la Base enregistrée ne bloquent pas. Une formule dont toutes
les valeurs sont vides (`all_null`) donne un avertissement, jamais un refus.

Le reçu du plan porte `engineCheck`, scellé avec le plan et rendu tel quel par
un rejeu et par `status` :

- `{ "status": "verified", "obsidianVersion": "…" }`, avec `warnings` pour les
  formules `all_null` ou `not_evaluated`, quand les deux évaluations ont
  réussi ;
- `{ "status": "unverified", "reason": "…" }` sinon : Obsidian fermé, Bridge
  sans route moteur (`bridge_route_missing`), canary moteur en échec, version
  d’Obsidian non prise en charge ou réponse inexploitable. Le plan continue
  alors comme avant ; il n’est jamais déclaré vérifié.

La vérification n’a lieu qu’au plan. `apply`, `status` et `recover` sont
inchangés. Hors plan, l’outil en lecture seule `bases_check` donne les mêmes
statuts pour une Base ou pour toutes, et `bases_functions` liste les fonctions
acceptées par l’Obsidian installé, groupées par type ou détaillées pour un type. Syntaxe des formules : <https://help.obsidian.md/bases/syntax> ;
fonctions : <https://help.obsidian.md/bases/functions>.

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
complète. L’admission initiale de la fonctionnalité et les parcours Base modifiés ou non qualifiés exigent en plus le canary live dans le coffre pilote
Operon Bridge, sur une copie jetable exacte de `PROJETS.base`, avec backup,
conflit de plan périmé, restauration et égalité finale du SHA.

La sélection des recettes suit la [qualification proportionnée](bridge-packaging.fr.md#qualification-proportionnée-des-releases). Un parcours inchangé peut réutiliser une preuve réussie applicable ; un changement documentaire ou de métadonnées seul ne rejoue pas ce canary. Une première admission sans preuve, un changement pertinent ou un échec non résolu exige une qualification. Les gardes runtime et les garanties de restauration restent inchangés.
