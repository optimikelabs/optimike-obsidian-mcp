# Instructions d’agent du coffre (AGENTS.md)

English version: [vault-instructions.md](vault-instructions.md)

Beaucoup de coffres rangent des règles pour les agents dans `AGENTS.md`, à la racine et dans les dossiers qui ont des règles locales. Un agent lancé à la racine du coffre (Codex, Claude Code) lit lui-même le fichier racine. Un agent qui ne voit le coffre que par ce serveur (ChatGPT, Claude Desktop, un agent lancé ailleurs) ne reçoit jamais ces fichiers : rien ne lui dit qu’ils existent avant d’écrire.

Le serveur comble ce manque sans rien supposer du coffre :

- ses instructions MCP demandent à l’agent de lire les fichiers d’instructions avant d’écrire ;
- chaque plan d’écriture et chaque écriture directe liste les fichiers d’instructions qui s’appliquent aux chemins qu’il écrit, et indique ceux que l’agent n’a pas lus dans leur version actuelle ;
- en option (`enforce`), l’écriture est refusée tant que chacun d’eux n’a pas été servi à l’agent.

Ce que le serveur prouve, c’est que l’agent a reçu les consignes applicables, dans leur version actuelle, avant d’écrire. Il ne prouve ni que le modèle les respecte, ni qu’une personne a accepté l’écriture.

## Réglages

| Variable | Valeurs | Défaut | Rôle |
| --- | --- | --- | --- |
| `MCP_VAULT_INSTRUCTIONS` | `off`, `advise`, `enforce` | `advise` | Mode de ce serveur, ou de ce client quand il est défini sur un proxy stdio. |
| `MCP_VAULT_INSTRUCTIONS_MIN` | `off`, `advise`, `enforce` | `off` | Minimum administratif. Aucun client ne peut choisir un mode plus bas. |
| `MCP_VAULT_INSTRUCTIONS_FILES` | 1 à 8 noms de fichiers, séparés par des virgules | `AGENTS.md` | Noms des fichiers d’instructions, par exemple `AGENTS.md,CLAUDE.md`. Noms simples, sans dossier. |
| `MCP_VAULT_INSTRUCTIONS_JOURNAL_PATH` | chemin absolu | dossier d’état local de la machine | Journal SQLite des scellés de plans. Donner un chemin absolu hors de tout coffre synchronisé : le serveur ne le vérifie pas à votre place. |

Une valeur invalide arrête le serveur au démarrage, sans recopier la valeur.

### Modes

- `off` : le serveur se comporte exactement comme avant cette fonctionnalité.
- `advise` (défaut) : instructions de serveur et champ `vaultInstructions` dans le résultat de chaque plan d’écriture et de chaque écriture directe dont les cibles ont des fichiers d’instructions. Rien n’est refusé à cause des instructions.
- `enforce` : la même chose, et un plan d’écriture ou une écriture directe est refusé avant que l’outil ne s’exécute tant qu’un fichier applicable n’est pas lu, ou a changé depuis sa lecture. L’apply ou le recover d’un plan est refusé si les règles ont changé après le plan. `enforce` refuse aussi, par prudence, les écritures dont il ne peut pas déterminer la cible, même dans un coffre sans fichier d’instructions (voir plus bas).

### Choisir le mode par client

Le bon mode dépend de l’endroit où l’agent est lancé :

| Client | Mode conseillé | Pourquoi |
| --- | --- | --- |
| Codex ou Claude Code lancé à la racine du coffre | `advise` ou `off` | Ils lisent eux-mêmes le `AGENTS.md` racine ; `advise` signale encore les fichiers locaux des dossiers visés. |
| Claude Desktop, ChatGPT, tout agent qui ne voit le coffre que par MCP | `enforce` | Rien d’autre ne lui fait lire les règles. |

Dans l’installation locale habituelle, chaque client lance son propre proxy stdio et tous les proxys partagent un backend HTTP. Définir `MCP_VAULT_INSTRUCTIONS` dans l’environnement du proxy de chaque client : le proxy l’envoie au backend à chaque requête (en-tête `X-Optimike-Vault-Instructions`) et ne le transmet jamais à un backend qu’il démarre ; un client en `enforce` ne change donc pas les autres. Un client HTTP direct qui n’envoie pas l’en-tête reçoit le `MCP_VAULT_INSTRUCTIONS` du backend. `MCP_VAULT_INSTRUCTIONS_MIN=enforce` s’applique à tous les clients de ce backend, proxys locaux compris : pour garder `advise` ou `off` sur les clients locaux pendant qu’un tunnel distant est en `enforce`, donner au tunnel son propre backend.

