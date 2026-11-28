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
- L’index des liens se construit sur un thread séparé après la mise à disposition du cache texte. La lecture, les listes, la recherche et le frontmatter restent disponibles pendant la construction. Durant cette période, `obsidian_note_links` renvoie `SERVICE_UNAVAILABLE` avec `reasonCode: headless_link_index_building` et `retryable: true`.
- Les grosses notes sont analysées par sections, si possible entre deux paragraphes. Une section peut atteindre quatre fois la taille cible. Pour une ligne qui dépasse cette limite, seuls les wikilinks sont extraits. Une coupe incertaine, un plafond de références ou un dépassement du tas du worker limite la source. Le worker poursuit l’indexation du coffre.
- Lorsqu’une source limitée concerne la réponse, `indexCoverage.sourceComplete` décrit les liens sortants et non résolus de la note demandée. `backlinksComplete` vaut false si une source limitée contient ou pourrait contenir un lien vers cette note. `limitedSourceCount` compte les sources concernées.

L’index filesystem se règle avec `OBSIDIAN_LINK_LARGE_NOTE_BYTES` (262144 par défaut), `OBSIDIAN_LINK_SECTION_BYTES` (65536), `OBSIDIAN_LINK_MAX_REFERENCES` (8192 par source traitée par sections) et `OBSIDIAN_LINK_BATCH_BYTES` (262144 octets de texte source par lot). Une modification des limites d’extraction entraîne la reconstruction de l’index des liens après la disponibilité du cache texte.
- Lorsqu’un processus réconcilie le cache texte partagé, l’outil de liens renvoie un motif réessayable qui précise l’état du cache. `headless_link_cache_refreshing` indique un rafraîchissement complet ou périodique en cours. `headless_link_cache_events_pending` indique des événements de fichiers en cours de traitement. `headless_link_cache_uncertain` indique que le cache attend un rafraîchissement réussi.
- Quand plusieurs chemins Markdown correspondent, la résolution sur disque privilégie le dossier de la note source, puis le chemin le plus court, puis l’ordre alphabétique. Elle indique `resolution.ambiguous: true` lorsqu’elle départage plusieurs candidats. Ce départage reste à confirmer dans Desktop. Les chemins explicites relatifs ou depuis la racine ciblent l’emplacement indiqué. Le scan résout les noms des pièces jointes et les chemins exclus par l’utilisateur sans mettre leur contenu en cache. Les exclusions techniques comme `node_modules`, `dist`, `build`, `tmp` et `coverage` restent hors de l’inventaire. Les chemins commençant par un point exigent une réinclusion explicite de type gitignore.
- Le comptage regroupe les références par chemin de destination, y compris lorsque leurs fragments diffèrent. La validation des fragments de titre et de bloc est `unknown`. Le headless apparie les balises HTML en ligne à l’intérieur d’un même bloc Markdown. Pour les formules en ligne, il applique la [règle de délimitation de Pandoc](https://pandoc.org/MANUAL.html#extension-tex_math_dollars) et préserve les dollars dans les destinations de liens, les autoliens et les wikilinks. Les règles exactes des métadonnées Desktop pour le HTML en ligne et les délimiteurs dollar restent à vérifier.
- Le backend filesystem lit le cache partagé, qui peut contenir du Markdown actualisé via Local REST. Après une mise à jour REST, seules les lignes dont l’empreinte a changé sont réindexées, sans rouvrir les notes du coffre. Un changement de racine ou de périmètre d’exclusions impose un nouvel inventaire sur disque.
- Garder le cache MCP hors du vault synchronisé.
- Utiliser les exclusions pour le bruit opérationnel, sans prétendre qu’elles bloquent les téléchargements Obsidian Sync.
- Ne pas promettre la parité Desktop. Tags frontmatter ou inline, batch frontmatter, écritures Bases minimales, validation de format et helpers Canvas minimaux existent comme fonctions filesystem/locales bornées, pas comme comportement Obsidian Desktop.

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

## Operon sans Desktop

Choisissez `MCP_TOOL_PROFILE=tasks`, `operational` ou `full`. Dans les trois modes headless, `operon_list_tasks`, `operon_query_tasks`, `operon_get_task`, `operon_find_tasks`, `operon_get_relationships`, `operon_get_configuration`, `operon_status` et `operon_validate` lisent la copie synchronisée. `operon_query_saved_filter` prend un ID exact obtenu via `operon_get_configuration`.

Le lecteur analyse le Markdown du cache. Il reconnaît les cases inline avec un `operonId` et des champs `{{clé:: valeur}}`, ainsi que les tâches fichier identifiées par leur frontmatter YAML. Un dossier comme `_Operon` sert de destination de création. Une tâche fichier peut se trouver ailleurs. Les deux formats portent les identifiants, dates, règles et occurrences de récurrence, relations stockées et champs gérés. Le lecteur ignore les blocs de code clôturés et les commentaires. L’indentation seule ne définit pas de parent.

Synchronisez `.obsidian/plugins/operon/data.json` avec les notes. Ce fichier fournit les pipelines, identifiants et indicateurs de statut terminal, priorités, correspondances de champs, dossiers exclus, réglages de création et filtres enregistrés. Le lecteur accepte les réglages à plat et les paquets versionnés (2 et 3). En l’absence du fichier, il peut lire les champs canoniques, et les outils de configuration et de filtres renvoient `operon_filesystem_configuration_missing`. Le manifeste du plugin fournit sa version s’il est présent. Les épingles peuvent venir du paquet ou de l’ancien fichier `state/pinned-tasks.json`. Les index d’exécution, minuteurs actifs, automatismes de récurrence, rappels, numéros de série et caches de calendrier restent gérés par le plugin.

La [documentation de stockage d’Operon](https://www.operon.cc/docs/docs-046-plugin-data-and-state-files/) décrit les fichiers JSON de récurrence et de minuteurs, les enregistrements de livraison des rappels et l’index d’exécution reconstructible.

Chaque lecture indique `source: "filesystem"`, `freshness`, `cacheStatus`, `lastRefreshAt`, `lastRefreshCompletedAt` et `partial`. Avec `partial: true`, l’index est incomplet pendant le démarrage, une actualisation ou une erreur du cache. Quand l’outil propose `forceRefresh`, ce paramètre actualise l’index partagé depuis le disque. L’actualisation ne prouve pas que Desktop ou Sync est actif.

Les anciens réglages sans liste de pipelines permettent la lecture des tâches et signalent que la résolution des statuts de workflow est indisponible. Si le serveur utilise un autre fuseau que Desktop, renseignez le fuseau IANA du coffre dans `OPERON_TIMEZONE`. Le lecteur consulte cette variable puis le réglage du plugin s’il existe. Une valeur non vide et invalide de `OPERON_TIMEZONE` empêche le démarrage. La variable `TZ` influe sur le fuseau serveur et déclenche toujours l’avertissement en l’absence de fuseau Operon configuré. Il applique le même fuseau aux horodatages des fichiers et aux dates relatives. Les réponses indiquent `timeZone` et `timeZoneSource`. Elles contiennent aussi `timeZoneWarning` si le lecteur utilise le fuseau par défaut du serveur ou se replie sur UTC quand ce fuseau est indisponible.

Le finder classe les résultats localement en s’appuyant sur les dates stockées. Les relations lues comprennent les liens stockés, leurs inverses et la hiérarchie qui en découle. La validation, les scores du finder, les révisions et les métadonnées de configuration peuvent différer de Desktop. Le diagnostic des capacités indique que la lecture Operon est prête lorsque le cache est prêt et que `data.json` est valide. Les mutations, les relations inférées par le moteur, la découverte des modèles de dossier et les minuteurs exigent Desktop. L’outil de compatibilité pour les minuteurs renvoie `operon_filesystem_live_required`. Les filtres enregistrés prennent en charge les groupes imbriqués, les arborescences de dossiers ainsi que les conditions usuelles sur les cases, textes, dates, listes, tags et épingles persistées. Comme dans Operon 4.6, `thisWeek` couvre du lundi au dimanche. En tri croissant, les dates vides passent en premier. Les statuts vides passent en dernier dans les deux sens. Le tri par dossier laisse la main au critère suivant ou conserve l’ordre d’entrée. Les champs, opérateurs ou tris non pris en charge renvoient `operon_filesystem_filter_unsupported`.

La liste utilise le niveau `warm` du Bridge Developer API V1 et les identifiants canoniques de priorité. Elle omet la progression native des cases. Pour une tâche fichier, le lecteur peut utiliser la date de création du fichier. Il signale alors qu’elle peut correspondre à l’arrivée de la copie synchronisée. Comme Operon 4.6, le lecteur retient la plus récente entre la date de modification stockée et le `mtime` converti dans le fuseau retenu. Une tâche inline utilise sa propre date de modification stockée. L’index ignore les chemins masqués et applique les exclusions Operon aux fichiers disponibles dans le cache partagé. Les exclusions du cache peuvent réduire ce périmètre, ce que signale la réponse. Les filtres groupés et dynamiques renvoient une erreur explicite, et les curseurs sont liés à la génération qui les a produits.

En headless, `operon_get_configuration` explique les écarts connus dans `configurationDifferences`. Le lecteur ajoute les sept champs fixes du catalogue Developer API et dérive les modèles de tâche fichier minimaux à partir des pipelines. Il signale les modèles de dossier de Desktop comme `unknown`. Il conserve le sens de synchronisation des champs ainsi que la langue, les cibles des tâches parentes et les réglages d’index et de documentation stockés. Il lit les filtres sur disque, y compris lorsque le Bridge 0.9.9 lit `filters` au premier niveau du catalogue et qu’Operon 4.6 publie les définitions dans `policies.filters`.

### Banc de parité Operon

Lancez `npm run build` puis `npm run test:operon-headless` pour exercer MCP sur un coffre synthétique avec un Bridge Local REST simulé. Pour une comparaison manuelle, ouvrez une copie jetable dans Desktop, activez Operon et le Bridge en lecture seule, puis attendez la fin de l’indexation. Ajoutez à la racine `operon-parity-copy.md` avec une seule ligne `operon-parity-copy: <nouvel UUID>`. Renseignez `OPERON_PARITY_LOCAL_REST_URL` avec l’adresse locale et `OPERON_PARITY_LOCAL_REST_KEY` avec sa clé, puis lancez la commande suivante.

```bash
node scripts/operon-headless-parity.mjs /chemin/vers/copie-jetable
```

Réservez `OPERON_PARITY_VERIFY_SSL=false` au certificat autosigné d’une adresse locale. Le script vérifie le marqueur via REST, utilise des caches temporaires privés, parcourt les pages d’`operon_list_tasks` des deux côtés et compare la configuration et la validation. Il vérifie la première page du finder, les relations à une profondeur de un pour dix tâches au plus et la première page de chaque filtre enregistré. Il compte à part les écarts de configuration connus et les comparaisons indisponibles. Il ignore les versions, les révisions, le type de source et le champ de transport `sourceMtime`. Un écart inattendu renvoie un code de sortie non nul. Gardez la copie stable pendant la comparaison.

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

1. Utiliser les opérations gouvernées ci-dessous. Les outils de compatibilité exigent `expectedHash` ou `expectedMtime`.
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

### Déplacement et corbeille gouvernés

En `headless-filesystem`, avec le cache filesystem et `MCP_WRITE_MODE=full`,
appeler `obsidian_note_move_plan` avec les chemins exacts de départ et d’arrivée
et une clé d’idempotence. Il inspecte les liens Markdown indexés et les embeds
de pièces jointes. Il préserve la syntaxe et les libellés déjà présents, y
compris dans les scalaires YAML. Il ajuste les liens sortants de la note
déplacée si leur cible change, et refuse une opération qui détournerait un
lien résolu depuis une autre note. L’aperçu est plafonné. Au-delà de 100 notes
à réécrire ou de 100 sources de backlinks pour une suppression, le plan renvoie
`headless_backlink_limit`. La vérification de sécurité examine séparément
jusqu’à 1 000 notes candidates, y compris les liens vers le nom de destination.
Au-delà, elle renvoie `headless_backlink_inspection_limit`. Les plans utilisent
le même découpage que l’index des liens. Si une source incomplète peut affecter
les chemins du plan, l’outil renvoie `headless_link_coverage_incomplete`.
Un déplacement avec `alwaysUpdateLinks: false` reste possible. Le plan sonde la
création exclusive de liens physiques avant de sceller l’opération. Appliquer
avec la clé d’origine. Un plan périmé renvoie `headless_plan_stale`.

`app.json` pilote l’actualisation via `alwaysUpdateLinks` et la forme des chemins
via `newLinkFormat`. `useMarkdownLinks` concerne les liens générés. Le
déplacement conserve les wikilinks et liens Markdown dans leur syntaxe
d’origine. Voir les [réglages d’Obsidian](https://obsidian.md/help/settings#files-and-links).

Appeler `obsidian_note_delete_plan` pour examiner les liens entrants. S’il en
existe, soumettre un nouveau plan avec `acknowledgeBacklinks: true` après les
avoir examinés. L’application déplace le fichier dans un emplacement libre
sous `.trash` par défaut. Le MCP accepte aussi `trashFolder` ou `trashFolderPath`
comme chemin local de remplacement. Il refuse les valeurs explicites
`trashOption: "system"` et `trashOption: "none"`. Sans ce réglage, le MCP choisit
la corbeille du coffre pour fournir une destination restaurable sans accès à
la corbeille système. [Obsidian Desktop utilise par défaut la corbeille système](https://obsidian.md/help/manage-notes).

Les deux opérations actualisent les chemins touchés dans le cache et l’index.
Le reçu de vérification s’appuie sur une relecture. Les appels de statut
suivants rendent la preuve de fin d’opération avec `cache: "recorded"` et
`postflightSource: "recorded"`. Après une interruption,
appeler `*_status` puis `*_recover` avec la même référence et clé si
`recoveryAllowed` est vrai. Si une édition externe empêche la reprise,
`abandonAllowed` permet d’appeler `*_recover` avec `action: "abandon"`.
Le verrou est libéré pour une réparation manuelle. Le reçu conserve
`nextAction: "manual_repair"` et fournit dans `repairProofs` les chemins,
empreintes SHA-256 et éditions inverses. Les plages UTF-16 visent le fichier
réécrit, de la fin vers le début. Vérifier `afterSha256` avant de les appliquer.
Le journal privé conserve le texte d’avant dans `headless_file_operations.payload.rewrites`.
Sans effet publié, l’opération se règle en conflit et libère son verrou. La
reprise ou l’abandon supprime les fichiers de préparation encore accessibles.

La sonde des liens physiques utilise ses propres fichiers temporaires sur le
même système de fichiers et peut renvoyer `hard_links_unsupported`. Un seul
balayage tourne en arrière-plan au démarrage. La reprise vérifie la racine du
coffre et les dossiers sur les chemins du plan. Une ancienne sonde avec un seul
lien est conservée. Le statut liste ces chemins dans
`probeCleanup.orphanedLegacyProbes` pour examen manuel. Chaque remplacement est atomique. Les autres
processus ne partagent pas les verrous, et plusieurs remplacements peuvent
être visibles en cours d’opération. Ce parcours s’applique à un coffre copié
ou dédié. L’[ADR](adr/ADR-External-Reference-Integrity.md#vault-only-moves)
précise la distinction avec le déplacement de documents externes.

`operational` privilégie ces outils. Le profil `full` conserve également les
anciens outils directs dont le contrôle hash/mtime porte sur un seul fichier.

## Décision go/no-go serveur

Go si `test:runtime`, `smoke:headless-server-profile`, une validation longue courte puis longue, et `npm pack --dry-run` sont verts. No-go si le vault serveur synchronise encore dans le même emplacement que le Desktop vivant, si le cache est dans le vault, ou si les écritures sont activées avant snapshot/rollback.
