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
- Le déplacement, la suppression, les écritures Bases, la validation de format et les outils Canvas minimaux suivent des contrats filesystem bornés.

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
4. Sceller les modifications suivantes avec les outils de patch gouvernés.
5. Confirmer que hash périmé et path traversal sont bloqués.

Avant un test d'écriture, créer un snapshot du vault dédié :

```bash
HEADLESS_SERVER_VAULT=/chemin/vers/vault-dedie-ou-copie npm run snapshot:vault
```

Le snapshot ne remplace pas une vraie sauvegarde, mais donne un rollback local rapide pour les tests serveur.

## Fonctions filesystem

Seulement après le palier `headless-guarded`, passer une copie ou un vault dédié en `OBSIDIAN_RUNTIME_MODE=headless-filesystem`.

1. Pour move/delete, exiger `expectedHash` ou `expectedMtime`.
2. Pour Bases, limiter le contrat aux fichiers `.base` YAML et aux propriétés frontmatter des notes.
3. Pour Canvas, limiter le contrat à la structure JSON Canvas : create, ajout de nœud texte, connexion de nœuds, validation.
4. Valider avec `npm run smoke:headless-filesystem`.

Voir [Modes runtime](../OPERATIONS.fr.md#modes-runtime) pour l’ordre des écritures
sur un même fichier, la détection des conflits et le risque de concurrence
avec d’autres processus.

Ne jamais utiliser cette phase pour modifier des notes de production existantes tant que le profil serveur n’a pas son propre rollback et monitoring.

## Écritures Markdown gouvernées

`headless-guarded` expose `obsidian_text_patch_*`, `obsidian_frontmatter_patch_*`,
`obsidian_note_create_*` et `obsidian_list_pending_operations` dans les profils
qui permettent d’écrire. `headless-filesystem` ajoute `obsidian_note_replace_*`
et `obsidian_operation_revert_*`. Les familles de notes reprennent les mêmes
appels plan, apply, status et recover qu’en live. La création utilise plan,
apply et status.
Les ajouts directs, la recherche avec remplacement et l’édition directe du
frontmatter et des tags sont réservés au mode live. En headless, utilisez les
patches gouvernés. L’édition directe du frontmatter par lot est retirée.

Le plan lie le coffre et le SHA-256 des octets lus sur disque, ou l’absence du
chemin pour une création. Apply réutilise la référence scellée et la clé
d’idempotence. L’autorité filesystem sérialise les processus qui partagent le
verrou local. Pour une note existante, elle synchronise le fichier temporaire
et échange son nom avec celui de la cible en un appel système. La voie Linux
utilise `renameat2(RENAME_EXCHANGE)` et la voie macOS `renamex_np(RENAME_SWAP)`
sur les volumes compatibles. Le chemin reste présent pendant l’échange.
Une création utilise un lien physique exclusif et préserve une cible existante.

Si la plateforme ou le volume ne permet pas l’échange atomique, le remplacement
est refusé par défaut. Sous Windows, une lecture concurrente a observé une
absence pendant un appel `ReplaceFileW` réussi avec sauvegarde. Windows refuse
donc aussi le remplacement par défaut. Sur un coffre sans synchronisation
bidirectionnelle active, l’option `MCP_HEADLESS_ALLOW_TRANSIENT_ABSENCE=true`
autorise l’ancienne séquence de déplacement puis de publication exclusive.
**Ne pas utiliser cette option avec une synchronisation bidirectionnelle active.**
Cette séquence expose une absence. Sous Windows, elle réessaie les erreurs de
partage pendant environ trois secondes et revérifie le hash à chaque tentative.

Le contrôle final compare les octets déplacés au hash scellé et relit le fichier publié. Le reçu
identifie `headless-filesystem`. En cas de divergence observée, l’opération
reste `outcome_unknown` et le journal conserve les versions disponibles lors
de la vérification. Un programme qui garde l’ancien fichier ouvert peut
encore le modifier après le dernier contrôle de la sauvegarde. En mode
d’écriture `full`, un retour arrière séparé compare le hash courant à celui
observé et enregistré. Relisez l’état enregistré avant de l’appliquer.

Placez le cache partagé hors du coffre. Le journal est créé à côté du cache
par défaut, d’après l’identité du coffre quel que soit le mode headless, ou
dans le répertoire d’état local si le cache est dans le coffre. Le verrou par
coffre est dans l’état local indépendamment du chemin du journal. Les processus
qui coopèrent partagent cet état. `MCP_HEADLESS_GOVERNED_JOURNAL_PATH` accepte
un chemin absolu hors du coffre. Le journal conserve les versions antérieures
et les divergences traitées pendant 30 jours. Protégez-le comme les données du coffre.

Gardez les réglages `.obsidian` disponibles avec la liste des extensions
actives et les réglages de Frontmatter Date Manager. L’autorité lit les noms
de propriétés, le format local pris en charge (minute ou seconde) et les
règles d’exclusion dans l’ordre. Elle respecte les dossiers Templates et
Templater. La création prend l’heure de l’application pour une note neuve, ou la date
de naissance du fichier quand une note existante n’a pas encore ce champ.
Définissez `OPTIMIKE_VAULT_TIMEZONE` sur le fuseau IANA des appareils qui
éditent le coffre. Réglez le `TZ` du processus sur le même fuseau. Un fuseau
déclaré dans l’extension doit également correspondre. Si vous utilisez le lecteur
Operon headless, réglez `OPERON_TIMEZONE` sur la même valeur. `TZ` seul ne suffit
pas à valider la politique. L’autorité écrit les
dates YAML sans guillemets et respecte le périmètre de détection des changements,
l’exclusion de Canvas.md et le réglage Excalidraw. Une édition pendant l’intervalle
minimal est appliquée et conserve la date de modification précédente.
L’agent ne fournit aucune des valeurs gérées par l’extension. Des réglages
absents ou non pris en charge ferment la voie d’écriture.
Le compilateur headless valide le YAML local et préserve le BOM et les fins
de ligne. En live, Desktop fournit la sérialisation YAML et les types natifs.

Après une interruption, appelez status avec la référence d’origine. Il peut
clore une écriture jamais publiée ou nettoyer le lien temporaire après une
création. Une interruption pendant l’échange natif laisse un fichier complet
à la cible. Avec l’ancienne séquence activée, le démarrage et le premier statut
rétablissent un original absent depuis sa sauvegarde par un lien exclusif et
signalent un conflit. Une écriture déjà
préparée ne se rejoue pas. Pour annuler une écriture terminée, planifiez un
retour arrière en
indiquant le chemin et la référence d’origine, puis appliquez ce nouveau plan.
Le hash doit toujours correspondre au résultat de l’écriture d’origine.
Une note existante retrouve son contenu antérieur avec la politique de dates
en vigueur. Annuler une création rétablit l’absence du chemin et exige
`MCP_WRITE_MODE=full` ainsi qu’un journal sur le même système de fichiers.

## Décision go/no-go serveur

Go si `test:runtime`, `smoke:headless-server-profile`, une validation longue courte puis longue, et `npm pack --dry-run` sont verts. No-go si le vault serveur synchronise encore dans le même emplacement que le Desktop vivant, si le cache est dans le vault, ou si les écritures sont activées avant snapshot/rollback.
