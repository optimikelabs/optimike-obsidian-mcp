# Remplacement atomique gouverné d’une note

Version anglaise : [governed-note-replacement.md](governed-note-replacement.md)

Le candidat 2.6 expose la première mutation publique non-Operon appuyée sur le
vocabulaire du runtime commun. Elle remplace le contenu complet d’une note
Markdown existante sans publier d’API générique `operation_*`.

## Disponibilité et cycle de vie

Les quatre outils sont enregistrés uniquement en `live`, ou en `hybrid` quand
un service Obsidian REST partagé est configuré. Ils sont absents de tous les
modes headless et du mode hybrid dégradé sans identifiants API.

Un seul `RestAtomicWriteBackend`, `ObsidianNoteReplaceJournal` et
`ObsidianNoteReplaceOperationAdapter` est construit dans le cycle de vie de
l’application. Le même runtime est transmis au serveur stdio ou à toutes les
instances MCP créées par session HTTP, puis fermé au shutdown. Une session HTTP
n’ouvre jamais un journal SQLite concurrent.

Le journal utilise par défaut l’état Optimike MCP local à la machine. Un
opérateur peut définir `MCP_OBSIDIAN_NOTE_REPLACE_JOURNAL_PATH` avec un chemin
absolu. Il doit rester hors du coffre, des dépôts, dossiers synchronisés,
artefacts publiés et diagnostics publics.

## Contrat des outils

### `obsidian_note_replace_plan`

Entrée : `path`, le `nextContent` complet et une `idempotencyKey` obligatoire.

Le planning n’écrit pas la note. L’Atomic Write Bridge lit la note `.md`
existante ; cette même lecture fournit le SHA-256 initial et le contenu utilisé
pour comparer structurellement le frontmatter protégé. Le serveur valide le
futur Markdown Obsidian, scelle cible, binding backend, hashes avant/après,
digest de requête, clé d’idempotence et contenu privé nécessaire à la
récupération, puis retourne un reçu avec un `planRef` opaque.

La même clé et la même requête canonique retournent le même plan. Réutiliser la
clé pour un autre remplacement est refusé. Plan n’est pas une simple lecture :
il crée une intention durable de mutation et est bloqué par
`MCP_WRITE_MODE=readonly`.

### `obsidian_note_replace_apply`

Entrée : `planRef` et l’`idempotencyKey` correspondante uniquement. Le caller ne
peut plus substituer cible, contenu, binding ou hash après le planning.

Avant chaque effet possible, le serveur revalide la politique d’écriture MCP
courante, relit la cible pour vérifier frontmatter protégé et hash scellé,
contrôle le binding et le write gate du Bridge, puis délègue le plan exact au
compare-and-replace SHA-256 `Vault.process` d’Obsidian. Rejouer le même plan ne
peut pas produire une seconde écriture commitée.

### `obsidian_note_replace_status`

Entrée : `planRef` uniquement. Status lit et réconcilie l’autorité durable. Il
peut classer une opération auparavant incertaine depuis les preuves actuelles,
mais n’exécute jamais une nouvelle mutation.

Après timeout, interruption du processus ou réponse perdue, appeler d’abord
`status`. Ne pas créer une nouvelle mutation ni retry aveuglément avec une
nouvelle clé d’idempotence.

### `obsidian_note_replace_recover`

Entrée : `planRef` et l’`idempotencyKey` correspondante uniquement. Recover
réconcilie ou, si les preuves démontrent que c’est sûr, reprend exactement le
même plan scellé. Il n’accepte aucun payload de remplacement et ne peut pas
réactiver un plan terminal stable.

`recover` n’est pas `undo`. Il ne promet jamais de remettre automatiquement la
note dans son état précédent.

## Sécurité et autorité durable

La politique d’écriture MCP courante s’applique en plus du write gate désactivé
par défaut de l’Atomic Write Bridge. En guarded, la cible reste explicite et
relative au coffre, et le contenu respecte les limites configurées.
`MCP_PROTECTED_FRONTMATTER_KEYS` ne peut pas être contourné par un remplacement
de fichier complet : le frontmatter est parsé comme YAML et comparé
structurellement, jamais par regexp. Le corps Markdown est transmis au Bridge
exactement comme fourni.

