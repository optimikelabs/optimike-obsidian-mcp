# Obsidian Bases Bridge

Plugin compagnon pour **optimike-obsidian-mcp**. Il ajoute une vue headless « Bridge (Headless) » et étend **Obsidian Local REST API** avec des routes spécialisées pour les fichiers `.base`. Depuis 1.1.0, il fournit aussi un CAS typé lié au coffre pour la surface gouvernée de formules. La version 1.2.1 supervise durablement Local REST et la vue headless, et est distribuée dans le bundle Optimike exact-SHA : un démarrage tardif ou un reload remonte une seule génération sans redémarrer le MCP et sans modifier les gates d’écriture.

## Installation rapide

1. Télécharger l’artefact CI `obsidian-bases-bridge`, ou construire le plugin avec `npm ci` puis `npm run check` dans ce dossier.
2. Créer `.obsidian/plugins/obsidian-bases-bridge/` et y copier `main.js` et `manifest.json` depuis l’artefact ou depuis `build/`.
3. Lancer Obsidian → _Settings → Community plugins_ → activer **Bases Bridge (REST)**.
4. Vérifier que le plugin **Local REST API** est actif (v3.x) et que le coffre est autorisé.
5. Garder le plugin cœur **Bases** actif : les formules sont calculées par son moteur (voir [Requêtes](#requêtes-query)). La vue « Bridge (Headless) » n’est plus nécessaire pour obtenir des valeurs évaluées.

La CI exécute les tests, construit le plugin et publie ces deux fichiers installables. Le package MCP vérifie également qu’ils sont bien présents avant distribution.

## Capture native utilisée par les tests

La [fixture synthétique](src/fixtures/bases-native-1.15.1.json) est un extrait
d’une capture sous Obsidian **1.15.1** avec Bases actif. Le banc a lancé
Obsidian Desktop avec un profil temporaire, un coffre de notes synthétiques
et le fuseau `Europe/Paris`. Après vérification du profil, du coffre et de
son indexation, il a figé l’horloge JavaScript au `2026-03-29T00:30:00.000Z`.

- Pour Top et Label, le banc a appelé le handler `base:query` avec le
  chemin de la Base, le nom de la vue et `format: "json"`. Ces deux cas
  utilisent `Notes/a.md`, `Notes/b.md`, `Notes/c.md` et `Other/z.md`,
  les formules `link(file, file.name)` et `file.name + "!"`, et une vue
  limitée à deux notes dans `Notes`. Label ajoute le nom de colonne `Label`.
- Pour les diagnostics, le banc a appelé les fonctions du Bridge sur quatre
  notes `Data/Diag/a.md` à `Data/Diag/d.md` avec le même handler natif.
  La fixture conserve les statuts et les échantillons projetés par le Bridge.
  Les cas du rejeu MCP reprennent les messages des cellules natives et les
  statuts correspondants. Par exemple, `file.name.LOWER()` donne des noms de
  notes et une formule vide donne `all_null`.

La capture UTC du même banc a donné les mêmes valeurs pour les cas retenus.
Pour actualiser la référence, refaire une capture avec la version cible dans
un profil isolé, puis examiner les écarts. `npm run check:bases-bridge` depuis
la racine compare le handler simulé à la référence 1.15.1. Les compteurs
d’appels, les pannes injectées et les limites de pagination testent le
comportement du Bridge en simulation.

## Endpoints exposés

Préfixe officiel (recommandé) :

- `GET /extensions/obsidian-bases-bridge/bases`
- `GET /extensions/obsidian-bases-bridge/bases/:id/schema`
- `POST /extensions/obsidian-bases-bridge/bases/:id/query`
- `POST /extensions/obsidian-bases-bridge/bases/:id/upsert`
- `POST /extensions/obsidian-bases-bridge/bases`
- `GET /extensions/obsidian-bases-bridge/bases/:id/config`
- `PUT /extensions/obsidian-bases-bridge/bases/:id/config`
- `POST /extensions/obsidian-bases-bridge/engine/evaluate`
- `GET /extensions/obsidian-bases-bridge/engine/functions`
- `GET /extensions/obsidian-bases-bridge/atomic/status`
- `POST /extensions/obsidian-bases-bridge/atomic/bases/read`
- `POST /extensions/obsidian-bases-bridge/atomic/bases/cas`

Alias legacy (compat MCP) :

- `GET /bases`
- `GET /bases/:id/schema`
- `POST /bases/:id/query`
- `POST /bases/:id/upsert`
- `POST /bases`
- `GET /bases/:id/config`
- `PUT /bases/:id/config`

Les routes héritent de l’authentification Bearer + TLS local du plugin REST.

## Moteur d’Obsidian (`/engine/*`)

Ces deux routes lisent sans écrire. Elles répondent toujours `200` avec
`available`, sauf un corps de requête invalide (`400`,
`reason: "invalid_request"`).

### `POST /engine/evaluate`

Corps : `{ "path": "Dossier/X.base", "yaml"?: string, "formulas"?: string[] }`.
Sans `yaml`, la Base est évaluée telle qu’elle est enregistrée. Sans
`formulas`, toutes les formules de la Base candidate sont évaluées.

Le calcul passe par le handler CLI natif `base:query` du plugin cœur Bases
(`app.cli.handlers`), pas par un évaluateur du Bridge. Le Bridge prépare en
mémoire une Base candidate avec `parseYaml`/`stringifyYaml` : une vue de sonde
sans filtre de vue, limitée à 100 lignes, une formule de sonde `if(false, EXPR, "PARSED")`
par formule et deux formules canari. Le handler la reçoit par une interception
unique de `app.vault.cachedRead` pour ce chemin exact, restaurée dans un
`finally`. Les appels sont sérialisés. Aucun fichier n’est modifié.

Le moteur s’exécute sur le fil principal d’Obsidian : tant qu’il calcule,
Obsidian ne répond plus. Chaque formule est donc évaluée sur au plus
100 lignes (`rowLimit`), les premières que retiennent les filtres globaux de la
Base, quelle que soit la limite des vues. Une erreur de syntaxe ou une fonction
inconnue échoue sur n’importe quelle ligne ; une erreur qui ne touche que des
lignes plus loin, ou une formule vide seulement sur ces 100 lignes, peut
échapper à l’échantillon. Mesuré sur 8 000 notes liées avec des formules
`file.backlinks` : toutes les lignes 15,9 s, Obsidian bloqué tout ce temps ;
200 lignes 0,4 s.

```json
{ "available": true, "engine": "obsidian", "obsidianVersion": "1.15.1",
  "canary": { "ok": true }, "rowLimit": 100,
  "formulas": { "total": { "status": "runtime_error", "rows": 100,
    "errorRows": 2, "nullRows": 3,
    "samples": [ { "path": "a.md", "message": "Error: ..." } ] } },
  "warnings": [] }
```

`rows` vaut le nombre de lignes évaluées : égal à `rowLimit`, la Base en a
peut-être davantage.

Statuts, par ordre de priorité :

- `syntax_error` : la sonde ne renvoie pas `PARSED` (Obsidian rend `null`
  pour une formule qu’il ne sait pas analyser).
- `runtime_error` : au moins une valeur commence par `Error:` (message
  localisé, non analysé ; au plus 3 exemples dans `samples`).
- `all_null` : des lignes existent et toutes valent `null` ou vide.
- `ok` sinon ; `not_evaluated` quand aucune ligne ne correspond, ou pour une
  formule demandée absente de la Base (avertissement
  `formula_not_found:<nom>`).

À chaque appel, une formule canari correcte doit être `ok` et une formule
canari fautive (fonction inconnue) doit être en `runtime_error`, sinon la
réponse est `{ "available": false, "reason": "canary_failed" }`. Sans ligne
dans la Base, le canari est vérifié sur une note du coffre.

Indisponibilités (`formulas: {}`) : `engine_unavailable` (handler absent, par
exemple plugin cœur Bases désactivé), `canary_failed`,
`unsupported_obsidian` (avant Obsidian 1.15.0, première version prouvée),
`base_not_found`, `invalid_yaml`.

Limites :

- Le handler natif résout la Base par l’index du coffre : le fichier `.base`
  doit exister, même quand `yaml` fournit une candidate
  (`base_not_found` sinon).
- Une valeur légitime qui commence par `Error:` compte comme une erreur
  d’exécution.
- Une exception levée pendant le calcul d’une cellule devient une cellule
  vide dans la sortie native, donc un `null`.

### `GET /engine/functions?on=<Type>`

Renvoie le registre des fonctions de formule de la version installée :

```json
{ "available": true, "obsidianVersion": "1.15.1",
  "source": "obsidian-app-bundle",
  "functions": [ { "name": "round", "on": "Number",
    "params": [ { "name": "digits", "types": ["Number"],
      "optional": true, "variadic": false } ],
    "doc": "Rounds the number to the nearest integer." } ],
  "warnings": [] }
```

Le registre n’est pas dans l’API publique. Le Bridge lit le bundle en cours
d’exécution (`fetch("app.js")`) et retrouve les enregistrements
`<id>.addGlobal(new class …)` / `<id>.addForType(<Type>,new class …)`, sans
identifiant minifié codé en dur : il exige un récepteur unique et découvre les
constructeurs de paramètres et les noms de type dans le bundle. `on` vient de
la clé de documentation (`labelStringLower` → `String`, `labelValue…` →
`Any`), `Global` pour les fonctions globales. Les fonctions d’instance ne
listent pas leur premier paramètre (`self`), comme l’autocomplétion
d’Obsidian. `doc` vient de `i18next` (`formulas.funcs.<clé>`), `null` sinon.
`on` filtre sans tenir compte de la casse.

Le résultat est mis en cache par version d’Obsidian. Garde-fou : moins de 60
fonctions, ou absence de `if`, `now` ou `link`, donne
`{ "available": false, "reason": "canary_failed", "functions": [] }` ; un
bundle illisible donne `engine_unavailable`.

## Écritures de configuration

Les écritures sont désactivées par défaut. Le réglage **Autoriser le CAS
atomique des Bases** active uniquement le contrat Atomic V1 : fichier `.base`
existant, empreinte exacte du backend, précondition SHA-256 et remplacement via
`Vault.process`. Le réglage de compatibilité legacy réactive explicitement les
remplacements complets via `PUT /config` et `POST /bases`; sans lui, ces routes
n’acceptent que la validation et refusent l’effet. La surface MCP recommandée
est `bases_formula_patch_*`, pas l’envoi de YAML arbitraire.

## Requêtes (`/query`)

`POST /bases/:id/query` accepte `view`, `filter`, `sort`, `limit`, `page` et
`evaluate`. `source` dit d’où viennent les lignes et les valeurs :

- `evaluate: true` → `source: "engine"`. Le moteur d’Obsidian (même chemin que
  `/engine/evaluate`, avec les mêmes canaris) sélectionne d’abord les lignes de
  la vue avec les filtres globaux, les filtres de vue et la limite de la vue.
  Le Bridge transmet aussi la configuration du tri de vue au handler natif.
  Dans la capture 1.15.1, les tris ascendant et descendant sur `note.priority`
  et le tri descendant sur `file.name` ont tous rendu les notes dans l’ordre
  `a`, `b`, `c`, `d`. `filter` et `sort` de la requête s’appliquent ensuite
  côté Bridge, puis la pagination.
  Le moteur ne calcule les formules que pour les lignes de la page demandée, à
  partir des octets exacts de la Base décrits par `baseSnapshot`. Seuls un
  `filter` ou un `sort` de la requête sur `formula.*` font calculer toutes les
  lignes, par lots de 100 entre lesquels Obsidian reprend la main, jusqu’à
  1 000 lignes ; au-delà, les conditions et tris sur formule sont ignorés (les
  autres conditions filtrent toujours) et `formula_filter_not_evaluated:too_many_rows:<lignes>:1000` le
  signale : réduisez les lignes avec une vue ou un filtre sans formule. `computed`
  et les clés de formule de `props` portent ces valeurs, sous la forme texte que
  rend le moteur (`null` si vide). Mesuré par le Bridge sur 8 000 notes liées :
  une page de 50 lignes 0,45 s, Obsidian répondant en 0,2 s au plus ; un filtre
  et un tri sur formule sur 820 lignes 2,5 s, Obsidian bloqué 1,2 s au plus
  par lot ; toutes les lignes d’un coup bloquaient Obsidian 15,9 s.
- `evaluate: false`, ou moteur indisponible → `source: "fallback"`. Le Bridge
  sélectionne les lignes avec ses filtres supportés et ne calcule aucune
  formule : les clés de formule sont absentes de `props`, `computed` est absent.
  Si `evaluate` était demandé, chaque formule est signalée dans `warnings`
  (`formula_not_evaluated:<nom>:<raison>`). Un filtre ou un tri sur
  `formula.*` est signalé et ignoré : une condition sur formule dans un `and`
  est retirée, un `or` ou un `not` qui en contient une garde toutes les lignes. Quand la vue a une limite plus petite que le nombre
  de lignes, seules les premières lignes dans l’ordre du Bridge sont gardées
  et `view_limit_applied_with_bridge_order:<limite>` le signale : cet ordre
  peut différer du tri d’Obsidian.

L’ancien évaluateur de formules interne au Bridge est retiré : aucune valeur
de formule ne vient plus d’une approximation.

## Upsert robuste

`POST /bases/:id/upsert` accepte :

- `operations` : tableau `{ file, set?, unset?, expected_mtime? }`
- `continueOnError` : poursuit le lot après une erreur individuelle
- `dryRun` : valide les fichiers, les `mtime` et les clés sans écrire

Garde-fous :

- `file.*` et `formula.*` sont refusés car ce sont des champs virtuels/calculés.
- `création`, `creation` et `modification` sont refusés car ils peuvent être auto-gérés par le coffre.
- Les timeouts `processFrontMatter` sont classés en `write_timeout`, ce qui permet au MCP de retry l’opération seule après backoff.

Usage recommandé pour les lots sensibles : commencer par `dryRun: true`, puis écrire en petits chunks côté MCP.