## Ce qui change dans un coffre sans fichier d’instructions

- `off` : rien.
- `advise` : les résultats ne changent pas, mais chaque écriture contrôlée sonde maintenant les dossiers de la chaîne de sa cible (et, pour les mutations Operon, résout d’abord la note de la tâche ou le dossier des tâches fichiers). Quand une sonde échoue, le résultat porte `vaultInstructions` avec `verified: false`. Les plans sont scellés dans le journal : ils restent applicables si le client passe ensuite en `enforce`.
- `enforce` : les résultats des écritures dont la cible est connue ne changent pas. Sont refusés, même sans aucun fichier d’instructions :
  - une écriture dont la cible ne peut pas être déterminée (`vault_instructions_target_unresolved`, voir la section suivante) ;
  - tout plan ou apply pendant que le journal des scellés ne peut pas s’ouvrir (`vault_instructions_unavailable`, `unavailableReason: "seal_journal"`) ;
  - l’apply d’un plan créé quand le client était en `off` (`vault_instructions_plan_unsealed`) ;
  - une écriture dont les fichiers d’instructions ne peuvent pas être lus à ce moment (`vault_instructions_unavailable`).

## Fichiers qui s’appliquent à une écriture

Pour une cible `Projets/Client/Note.md`, le serveur cherche chaque nom configuré à la racine du coffre, dans `Projets/` puis dans `Projets/Client/`, dans cet ordre (profondeur du dossier, puis ordre de `MCP_VAULT_INSTRUCTIONS_FILES`). Chaque fichier existant s’applique ; les fichiers plus locaux précisent les règles de la racine.

Les cibles sont les chemins que le backend écrit réellement :

- Un chemin est gardé tel qu’il est écrit, sans normalisation Unicode. Quand ses formes composée (NFC) et décomposée (NFD) diffèrent, les chaînes de chaque forme sont contrôlées, car un backend ou un système de fichiers peut résoudre l’une ou l’autre. Sur un système de fichiers qui garde les deux comme dossiers distincts, les fichiers des deux s’appliquent.
- Un déplacement applique les chaînes de la source et de la destination. Un archivage (`obsidian_admin_filesystem`) contrôle chaque destination telle que l’outil l’écrit (`archiveDir` joint au nom du fichier) ; une destination qui ne peut pas être résolue est une cible inconnue. Un plan de déplacement natif (`obsidian_note_move_plan`) applique aussi les chaînes de chaque note dont il réécrit les liens (`affectedPaths` de son voisinage scellé) ; elles font partie du scellé du plan. Si ces notes ne peuvent pas être déterminées, `enforce` refuse le plan.
- Les outils par lots appliquent l’union des chaînes de toutes leurs notes cibles.
- `asset_import_plan` utilise le dossier d’assets configuré (`MCP_ASSET_FOLDER`).
- Les mutations Operon utilisent la note qui porte la tâche (résolue depuis `operonId`) et leur destination : `targetPath` pour les tâches inline, les conversions vers inline et les relocalisations ; pour une création de tâche fichier ou une conversion inline vers fichier, `targetFolder` sur un moteur historique, sinon le dossier des tâches fichiers de la configuration Operon en direct (`creation.fileTasksFolder`, lu par un préflight qui n’écrit rien), plus le dossier de la note de la tâche parente quand un `parentTask` est donné. Sans dossier configuré, Operon range le fichier selon sa parente : seul le dossier de la parente est contrôlé.
- Les opérations en lecture seule des outils mixtes ne sont jamais contrôlées : `get`, `list`, `index`, `audit`, `validate`, `validateOnly`, et l’aperçu d’un `rename` de tag (`dryRun` vrai, la valeur par défaut). Un vrai `rename` de tag écrit des notes connues seulement à l’exécution : `enforce` le refuse comme cible indéterminée.

Quand le chemin visé ne peut pas être connu (`targetType: "activeFile"`, création de tâche périodique Operon, tâche Operon inline sans `targetPath`, tâche fichier quand Operon n’a ni dossier de tâches fichiers configuré ni tâche parente, `operonId` inconnu, renommage de tag sur tout le coffre), `advise` liste les fichiers de la racine avec `targetResolved: false`, et `enforce` refuse avec `vault_instructions_target_unresolved` et un message qui dit quoi faire à la place.

