# Création gouvernée de Bases et de Canvas

Version anglaise : [governed-file-create.md](governed-file-create.md)

La version 3.16.0 étend la [création durable de notes](durable-note-create-m4.md)
aux deux autres fichiers natifs d’Obsidian qu’un agent construit : la Base
(`.base`) et le Canvas (`.canvas`). Avant elle, un coffre live n’offrait aucun
moyen gouverné de créer l’un ou l’autre : `bases_create` écrit par l’interrupteur
de compatibilité du Bases Bridge, désactivé par défaut, et `obsidian_manage_canvas`
n’est chargé qu’en `headless-filesystem`.

## Surface MCP publique

Deux familles de trois outils, en live uniquement, sans outil de reprise :

- `bases_create_plan`, `bases_create_apply`, `bases_create_status` ;
- `obsidian_canvas_create_plan`, `obsidian_canvas_create_apply`,
  `obsidian_canvas_create_status`.

Elles appartiennent aux groupes `bases.governed` et `canvas.governed` : les
profils `authoring`, `operational` et `full` les exposent, pas `standard` ni
`tasks`. Les opérations en attente apparaissent dans
`obsidian_list_pending_operations` sous `obsidian.base.create` et
`obsidian.canvas.create`, avec `nextAction` `apply` ou `status`, et
`obsidian_operation_close` peut clore une création `outcome_unknown` en
`reviewed_unverified`.

`bases_create` et `obsidian_manage_canvas` ne changent pas. Ils restent les
chemins directs pour les coffres headless ou copiés.

## Plan

`plan` reçoit `path`, le `content` exact et complet, et une `idempotencyKey`.
Il ne crée rien. Il :

1. vérifie le nouveau nom avec les [règles communes de noms](note-name-rules.fr.md)
   et l’extension du type (`.base` ou `.canvas`) ;
2. vérifie les octets : UTF-8 non vide, 2 Mio au plus, sans BOM ni CR isolé ;
3. valide le format :
   - Base : le YAML doit passer `obsidian_validate_format` `kind: base` sans
     erreur et être un mapping non vide. Les avertissements (par exemple un
     tableau `views` absent) restent dans le reçu sous `formatWarnings` ;
   - Canvas : JSON strict, tableaux `nodes` et `edges`, et un graphe accepté par
     le compilateur du [patch Canvas gouverné](governed-canvas-p3.fr.md)
     (identifiants uniques, géométrie entière, taille positive, types de nœud
     connus, arêtes entre nœuds existants), pour que le nouveau Canvas reste
     modifiable par `obsidian_canvas_patch_plan`. `{"nodes":[],"edges":[]}` est
     un Canvas vide valide ;
4. demande au Bridge d’observer l’absence du chemin, puis scelle le contenu, son
   SHA-256, la liaison du Bridge et celle du coffre dans le journal durable
   existant.

Un refus renvoie `VALIDATION_ERROR` avec le `reasonCode`
`create_format_invalid`. Le contenu soumis et les messages du parseur ne sont
jamais renvoyés ; `obsidian_validate_format` liste les problèmes d’un brouillon.

La même clé avec le même chemin et le même contenu rejoue le plan scellé. La
même clé avec une autre intention est refusée (`create_idempotency_conflict`).

## Apply et status

`apply` reçoit le `planRef` et la même `idempotencyKey`. Il revérifie la
politique d’écriture, le grant du Bridge et les deux liaisons, inscrit le jeton
de fence d’effet dans le journal, puis demande à l’Atomic Write Bridge une seule
création exclusive (`O_CREAT | O_EXCL`, fsync des données). Un fichier existant
n’est jamais écrasé, aucun suffixe n’est ajouté et le dossier parent n’est
jamais créé. Le Bridge relit le contenu avant l’effet : mapping YAML pour une
Base (`parseYaml` d’Obsidian), objet JSON avec tableaux `nodes` et `edges` pour
un Canvas.

`status` observe le fichier sans écrire. Seuls les octets scellés exacts
vérifient la création : contrairement aux notes Markdown, aucun champ de date
automatique ni aucune réécriture de plugin n’est excusé. Après une réponse
perdue, status réconcilie depuis le fichier. Un fichier présent avec d’autres
octets fait passer la tentative en `outcome_unknown` ; il n’est jamais écrasé,
supprimé ni recréé. `committed` signifie que les octets prévus ont été
observés, pas que cette tentative en est l’autrice, et l’indexation Obsidian
n’est pas certifiée.

## Grants du Bridge

Atomic Write Bridge 0.9.0 ajoute deux réglages, désactivés par défaut et
indépendants de la création de notes :

- **Autoriser la création exclusive de Bases** (`allowBaseCreates`) ;
- **Autoriser la création exclusive de Canvas** (`allowCanvasCreates`).

Le statut du Bridge les expose sous `baseCreate` et `canvasCreate`. Chaque type
a sa propre empreinte de liaison : un plan de Base ne peut pas s’appliquer comme
une note ou un Canvas. Le MCP exige aussi `MCP_WRITE_MODE` `guarded` ou `full` ;
`readonly` refuse les nouveaux plans et les effets. Un Bridge plus ancien n’a
pas de capacité `baseCreate` / `canvasCreate` : le plan est refusé avec
`create_bridge_unsupported` et le diagnostic de capacités indique
`bridge_contract_incompatible` avec `update_bridge_contract`.

| Situation | Résultat |
| --- | --- |
| nom, extension, octets ou format invalides | plan refusé, rien de scellé |
| cible existante, ou voisin replié (casse/Unicode) | plan refusé (`409` / `note_name_case_collision`) |
| dossier parent absent | plan refusé (`file_create_parent_missing`) |
| grant du Bridge coupé ou liaison du coffre changée après le plan | apply refusé avant tout effet |
| cible apparue après le plan | `conflict` terminal, fichier intact |
| réponse perdue après l’envoi | `status` réconcilie depuis les octets exacts |
| autres octets observés | `outcome_unknown`, fichier conservé, aucun rejeu |

## Limites

Ce n’est pas un éditeur de Base ou de Canvas. Modifier une Base existante reste
limité aux formules (`bases_formula_patch_*`) et aux propriétés des notes
(`bases_rows_patch_*`) ; les vues et filtres d’une Base existante n’ont pas de
mutation gouvernée. Modifier un Canvas existant passe par
`obsidian_canvas_patch_*`. La validation de format n’évalue ni les formules, ni
les filtres, ni le rendu d’Obsidian. La frontière de confiance et le cas du
fichier partiel sont ceux de la [création de notes](durable-note-create-m4.md).

## Tests

```bash
npm run build && node scripts/test-vault-file-create.mjs
npm --prefix plugins/obsidian-atomic-write-bridge run check
```

La suite MCP couvre plan/apply/status, le rejeu idempotent, les refus de format
sans écho du contenu, le mauvais type et la mauvaise référence, les changements
de grant et de liaison, un Bridge ancien, une réponse perdue, un fichier réécrit
et une cible occupée. La suite du Bridge couvre la création exclusive, les
empreintes liées au type, les grants coupés, les chemins dangereux, le parent
absent, le contenu invalide et une fence d’effet qui refuse. La première
admission exige aussi le cycle live Pilot 2 décrit dans
[Bundle des Bridges](bridge-packaging.fr.md).
