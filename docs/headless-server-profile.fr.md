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
- Chaque valeur texte YAML ou élément de liste fournit au plus un wikilink. Un wikilink vide dans une propriété pointe vers sa propre note et les embeds dans les propriétés sont ignorés. Un commentaire de bloc non fermé, ouvert en début de ligne, masque la fin de la note. Les compteurs de liens non résolus regroupent les cibles Markdown avec ou sans extension `.md`.
- Deux règles du mode headless restent des inférences à vérifier sur un coffre de test Desktop. Une valeur texte YAML prend le lien du premier `[[` au dernier `]]`, même si elle contient du texte en dehors du lien. Les marqueurs `%%` d’un commentaire en ligne s’apparient uniquement sur la même ligne.
- Dans un wikilink headless, `[[` non échappé ouvre un nouveau lien si l’alias courant est inachevé. Les crochets simples sont admis dans les alias. Dans le corps d’une note, les commentaires sont retirés des cibles et des alias. Les positions renvoyées restent celles de la note d’origine.
- L’index des liens se construit sur un thread séparé après la mise à disposition du cache texte. La lecture, les listes, la recherche et le frontmatter restent disponibles pendant la construction. Durant cette période, `obsidian_note_links` renvoie `SERVICE_UNAVAILABLE` avec `reasonCode: headless_link_index_building` et `retryable: true`.
- Les grosses notes sont analysées par sections, si possible entre deux paragraphes. Si le délai d’analyse expire, le worker réessaie par sections plus petites. Un repli qui aboutit conserve ses références utilisables, même si sa couverture est limitée. Seul un repli qui dépasse son délai peut être retenté une minute plus tard. Une seconde expiration pour la même empreinte, ou l’atteinte du plafond configuré avant cela, marque la source `region` jusqu’à ce que son contenu change. Les erreurs de stockage retardent l’indexation et préservent les références existantes.
- Lorsqu’une source limitée concerne la réponse, `indexCoverage.sourceComplete` décrit ses liens sortants et non résolus. `backlinksComplete` vaut false si une source limitée contient ou pourrait contenir un lien vers la note demandée. Une source limitée peut produire des liens manquants ou en trop. Ses entrées portent `confidence: "uncertain"`. `limitedSourceCount` compte les sources concernées et `limitedSources` affiche jusqu’à 20 chemins relatifs au coffre avec leur motif (`cap`, `region`, `timeout` ou `oom`). Le motif `region` couvre les sections incertaines et les autres échecs d’extraction.

L’index filesystem se règle avec `OBSIDIAN_LINK_LARGE_NOTE_BYTES` (262144 par défaut), `OBSIDIAN_LINK_SECTION_BYTES` (65536), `OBSIDIAN_LINK_MAX_REFERENCES` (8192 par source traitée par sections) et `OBSIDIAN_LINK_BATCH_BYTES` (262144 octets de texte source par lot). Une modification des limites d’extraction entraîne la reconstruction de l’index des liens après la disponibilité du cache texte.
Le budget d’analyse initial se règle avec `OBSIDIAN_LINK_PARSE_TIMEOUT_MS` (10000 par défaut). Il augmente avec la taille de la source. Le repli conserve jusqu’à 32768 références pour les notes sous le seuil des grosses notes.
`OBSIDIAN_LINK_MAX_RETRY_ATTEMPTS` plafonne le nombre de tentatives de repli arrivées à expiration pour une même empreinte, premier repli compris (2 par défaut, de 1 à 10). La valeur 1 désactive le réessai différé.
Avec `requireComplete: true`, `obsidian_note_links` refuse une couverture filesystem incomplète et renvoie `headless_link_coverage_incomplete` avec les diagnostics des sources.
Utilisez les mêmes valeurs `OBSIDIAN_LINK_*` pour les processus qui partagent une base de cache, car des réglages d’extraction différents les font réindexer les notes les uns des autres.
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