### Bornes

Le serveur ne parcourt jamais le coffre : chaque contrôle sonde seulement les dossiers des chaînes de ses cibles. Chaque sonde est bornée, et les bornes sont appliquées, pas seulement annoncées :

| Borne | Valeur |
| --- | --- |
| Un fichier d’instructions | 256 Kio ; jamais lu au-delà |
| Tous les fichiers d’un contrôle | 1 Mio |
| Une sonde | 2,5 s |
| Un contrôle, attente comprise | 5 s |
| Sondes en cours pour un contrôle | 4 |
| Sondes en cours pour tout le processus backend | 8 |
| Résolutions Operon avant les sondes | 5 s chacune |

À l’échéance, les sondes encore en cours sont annulées (la requête Local REST est interrompue, la lecture disque s’arrête) ; le serveur cesse d’attendre une résolution Operon après 5 s, tandis que la requête Operon elle-même se termine sur son propre délai. Un fichier au-delà d’une borne d’octets rend le contrôle indisponible avec `unavailableReason: "too_large"` (`enforce` refuse, pas de nouvel essai à l’identique : raccourcir le fichier ou le répartir entre dossiers).

## Preuve de lecture

L’agent lit un fichier d’instructions avec `obsidian_read_note`, au chemin exact listé. Le serveur enregistre alors, pour ce lecteur, le SHA-256 du contenu servi (fins de ligne normalisées), après l’avoir comparé à la copie qui fait foi (Local REST API en mode live, lue en texte brut quel que soit son type de contenu ; fichier sur disque en headless). Les résultats de recherche et les extraits sémantiques ne comptent jamais.

Un fichier modifié après la lecture est signalé `changed` et doit être relu. La preuve montre seulement que le contenu a été servi à ce lecteur.

Le lecteur est :

- la session MCP en Streamable HTTP legacy (un proxy stdio a une session par processus) ;
- le processus, pour un serveur stdio direct ;
- en HTTP sans session (2026-07-28), l’identité vérifiée plus le contexte de lecteur propre à chaque processus proxy (`X-Optimike-Reader-Context`) ; sans cet en-tête, l’identité seule, annoncée `readerScope: "identity"` : des agents qui partagent un même identifiant partagent alors leurs lectures.

Les preuves vivent en mémoire (bornées, 24 heures d’inactivité) et disparaissent au redémarrage ; l’agent relit alors les fichiers.

## Frontière de confiance

Un fichier d’instructions est un contenu du coffre servi tel quel à l’agent. Le serveur ne l’exécute pas et ne l’interprète pas, et une règle locale n’acquiert aucune autorité sur les instructions de l’utilisateur ou de l’hôte. Qui peut écrire un `AGENTS.md` dans le coffre peut placer du texte devant tout agent qui écrit en dessous, comme avec n’importe quelle note : traiter les fichiers d’instructions comme le reste du contenu du coffre.

En mode headless, un fichier d’instructions qui est un lien symbolique, ou qui se résout hors du coffre (par une jonction, par exemple), compte comme absent : des règles centralisées par lien symbolique ne sont pas servies. Copier le fichier à la place. En mode live, Local REST API décide de la résolution des liens ; ce comportement n’a pas été qualifié.

## Scellés de plans

Quand un plan gouverné dont la cible est connue est créé en `advise` ou en `enforce`, le serveur scelle ses cibles et ses règles (`rulesDigest`) dans son propre journal SQLite, à part des journaux d’opération, et n’annonce `sealed: true` qu’une fois le scellé écrit. L’apply ou le recover recalcule les règles des cibles scellées :

- mêmes règles et preuves à jour : l’outil s’exécute ;
- règles changées (fichiers `changed`, `added` ou `removed`) : `enforce` refuse avec `vault_instructions_changed_since_plan`, `advise` exécute et signale `changedSincePlan: true` ;
- pas de scellé (plan antérieur à la fonctionnalité, créé en mode `off`, dont le scellé n’a pas pu être écrit, ou de plus de 90 jours) : `enforce` refuse avec `vault_instructions_plan_unsealed`.

Quand le journal ne peut pas s’ouvrir, `enforce` refuse le plan lui-même avant son exécution (un plan qu’il ne pourrait jamais appliquer) ; quand l’écriture d’un scellé échoue après le plan, le résultat indique `sealed: false` et précise que son apply sera refusé. `advise` signale `sealed: false` et ne refuse rien.

