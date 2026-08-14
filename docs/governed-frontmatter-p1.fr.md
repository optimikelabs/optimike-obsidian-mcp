# Projection Frontmatter gouvernée (P1)

Version anglaise : [governed-frontmatter-p1.md](governed-frontmatter-p1.md)

P1 ajoute un domaine de mutation Frontmatter source-preserving au-dessus du
runtime atomique P0 publié. Il n’ajoute pas un autre moteur transactionnel.

## Surface publique

Les quatre outils ne sont disponibles qu’en `live`, ou en `hybrid` avec un
service Obsidian REST et l’Atomic Write Bridge accessibles :

- `obsidian_frontmatter_patch_plan`
- `obsidian_frontmatter_patch_apply`
- `obsidian_frontmatter_patch_status`
- `obsidian_frontmatter_patch_recover`

Un plan P1 public correspond à une seule opération P0
`obsidian.note.replace`. Le `planRef` P1 est opaque. Apply et recover n’acceptent
aucun nouveau chemin, patch, valeur, hash ou Markdown compilé.

## Intention V1 supportée

Une requête cible une note Markdown existante possédant un bloc Frontmatter
standard. Elle contient au maximum 64 opérations top-level uniques :

- `set` : ajouter ou remplacer une clé top-level nue par une valeur compatible
  JSON ;
- `delete` : supprimer une clé top-level existante lorsque sa plage source et
  l’appartenance des commentaires voisins sont non ambiguës.

Le compilateur échoue fermé sur toute source non supportée : clés dupliquées ou
collisionnant par casse, ancres, alias, merge keys, tags YAML explicites, clés
complexes ou quotées, syntaxe multi-document, propriété ambiguë des
commentaires, profondeur excessive, nombres non finis ou valeurs trop grandes.

## Garantie de préservation de la source

P1 n’effectue jamais :

```text
parse YAML -> modifier l’objet -> régénérer tout le YAML
```

Il localise les plages source appartenant aux entrées top-level ciblées et ne
modifie que ces plages. Pour chaque plan admis :

```text
actualDiff(before, after) est inclus dans authorizedChangeSet(intent)
```

Lorsqu’ils ne sont pas ciblés, restent byte-identical :

- le corps Markdown ;
- les fins de ligne ;
- les commentaires ;
- l’ordre, l’écriture, le quoting, l’indentation et la représentation YAML des
  autres clés ;
- chaque segment source hors des plages d’édition autorisées.

La preuve durable de projection ne contient que des digests, opérations, clés,
fins de ligne et plages autorisées. Elle ne contient jamais les valeurs ni le
Markdown suivant.

## Autorité et concurrence

P1 réutilise le journal SQLite P0, ses leases, son fencing par tentative, le CAS
de l’Atomic Write Bridge, ses reçus terminaux, sa réconciliation par status et
sa récupération du plan exact.

Le planning possède deux phases :

1. P1 lit la note live et compile le candidat source-preserving ;
2. P0 relit la même cible et n’admet le candidat que si le SHA-256 et le binding
   backend sont toujours ceux du snapshot du compilateur.

Une modification de la source ou du backend entre ces deux lectures ne crée
aucun plan durable.

La clé d’idempotence publique est hashée dans une clé P0 interne propre au
domaine. Un digest d’intention distinct lie le chemin et les opérations
canoniques :

- même clé publique + même intention retourne le premier gagnant durable, y
  compris lorsqu’un perdant concurrent a compilé un autre snapshot ;
- même clé publique + intention différente est refusée ;
- un drift source refusé avant admission ne réserve pas la clé ;
- l’idempotence directe de P0 reste inchangée.

Status P1 reste un observateur. Il peut déclencher la réconciliation P0 mais ne
peut ni emprunter ni effacer l’autorité d’un exécuteur actif. Un ancien
exécuteur ne peut pas terminaliser une tentative de recovery plus récente.
Après une réponse perdue, appeler status plutôt qu’une nouvelle mutation.
Recover réconcilie ou reprend le même child plan scellé ; ce n’est pas un undo.

## Politique d’écriture

Plan n’est pas read-only : il crée une intention durable. Plan, apply et recover
respectent le mode d’écriture MCP courant. Les clés Frontmatter protégées sont
contrôlées à partir de l’intention P1 explicite, puis de nouveau par P0 sur le
Markdown complet before/after juste avant tout effet possible.

Le cache n’est jamais une autorité d’admission, de CAS, de commit ou de
recovery.

## Frontière d’effet

La garantie atomique couvre une transition de note cible exécutée par
`Vault.process` sous CAS SHA-256 exact. Sync, watchers filesystem, plugins tiers,
indexeurs et automatisations externes restent hors de cette frontière de
récupération.

## Preuves déterministes

Les gates permanentes couvrent :

- un modèle exécutable pur de l’autorité et de l’admission ;
- des fixtures du compilateur en LF et CRLF ;
- le drift source et backend entre compilation et admission ;
- le gagnant same-key et le conflit d’intention ;
- les clés protégées et le changement de politique ;
- plan/apply/recover concurrents avec un seul effet backend ;
- réponse perdue, redémarrage, status et recovery exact ;
- un plan et une preuve de projection partagés par trois sessions HTTP MCP
  indépendantes ;
- l’expurgation des valeurs, du contenu suivant et des chemins privés ;
- Linux et Windows.

## Canary Obsidian live

Utiliser uniquement une note Markdown existante et explicitement jetable. Les
deux clés réservées au canary doivent être absentes au départ :

- `_optimike_p1_canary`
- `_optimike_p1_canary_delete`

PowerShell :

```powershell
$env:OBSIDIAN_FRONTMATTER_CANARY_PATH = "Canary/Frontmatter P1.md"
$env:OBSIDIAN_FRONTMATTER_CANARY_CONFIRM = "I_UNDERSTAND_THIS_NOTE_WILL_BE_TEMPORARILY_PATCHED"
$env:OBSIDIAN_API_KEY = "<cle-local-rest-api>"
$env:MCP_WRITE_MODE = "guarded"
npm run smoke:governed-frontmatter-live
```

Le script sauvegarde le contenu initial avant sa première mutation, prouve
add/set/delete, la relecture exacte, replay, status, le conflit d’un plan périmé
et la restauration du SHA-256 initial. Il échoue fermé et conserve le dossier de
récupération si la restauration ne peut pas être vérifiée.

Aucun PASS live ne doit être annoncé sans une exécution réelle dans Obsidian
Desktop avec l’Atomic Write Bridge.