Le journal note-replace est l’unique autorité durable de cette opération. Les
plans non terminaux conservent `nextContent` scellé uniquement pour la
récupération du plan exact. Les transitions terminales stables expurgent ce
contenu et checkpointent les frames WAL sensibles ; les reçus terminaux restent
soumis à la politique de rétention bornée existante. Reçus et logs n’exposent ni
`nextContent` ni le chemin physique du journal.

## Frontière d’effet

La garantie atomique couvre une ressource contrôlée : le contenu de la note
cible modifié par `Vault.process` sous précondition CAS SHA-256 exacte. Elle ne
forme pas une transaction distribuée et n’annule pas les effets transmis à
Sync, watchers, plugins tiers, indexeurs ou automatisations externes.

## Preuves et gate de release

La gate déterministe permanente traverse le serveur MCP compilé avec le vrai
client stdio du SDK et ne simule que la frontière HTTP Obsidian/Atomic Write.
Elle prouve schémas et annotations, convergence nominale, replay, réponse
perdue, redémarrage processus, récupération exacte, apply/recover concurrents,
compétition CAS entre deux plans, binding backend, changement de policy,
frontmatter protégé et absence de fuite du contenu scellé.

Une seconde gate démarre le vrai serveur Streamable HTTP et transporte un plan
scellé entre trois sessions MCP indépendantes. Elle prouve que les factories de
serveur par session partagent un seul runtime applicatif et un seul journal,
commitent un unique CAS backend et ferment proprement cette autorité au shutdown.

Chaque ligne `applying` enregistre aussi l'instance runtime qui l'exécute. Un
bail durable avec heartbeat prouve que cette instance précise reste active,
sans faire confiance à un PID réutilisable. Un autre processus MCP laisse
intact un bail frais ; son expiration ou l'arrêt explicite du propriétaire
autorise le recovery du plan exact. Un client lancé séparément ne peut donc pas
fabriquer une interruption pendant que le premier exécute encore le CAS.
Toute transition quittant `applying` doit aussi présenter l’identifiant de
tentative distinct observé par cet exécuteur et correspondre au payload durable
courant. L’instance runtime reste propriétaire du bail, mais chaque recovery
reçoit un nouveau fence de tentative. Un exécuteur qui reprend après expiration
de son bail ne peut donc pas terminer un plan déjà récupéré, même dans le même
processus.
Le nom du journal par défaut est en plus séparé par une empreinte stable et non
secrète du mode runtime, de l’URL REST et du chemin de coffre configurés ;
l’opérateur peut fournir un identifiant de profil stable explicite. Plans et
clés d’idempotence ne peuvent donc pas traverser deux profils backend, sauf si
l’opérateur impose volontairement le même chemin de journal.

La politique de contention SQLite est installée avant la négociation WAL, la
création du schéma, une migration, un bail ou une écriture de journal. Le
démarrage ne réessaie que les contentions transitoires dans une durée bornée et
ferme sa connexion si l’initialisation échoue définitivement. Un timeout du
heartbeat d’un processus déjà actif est contenu puis réessayé ; il n’arrête pas
le serveur MCP.

`npm run smoke:atomic-note-mcp-live` est un canary opérateur séparé qui échoue
fermé. Il exige une note jetable existante explicitement nommée et une chaîne de
confirmation, sauvegarde le contenu initial avant mutation, prouve un vrai
refus CAS du Bridge et les quatre outils MCP publics, restaure la fixture et
écrit une preuve expurgée directement sous la racine temporaire du système. Le
`evidenceFile` exact est affiché. Un succès ou un échec géré sans mutation
supprime le dossier privé journal/logs/sauvegarde ; une interruption brutale ou
une restauration non vérifiée le conserve au chemin de récupération affiché
avant le démarrage du MCP. Cette gate Desktop live a réussi le 2026-08-14,
avec un SHA-256 final identique au SHA-256 avant mutation. Merge, version et
release restent des décisions séparées de l’autorité du dépôt.