Le refus d’un apply a lieu avant l’exécution de l’outil : il ne change jamais l’état de l’opération. Les outils `status` ne sont jamais contrôlés. Refaire le plan avec la même clé d’idempotence et la même intention renvoie le même plan et le scelle à nouveau sous les nouvelles règles. Le scellé n’est pas une signature : un administrateur local qui peut modifier le journal est hors de ce modèle.

## Refus (`enforce`)

Chaque refus est une erreur d’outil avec `error.details.reasonCode`, un message qui dit quoi faire, et un objet `vaultInstructions`.

| `reasonCode` | Sens | Ce que fait l’agent |
| --- | --- | --- |
| `vault_instructions_unread` | Un fichier applicable est `unread` ou `changed`. | Lire chaque fichier listé avec `obsidian_read_note` (voir `nextActions`), puis rappeler le même outil avec les mêmes arguments. Pour un déplacement natif dont des notes réécrites ont des règles non lues, le plan a été enregistré mais pas scellé : lire, puis refaire le plan avec la même clé d’idempotence. |
| `vault_instructions_changed_since_plan` | Les règles ont changé après le plan. | Appeler d’abord le `status` de la famille. Seulement si le plan est encore `planned` : lire les fichiers `changed` ou `added`, puis refaire le plan, en reprenant les arguments seulement si les nouvelles règles ne changent pas l’intention. |
| `vault_instructions_plan_unsealed` | Le plan n’a pas de scellé. | Appeler d’abord `status`. Seulement si le plan est encore `planned` : lire les fichiers d’instructions, puis refaire le plan. |
| `vault_instructions_target_unresolved` | Le chemin écrit ne peut pas être connu. | Suivre le message (forme à chemin explicite, réglage à faire). Pas de nouvel essai à l’identique. |
| `vault_instructions_unavailable` | Les fichiers d’instructions, la destination Operon ou le journal des scellés n’ont pas pu être lus (`unavailableReason` : `timeout`, `source_error`, `invalid_response`, `too_large`, `seal_journal`). | Rien n’a été planifié ni écrit. Réessayer plus tard, sauf `too_large` et `seal_journal`, qui demandent le propriétaire du coffre. |

La structure exacte d’un refus est donnée dans la [version anglaise](vault-instructions.md#refusals-enforce).

## Instructions de serveur

Quand le mode n’est pas `off` et que la racine du coffre contient un fichier d’instructions, les `instructions` MCP renvoyées à l’initialisation demandent à l’agent de lire le fichier racine et ceux des dossiers parents de tout chemin qu’il écrit, et, en `enforce`, précisent que les écritures sont refusées d’ici là. Elles désignent les fichiers sans jamais inclure leur contenu. Le proxy stdio les relaie à son client. La présence du fichier racine est mémorisée 60 secondes ; les instructions déjà reçues par un client ne sont pas mises à jour. Si le coffre ne peut pas être lu au moment où le client se connecte (Obsidian pas encore lancé), cette connexion ne reçoit pas d’instructions ; ses résultats d’écriture portent quand même `vaultInstructions`.

## Limites

- Seules les écritures qui passent par ce serveur sont contrôlées. Un agent qui écrit directement dans les fichiers du coffre, ou un autre plugin, ne l’est pas.
- Le contrôle a lieu juste avant l’outil. Une règle modifiée entre le contrôle et l’écriture est vue à l’écriture suivante, pas à celle-ci.
- `operon_recover_mutation` n’est pas contrôlé : il reprend une mutation déjà admise, dont les chemins ne sont pas exposés.
- Les notes qu’Operon écrit de lui-même après une mutation (archivage automatique, cascades vers les tâches parentes ou enfants, copies de récurrence) ne sont pas contrôlées.
- Pour une tâche fichier qui a une parente, le dossier configuré (s’il existe) et celui de la parente sont contrôlés ; une arborescence plus profonde qu’Operon choisirait pour les tâches enfants n’est pas connue du serveur.
- En `enforce`, la création de tâche périodique Operon est refusée : Operon n’expose pas le chemin de la note périodique avant de créer la tâche. Baisser le mode de ce client pour créer des tâches périodiques.
- `obsidian_runtime_maintenance` et `obsidian_operation_close` n’écrivent pas le contenu du coffre et ne sont pas contrôlés.
- Un fichier lu sous une autre casse (`agents.md`) n’est pas le fichier listé : lire le chemin exact indiqué.
