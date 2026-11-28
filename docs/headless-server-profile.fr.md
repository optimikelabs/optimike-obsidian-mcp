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
- Les notes de plus de 256 Kio sont analysées par sections de taille bornée. Une syntaxe qui traverse plusieurs sections peut être interprétée différemment ou omise. Les sections et références qui dépassent le budget d’extraction sont ignorées. Lorsque l’index contient de telles notes, les réponses incluent `indexCoverage` avec le nombre de sources limitées et `backlinksComplete: false`. Pour une source limitée, `sourceComplete: false` s’applique aux résultats sortants et non résolus.
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

1. Utiliser les opérations gouvernées ci-dessous. Les outils de compatibilité exigent `expectedHash` ou `expectedMtime`.
2. Pour tags, limiter le contrat au texte Markdown : `tags` dans le frontmatter YAML, `#tags` inline et index local depuis le cache.
3. Pour batch frontmatter, garder le dry-run par défaut et n’autoriser que `set`.
4. Pour Bases, limiter le contrat aux fichiers `.base` YAML et aux propriétés frontmatter des notes.
5. Pour Canvas, limiter le contrat à la structure JSON Canvas : create, ajout de nœud texte, connexion de nœuds, validation.
6. Valider avec `npm run smoke:headless-filesystem`.

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
Au-delà, elle renvoie `headless_backlink_inspection_limit`. Si une note
volumineuse a fait l’objet d’une extraction partielle, les plans qui exigent
des liens entrants complets renvoient `headless_link_coverage_incomplete`.
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
suivants rendent la preuve enregistrée à la fin de l’opération. Après une interruption,
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
même système de fichiers et peut renvoyer `hard_links_unsupported`. Le démarrage
et la reprise nettoient les sondes restantes. Chaque remplacement est atomique. Les autres
processus ne partagent pas les verrous, et plusieurs remplacements peuvent
être visibles en cours d’opération. Ce parcours s’applique à un coffre copié
ou dédié. L’[ADR](adr/ADR-External-Reference-Integrity.md#vault-only-moves)
précise la distinction avec le déplacement de documents externes.

`operational` privilégie ces outils. Le profil `full` conserve également les
anciens outils directs dont le contrôle hash/mtime porte sur un seul fichier.

## Décision go/no-go serveur

Go si `test:runtime`, `smoke:headless-server-profile`, une validation longue courte puis longue, et `npm pack --dry-run` sont verts. No-go si le vault serveur synchronise encore dans le même emplacement que le Desktop vivant, si le cache est dans le vault, ou si les écritures sont activées avant snapshot/rollback.
