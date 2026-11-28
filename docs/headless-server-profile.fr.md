# Profil serveur headless

Version anglaise : [headless-server-profile.md](headless-server-profile.md)

Documentation liée : [Pilote Linux headless multi-client](headless-multiclient-pilot.fr.md)

Docs liées : [README](../README.fr.md), [Guide d’exploitation](../OPERATIONS.fr.md), [Matrice des capacités runtime](runtime-capability-matrix.fr.md), [Guide de routage MCP](mcp-routing-guide.fr.md)

Ce profil sert à valider un serveur dédié ou une copie Sync. Il garde une posture stable : lecture seule d’abord, écritures guarded seulement après preuve du profil en lecture seule.

## Contrat

- Utiliser un vault dédié ou copié, pas le vault Desktop vivant.
- Garder Obsidian Headless Sync en `pull-only` pour la première validation serveur.
- Garder Optimike MCP en `headless-readonly` tant que list/read/search/tasks/Bases/status ne sont pas verts.
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
- le fallback local Bases est disponible.

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
5. Pour Canvas, limiter le contrat à la structure JSON Canvas : create, ajout de nœud texte, connexion de nœuds, validation.
6. Valider avec `npm run smoke:headless-filesystem`.

Ne jamais utiliser cette phase pour modifier des notes de production existantes tant que le profil serveur n’a pas son propre rollback et monitoring.

## Décision go/no-go serveur

Go si `test:runtime`, `smoke:headless-server-profile`, une validation longue courte puis longue, et `npm pack --dry-run` sont verts. No-go si le vault serveur synchronise encore dans le même emplacement que le Desktop vivant, si le cache est dans le vault, ou si les écritures sont activées avant snapshot/rollback.
