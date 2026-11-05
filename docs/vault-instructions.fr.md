# Instructions d’agent du coffre (AGENTS.md)

English version: [vault-instructions.md](vault-instructions.md)

Beaucoup de coffres rangent des règles pour les agents dans `AGENTS.md`, à la racine et dans les dossiers qui ont des règles locales. Un agent lancé à la racine du coffre (Codex, Claude Code) lit lui-même le fichier racine. Un agent qui ne voit le coffre que par ce serveur (ChatGPT, Claude Desktop, un agent lancé ailleurs) ne reçoit jamais ces fichiers : rien ne lui dit qu’ils existent avant d’écrire.

Le serveur comble ce manque sans rien supposer du coffre :

- ses instructions MCP demandent à l’agent de lire les fichiers d’instructions avant d’écrire ;
- chaque plan d’écriture et chaque écriture directe liste les fichiers d’instructions qui s’appliquent au chemin visé, et indique ceux que l’agent n’a pas lus dans leur version actuelle ;
- en option, l’écriture est refusée tant qu’ils ne sont pas lus.

Un coffre sans fichier d’instructions ne voit aucune différence : ni instructions, ni champ en plus, ni refus, quel que soit le mode.

## Réglages

| Variable | Valeurs | Défaut | Rôle |
| --- | --- | --- | --- |
| `MCP_VAULT_INSTRUCTIONS` | `off`, `advise`, `enforce` | `advise` | Mode de ce serveur, ou de ce client quand il est défini sur un proxy stdio. |
| `MCP_VAULT_INSTRUCTIONS_MIN` | `off`, `advise`, `enforce` | `off` | Minimum administratif. Aucun client ne peut choisir un mode plus bas. |
| `MCP_VAULT_INSTRUCTIONS_FILES` | 1 à 8 noms de fichiers, séparés par des virgules | `AGENTS.md` | Noms des fichiers d’instructions, par exemple `AGENTS.md,CLAUDE.md`. Noms simples, sans dossier. |
| `MCP_VAULT_INSTRUCTIONS_JOURNAL_PATH` | chemin absolu | dossier d’état local de la machine | Journal SQLite des scellés de plans. Jamais dans un coffre synchronisé. |

Une valeur invalide arrête le serveur au démarrage, sans recopier la valeur.

### Modes

- `off` : le serveur se comporte exactement comme avant cette fonctionnalité.
- `advise` (défaut) : instructions de serveur et champ `vaultInstructions` dans le résultat de chaque plan d’écriture et de chaque écriture directe dont la cible a des fichiers d’instructions. Rien n’est jamais refusé.
- `enforce` : la même chose, et un plan d’écriture ou une écriture directe est refusé avant que l’outil ne s’exécute tant qu’un fichier applicable n’est pas lu, ou a changé depuis sa lecture. L’apply ou le recover d’un plan est refusé si les règles ont changé après le plan.

### Choisir le mode par client

Le bon mode dépend de l’endroit où l’agent est lancé :

| Client | Mode conseillé | Pourquoi |
| --- | --- | --- |
| Codex ou Claude Code lancé à la racine du coffre | `advise` ou `off` | Ils lisent eux-mêmes le `AGENTS.md` racine ; `advise` signale encore les fichiers locaux des dossiers visés. |
| Claude Desktop, ChatGPT, tout agent qui ne voit le coffre que par MCP | `enforce` | Rien d’autre ne lui fait lire les règles. |

Dans l’installation locale habituelle, chaque client lance son propre proxy stdio et tous les proxys partagent un backend HTTP. Définir `MCP_VAULT_INSTRUCTIONS` dans l’environnement du proxy de chaque client : le proxy l’envoie au backend à chaque requête (en-tête `X-Optimike-Vault-Instructions`) et ne le transmet jamais à un backend qu’il démarre ; un client en `enforce` ne change donc pas les autres. Un client HTTP direct qui n’envoie pas l’en-tête reçoit le `MCP_VAULT_INSTRUCTIONS` du backend. Mettre `MCP_VAULT_INSTRUCTIONS_MIN=enforce` sur le backend quand aucun client ne doit écrire sans lire les règles, par exemple derrière un tunnel distant.

## Fichiers qui s’appliquent à un chemin

Pour une cible `Projets/Client/Note.md`, le serveur cherche chaque nom configuré à la racine du coffre, dans `Projets/` puis dans `Projets/Client/`, dans cet ordre (profondeur du dossier, puis ordre de `MCP_VAULT_INSTRUCTIONS_FILES`). Chaque fichier existant s’applique ; les fichiers plus locaux précisent les règles de la racine.

- Un déplacement applique les chaînes de la source et de la destination.
- Les outils par lots appliquent l’union des chaînes de toutes leurs notes cibles.
- `asset_import_plan` utilise le dossier d’assets configuré (`MCP_ASSET_FOLDER`).
- Les mutations Operon utilisent la note qui porte la tâche (résolue depuis `operonId`) et tout `targetPath` explicite.
- Les opérations de lecture des outils mixtes (`get`, `list`, `validate`, `validateOnly`) ne sont jamais contrôlées.

Quand le chemin visé ne peut pas être connu (`targetType: "activeFile"`, création de tâche périodique Operon, `operonId` inconnu), `advise` liste les fichiers de la racine avec `targetResolved: false`, et `enforce` refuse avec `vault_instructions_target_unresolved` en indiquant la forme à chemin explicite à utiliser.

