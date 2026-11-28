# Profil serveur headless

Version anglaise : [headless-server-profile.md](headless-server-profile.md)

Documentation liée : [Pilote Linux headless multi-client](headless-multiclient-pilot.fr.md)

Docs liées : [README](../README.fr.md), [Guide d’exploitation](../OPERATIONS.fr.md), [Matrice des capacités runtime](runtime-capability-matrix.fr.md), [Guide de routage MCP](mcp-routing-guide.fr.md)

Ce profil sert à valider un serveur dédié ou une copie Sync. Il garde une posture stable : lecture seule d’abord, écritures guarded seulement après preuve du profil en lecture seule.

## Contrat

- Utiliser un vault dédié ou copié, pas le vault Desktop vivant.
- Garder Obsidian Headless Sync en `pull-only` pour la première validation serveur.
- Garder Optimike MCP en `headless-readonly` tant que list/read/search/tasks/Bases/status ne sont pas verts.
- Avec le cache partagé actif, `obsidian_get_frontmatter` lit une clé YAML et `obsidian_note_links` renvoie les liens sortants, les liens non résolus et les backlinks. L’index couvre les wikilinks, les liens et intégrations Markdown locaux et les wikilinks YAML entre guillemets. Il ignore les liens dans le code, les commentaires, les formules en ligne ou en bloc et les éléments HTML. Le comportement des métadonnées Desktop dans le HTML en ligne reste à vérifier.
- Dans un wikilink headless, `[[` non échappé ouvre un nouveau lien si l’alias courant est inachevé. Les crochets simples sont admis dans les alias. Dans le corps d’une note, les commentaires sont retirés des cibles et des alias. Les positions renvoyées restent celles de la note d’origine.
- L’index des liens se construit en arrière-plan après la mise à disposition du cache texte. La lecture, les listes, la recherche et le frontmatter restent disponibles pendant la construction. Durant cette période, `obsidian_note_links` renvoie `SERVICE_UNAVAILABLE` avec `reasonCode: headless_link_index_building` et `retryable: true`. Une réponse réussie utilise l’index complet.
- Lorsqu’un processus réconcilie le cache texte partagé, l’outil de liens renvoie un motif réessayable qui précise l’état du cache. `headless_link_cache_refreshing` indique un rafraîchissement complet ou périodique en cours. `headless_link_cache_events_pending` indique des événements de fichiers en cours de traitement. `headless_link_cache_uncertain` indique que le cache attend un rafraîchissement réussi.
- Quand plusieurs chemins Markdown correspondent, la résolution sur disque privilégie le dossier de la note source, puis le chemin le plus court, puis l’ordre alphabétique. Elle indique `resolution.ambiguous: true` lorsqu’elle départage plusieurs candidats. Ce départage reste à confirmer dans Desktop. Les chemins explicites relatifs ou depuis la racine ciblent l’emplacement indiqué. Le scan résout les noms des pièces jointes et les chemins exclus par l’utilisateur sans mettre leur contenu en cache. Les exclusions techniques comme `node_modules`, `dist`, `build`, `tmp` et `coverage` restent hors de l’inventaire. Les chemins commençant par un point exigent une réinclusion explicite de type gitignore.
- Le comptage regroupe les références par chemin de destination, y compris lorsque leurs fragments diffèrent. La validation des fragments de titre et de bloc est `unknown`. Le headless apparie les balises HTML en ligne à l’intérieur d’un même bloc Markdown. Pour les formules en ligne, il applique la [règle de délimitation de Pandoc](https://pandoc.org/MANUAL.html#extension-tex_math_dollars) et préserve les dollars dans les destinations de liens, les autoliens et les wikilinks. Les règles exactes des métadonnées Desktop pour le HTML en ligne et les délimiteurs dollar restent à vérifier.
- Le backend filesystem lit le cache partagé, qui peut contenir du Markdown actualisé via Local REST. Après une mise à jour REST, seules les lignes dont l’empreinte a changé sont réindexées, sans rouvrir les notes du coffre. Un changement de racine ou de périmètre d’exclusions impose un nouvel inventaire sur disque.
- Garder le cache MCP hors du vault synchronisé.
- Utiliser les exclusions pour le bruit opérationnel, sans prétendre qu’elles bloquent les téléchargements Obsidian Sync.
- Ne pas promettre la parité Desktop. Move/delete, tags frontmatter ou inline, batch frontmatter, écritures Bases minimales, validation de format et helpers Canvas minimaux existent comme fonctions filesystem/locales bornées, pas comme comportement Obsidian Desktop.

## Environnement

Un exemple prêt à adapter est fourni dans `.env.server.example`.

```bash
OBSIDIAN_RUNTIME_MODE=headless-readonly
OBSIDIAN_VAULT=/chemin/vers/vault-dedie-ou-copie
OBSIDIAN_CACHE_SOURCE=filesystem
OBSIDIAN_SHARED_CACHE_DB_PATH=/chemin/hors/vault/shared-cache.sqlite
OBSIDIAN_ENABLE_CACHE=true
MCP_WRITE_MODE=readonly
OBSIDIAN_VAULT_EXCLUDE_PATTERNS="tmp/**,**/tmp/**,**/screenshots/**,**/*screenshots*/**"
SEMANTIC_SEARCH_PREWARM=false
```

## Provenance des lectures de notes

Dans les trois modes headless, `obsidian_runtime_status` indique le mode
d’exécution et renvoie `headlessRead.source: "filesystem"`. Le serveur
lit depuis son cache local sans connexion à Obsidian Desktop.
`headlessRead.refreshing` signale un scan en attente ou en cours.
`headlessRead.newestFileMtimeMs` contient la date de modification la plus
récente parmi les fichiers Markdown indexés par ce processus, ou `null` si
l’index est vide. `sharedCache.lastRefreshAt` indique la fin du dernier
rafraîchissement réussi connu de cet index.
`headlessRead.lastSuccessfulRefreshStartedAt` indique son début. Ce champ
vaut `null` si le début est inconnu, notamment avec un ancien état SQLite.
`headlessRead.refreshOrigin`
indique s’il provient de ce processus (`"process-refresh"`) ou de l’état
SQLite chargé au démarrage (`"startup-snapshot"`). Chaque processus conserve
son propre repère pendant les scans des autres serveurs. Les dates sont
exprimées en millisecondes depuis l’époque Unix.

`obsidian_read_note`, `obsidian_list_notes` et `obsidian_global_search`
renvoient un objet `provenance` pour les lectures réussies et les erreurs de
disponibilité lorsque le cache headless est activé, y compris en mode
compact. Il contient `source: "filesystem"`, `refreshOrigin` quand
l’origine est connue, `lastSuccessfulRefreshStartedAt` et `lastRefreshAt`.
`partial: true` signifie que les résultats peuvent être incomplets.
Ce champ apparaît aussi quand une requête attend la fin du premier scan.
`refreshing: true` signale une activité de rafraîchissement pendant la
requête, même si le scan se termine avant la réponse.

La fenêtre `maintenant − lastSuccessfulRefreshStartedAt` couvre les
modifications sur disque que le scan a pu manquer en raison de son
déroulement, y compris juste après un redémarrage qui réutilise l’état
SQLite. Un fichier peut changer entre sa lecture et la fin du scan. Les
fichiers peuvent être observés à des moments différents. Cette fenêtre
décrit uniquement le déroulement du scan.

## Preuve de synchronisation amont

Le statut runtime, la provenance des lectures et les deux endpoints HTTP
exposent `upstreamSync`, `lastSuccessfulPullAt`, `lagSecondsUpperBound` et
`evidenceSource`. Le champ HTTP `freshnessScope: "local-cache"` et les codes de
readiness restent liés à la lecture locale. Comparez la dernière synchronisation
au début du scan pour savoir si le cache MCP a observé ses changements.
`lagSecondsUpperBound` arrondit à la seconde supérieure le temps écoulé depuis
le **début** de la dernière synchronisation réussie. Cette borne porte sur
l’âge de l’observation du coffre distant. Les modifications non envoyées par
un appareil, les fichiers exclus et les appareils déconnectés échappent à
cette mesure.

| Signal | Donnée exploitable |
| --- | --- |
| Exécution ponctuelle de `ob sync` | Une sortie normale à zéro marque la fin de la passe, même sans téléchargement. Un code non nul, une interruption ou un délai dépassé marque un échec. |
| `ob sync --continuous` | La présence du processus signale son exécution. Sa sortie ne prouve pas un pull réussi. |
| `ob sync-status --json` | Configuration exploitable par programme, sans date documentée de dernier pull réussi ni repère côté serveur. |
| Journaux CLI et Sync | Diagnostic humain, sans schéma stable de corrélation, de fin ou d’horodatage. |
| Fichiers d’état internes et dates des notes | Aucun schéma stable ni date de pull documentés. Les fichiers répliqués peuvent conserver les dates d’origine. |

Voir [Obsidian Headless Sync](https://obsidian.md/help/sync/headless),
[la référence CLI](https://github.com/obsidianmd/obsidian-headless#commands) et
[les conflits Sync](https://obsidian.md/help/sync/troubleshoot).

Définissez `OBSIDIAN_SYNC_HEARTBEAT_FILE` avec un chemin absolu hors du coffre,
dans un dossier contrôlé par l’opérateur. Le lecteur attend le
[reçu JSON versionné](headless-server-profile.md#upstream-sync-evidence).
Écrivez d’abord un fichier temporaire voisin, puis remplacez le reçu en une
opération atomique. Le script livré crée un reçu privé. Utilisez le même
compte dédié pour MCP et le script, ou des permissions qui donnent au compte
MCP la lecture à chaque remplacement.

Le reçu v2 contient `vaultBinding`, le SHA-256 du chemin réel absolu du coffre
en UTF-8, sans retour à la ligne. Un reçu d’un autre coffre ou un ancien reçu
sans empreinte donne `unknown`. Utilisez des dates ISO UTC avec millisecondes.
L’état du reçu est `running`
au démarrage, `ok` après réussite, ou `error` après échec. Conservez le dernier
`lastSuccessfulPull` au démarrage et en cas d’échec, ou laissez `null` jusqu’à
la première réussite. Le backend renvoie `unknown` si la preuve est absente,
illisible, datée dans le futur, incohérente ou si aucun pull réussi n’a été
observé. Le délai `OBSIDIAN_SYNC_STALL_SECONDS` (600 par défaut) donne
`stalled` si le reçu n’est plus actualisé. Un reçu récent signalant un échec
donne `error`. Sinon, un pull réussi dans la fenêtre
`OBSIDIAN_SYNC_CURRENT_SECONDS` (180 par défaut) donne `current`, puis
`lagging` au-delà. Une exécution en cours peut conserver l’état établi par
la dernière passe réussie.

`OBSIDIAN_SYNC_WRITE_MAX_AGE_SECONDS` active le garde-fou d’écriture
optionnel. Une écriture headless renvoie `upstream_sync_write_blocked` face
à un état `unknown`, `stalled`, `error` ou à un pull trop ancien. L’erreur
inclut `upstreamSync` et le code `syncWriteRefusal`. Les
lectures, les simulations et les préconditions existantes restent
applicables. Le statut runtime et `/statusz` authentifié listent les chemins
relatifs des `syncConflictFiles` indexés, selon le motif Markdown daté
d’Obsidian, avec une limite de 100 et le total `syncConflictCount`. La fusion
automatique par défaut d’Obsidian ne crée aucun fichier de conflit. Une liste
vide indique seulement qu’aucun fichier indexé ne correspond au motif.
`/readyz` public ne contient aucun nom de note.

Le script livré `scripts/obsidian-sync-heartbeat.mjs` exécute une passe du CLI
avec un délai maximal et écrit le reçu. Planifiez-le sous le compte ayant
déjà exécuté `ob sync-setup`. Utilisez un seul service Sync par coffre, en
`pull-only` pour une réplique en lecture seule. Voir les
[exemples de déploiement](../OPERATIONS.fr.md#services-sync-et-index-sémantique-headless).

## Validation

```bash
npm run build
npm run test:runtime
npm run test:http-headless-multiclient
HEADLESS_SERVER_VAULT=/chemin/vers/vault-dedie-ou-copie \
HEADLESS_SERVER_CACHE_DIR=.tmp/headless-server-profile-cache \
npm run smoke:headless-server-profile
```

Pour une validation longue :

```bash
HEADLESS_SERVER_VAULT=/chemin/vers/vault-dedie-ou-copie \
HEADLESS_SERVER_CACHE_DIR=/chemin/hors/vault/cache \
HEADLESS_LONG_RUN_MINUTES=120 \
HEADLESS_LONG_RUN_INTERVAL_SECONDS=60 \
npm run test:headless-long-run
```

Le rapport est écrit dans `.tmp/headless-long-run` par défaut, ou dans `HEADLESS_LONG_RUN_OUTPUT_DIR`.

Le smoke serveur vérifie que :

- le serveur démarre en `headless-readonly` ;
- les tools live/write ne sont pas enregistrées ;
- `obsidian_runtime_maintenance refresh_all` fonctionne ;
- le status runtime confirme la politique `readonly` ;
- list/read/tasks passent sur le vault ;
- la liste et le schéma des Bases sont disponibles localement. Les lignes d’une
  Base nécessitent Obsidian et le Bases Bridge. En headless, `bases_query` exige
  `property_only: true` pour [parcourir les propriétés des notes Markdown en cache](../OPERATIONS.fr.md#dépendances-requises).

## Écritures guarded

Seulement après validation du profil serveur en lecture seule :

1. Passer une copie ou un vault dédié en `OBSIDIAN_RUNTIME_MODE=headless-guarded`.
2. Garder `MCP_WRITE_MODE=guarded`.
3. Créer uniquement un nouveau brouillon sandbox.
4. Exiger `expectedHash` ou `expectedMtime` pour les modifications suivantes.
5. Confirmer que hash périmé et path traversal sont bloqués.

Avant un test d'écriture, créer un snapshot du vault dédié :

```bash
HEADLESS_SERVER_VAULT=/chemin/vers/vault-dedie-ou-copie npm run snapshot:vault
```

Le snapshot ne remplace pas une vraie sauvegarde, mais donne un rollback local rapide pour les tests serveur.

## Fonctions filesystem

Seulement après le palier `headless-guarded`, passer une copie ou un vault dédié en `OBSIDIAN_RUNTIME_MODE=headless-filesystem`.

1. Pour move/delete, exiger `expectedHash` ou `expectedMtime`.
2. Pour tags, limiter le contrat au texte Markdown : `tags` dans le frontmatter YAML, `#tags` inline et index local depuis le cache.
3. Pour batch frontmatter, garder le dry-run par défaut et n’autoriser que `set`.
4. Pour Bases, limiter le contrat aux fichiers `.base` YAML et aux propriétés frontmatter des notes.
   `bases_query.filter` accepte les tables de propriétés comme `{"status":"open"}`
   et les groupes `and`, `or` et `not` contenant des tables ou des expressions
   simples. Un nœud non pris en charge ou une chaîne à la racine renvoie
   `VALIDATION_ERROR`. [Voir la syntaxe du filtre](../plugins/obsidian-bases-bridge/README.md#requêtes-query).
5. Pour Canvas, limiter le contrat à la structure JSON Canvas : create, ajout de nœud texte, connexion de nœuds, validation.
6. Valider avec `npm run smoke:headless-filesystem`.

Voir [Modes runtime](../OPERATIONS.fr.md#modes-runtime) pour l’ordre des écritures
sur un même fichier, la détection des conflits et le risque de concurrence
avec d’autres processus.

Ne jamais utiliser cette phase pour modifier des notes de production existantes tant que le profil serveur n’a pas son propre rollback et monitoring.

## Décision go/no-go serveur

Go si `test:runtime`, `smoke:headless-server-profile`, une validation longue courte puis longue, et `npm pack --dry-run` sont verts. No-go si le vault serveur synchronise encore dans le même emplacement que le Desktop vivant, si le cache est dans le vault, ou si les écritures sont activées avant snapshot/rollback.