Le serveur ne parcourt jamais le coffre : chaque contrôle sonde seulement les dossiers des chaînes de ses cibles (sans doublon, au plus 4 sondes en parallèle, 2,5 s chacune). Le coût dépend de la profondeur des dossiers, pas de la taille du coffre.

## Preuve de lecture

L’agent lit un fichier d’instructions avec `obsidian_read_note`, au chemin exact listé. Le serveur enregistre alors, pour ce lecteur, le SHA-256 du contenu servi (fins de ligne normalisées), après l’avoir comparé à la copie qui fait foi (Local REST API en mode live, fichier sur disque en headless). Les résultats de recherche et les extraits sémantiques ne comptent jamais.

Un fichier modifié après la lecture est signalé `changed` et doit être relu. La preuve montre seulement que le contenu a été servi à ce lecteur, pas que le modèle s’en est servi.

Le lecteur est :

- la session MCP en Streamable HTTP legacy (un proxy stdio a une session par processus) ;
- le processus, pour un serveur stdio direct ;
- en HTTP sans session (2026-07-28), l’identité vérifiée plus le contexte de lecteur propre à chaque processus proxy (`X-Optimike-Reader-Context`) ; sans cet en-tête, l’identité seule, annoncée `readerScope: "identity"` : des agents qui partagent un même identifiant partagent alors leurs lectures.

Les preuves vivent en mémoire (bornées, 24 heures d’inactivité) et disparaissent au redémarrage ; l’agent relit alors les fichiers.

## Scellés de plans

Quand un plan gouverné est créé en `enforce` (ou en `advise` quand des fichiers s’appliquent), le serveur scelle ses cibles et ses règles (`rulesDigest`) dans son propre journal SQLite, à part des journaux d’opération. L’apply ou le recover recalcule les règles des cibles scellées :

- mêmes règles et preuves à jour : l’outil s’exécute ;
- règles changées (fichiers `changed`, `added` ou `removed`) : `enforce` refuse avec `vault_instructions_changed_since_plan`, `advise` exécute et signale `changedSincePlan: true` ;
- pas de scellé (plan antérieur à la fonctionnalité, créé en mode `off`, ou de plus de 90 jours) : `enforce` refuse avec `vault_instructions_plan_unsealed`.

Un refus a lieu avant l’exécution de l’outil : il ne change jamais l’état de l’opération. Les outils `status` ne sont jamais contrôlés. Refaire le plan avec la même clé d’idempotence et la même intention renvoie le même plan et le scelle à nouveau sous les nouvelles règles.

## Refus (`enforce`)

Chaque refus est une erreur d’outil avec `error.details.reasonCode`, un message qui dit quoi faire, et un objet `vaultInstructions`.

| `reasonCode` | Sens | Ce que fait l’agent |
| --- | --- | --- |
| `vault_instructions_unread` | Un fichier applicable est `unread` ou `changed`. | Lire chaque fichier listé avec `obsidian_read_note` (voir `nextActions`), puis rappeler le même outil avec les mêmes arguments. |
| `vault_instructions_changed_since_plan` | Les règles ont changé après le plan. | Appeler d’abord le `status` de la famille. Seulement si le plan est encore `planned` : lire les fichiers `changed` ou `added`, puis refaire le plan, en reprenant les arguments seulement si les nouvelles règles ne changent pas l’intention. |
| `vault_instructions_plan_unsealed` | Le plan n’a pas de scellé. | Appeler d’abord `status`. Seulement si le plan est encore `planned` : lire les fichiers d’instructions, puis refaire le plan. |
| `vault_instructions_target_unresolved` | Le chemin écrit ne peut pas être connu. | Utiliser la forme à chemin explicite nommée dans le message. Pas de nouvel essai à l’identique. |
| `vault_instructions_unavailable` | Les fichiers d’instructions n’ont pas pu être lus. | Réessayer le même appel plus tard. Rien n’a été planifié ni écrit. |

La structure exacte d’un refus est donnée dans la [version anglaise](vault-instructions.md#refusals-enforce).

## Instructions de serveur

Quand le mode n’est pas `off` et que la racine du coffre contient un fichier d’instructions, les `instructions` MCP renvoyées à l’initialisation demandent à l’agent de lire le fichier racine et ceux des dossiers parents de tout chemin qu’il écrit, et, en `enforce`, précisent que les écritures sont refusées d’ici là. Elles désignent les fichiers sans jamais inclure leur contenu. Le proxy stdio les relaie à son client. La présence du fichier racine est mémorisée 60 secondes ; les instructions déjà reçues par un client ne sont pas mises à jour. Si le coffre ne peut pas être lu au moment où le client se connecte (Obsidian pas encore lancé), cette connexion ne reçoit pas d’instructions ; ses résultats d’écriture portent quand même `vaultInstructions`.

## Limites

- Seules les écritures qui passent par ce serveur sont contrôlées. Un agent qui écrit directement dans les fichiers du coffre, ou un autre plugin, ne l’est pas.
- Le contrôle a lieu juste avant l’outil. Une règle modifiée entre le contrôle et l’écriture est vue à l’écriture suivante, pas à celle-ci.
- `operon_recover_mutation` n’est pas contrôlé : il reprend une mutation déjà admise, dont les chemins ne sont pas exposés.
- `obsidian_runtime_maintenance` et `obsidian_operation_close` n’écrivent pas le contenu du coffre et ne sont pas contrôlés.
- Un fichier lu sous une autre casse ou une autre forme de chemin (`agents.md`) n’est pas le fichier listé : lire le chemin exact indiqué.
