# Remplacement atomique gouverné d’une note

Version anglaise : [governed-note-replacement.md](governed-note-replacement.md)

Optimike Obsidian MCP 2.6.0 expose la première mutation publique non-Operon appuyée sur le
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

Les reçus terminaux stables restent rejouables après un redémarrage même si le
MCP est désormais en lecture seule, car ce rejeu ne peut produire aucun effet.
Un plan encore exécutable doit respecter la politique d’écriture courante ; le
backend la revalide de nouveau juste avant chaque tentative de
compare-and-replace.

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
La même règle vaut pour le rejeu terminal : le mode lecture seule ne masque pas
un reçu terminal existant, mais bloque toute récupération susceptible d’écrire.

## Sécurité et autorité durable

La politique d’écriture MCP courante s’applique en plus du write gate désactivé
par défaut de l’Atomic Write Bridge. En guarded, la cible reste explicite et
relative au coffre, et le contenu respecte les limites configurées.
`MCP_PROTECTED_FRONTMATTER_KEYS` ne peut pas être contourné par un remplacement
de fichier complet : le frontmatter est parsé comme YAML et comparé
structurellement, jamais par regexp. Le corps Markdown est transmis au Bridge
exactement comme fourni.
Comme cette comparaison dépend des lignes, le planning échoue fermé si la note
courante ou le remplacement scellé commence par un BOM UTF-8 ou contient des
fins de ligne CR seules. LF, CRLF et le mélange LF/CRLF restent supportés.

Le journal note-replace est l’unique autorité durable de cette opération. Les
plans non terminaux conservent `nextContent` scellé uniquement pour la
récupération du plan exact. Les transitions terminales stables expurgent ce
contenu et checkpointent les frames WAL sensibles ; les reçus terminaux restent
soumis à la politique de rétention bornée existante. Reçus et logs n’exposent ni
`nextContent` ni le chemin physique du journal.

### Settlement borné de la date de modification

Atomic Write Bridge 0.3.0 lit les réglages actifs de Frontmatter Date Manager,
Update Time et Update time on edit. Son contrat de protection annonce les vrais
noms configurés des propriétés de création, modification et dernière vue. Le
MCP ajoute automatiquement ces noms à sa protection structurelle ;
`MCP_PROTECTED_FRONTMATTER_KEYS` reste additif pour les champs personnalisés et
les anciens Bridges. Une propriété de création active doit déjà exister dans la
note cible, sinon le planning échoue fermé car le plugin pourrait insérer une
seconde ligne après le CAS. La dernière vue est protégée mais jamais admise en
settlement : ouvrir une note est un événement utilisateur distinct, pas une
conséquence attendue de l’écriture.

Seule une propriété de modification compatible entre dans le contrat de
settlement. Le Bridge annonce aussi le délai d’observation borné issu du
debounce/rate-limit de chaque plugin. Le MCP ne démarre cette fenêtre durable
qu’après le retour du CAS — réussi ou en échec après envoi — puis attend avant
sa relecture postflight même lorsque la réponse CAS réussit normalement. Un
observateur `status` ou `recover` concurrent ne peut terminaliser ni le hash
scellé ni un premier settlement de timestamp pendant cette attente. Valeurs
numériques, fuseaux forcés, formats non supportés ou délais supérieurs à quatre
minutes ne sont pas admis. Une annonce legacy sans délai — notamment Bridge
0.2.0 avec une intégration de date active — échoue fermé et exige Bridge 0.3.0
ou ultérieur. Un reçu legacy non terminal déjà scellé sans ce délai reste
`outcome_unknown` et doit être replanifié ; le recovery ne suppose jamais un
délai nul. Frontmatter Date Manager reste également en
protection seule si le compteur d’updates, une commande post-update ou la
réparation d’inversion est actif, car ces réglages peuvent modifier plus que la
seule ligne de modification. Une propriété de modification active sans entrée
de settlement correspondante fait échouer le planning fermé.

Le Bridge exige des clés YAML plain source-stable composées de lettres, marques
ou chiffres Unicode, de `_`, `.`, `-` et d’espaces internes. Il n’annonce jamais
une propriété dont le nom contient une virgule. Les formes quotées comme
`#modified`, booléens/null YAML, débuts numériques, deux-points, sauts de ligne,
espaces périphériques ou plus de 128 unités de code de chaîne JavaScript sont
rejetés à la même frontière. Si une propriété active de création, modification
ou dernière vue n’est pas représentable à cette frontière, le Bridge annonce
le plugin et le rôle concernés sans renvoyer le nom brut dangereux. Le MCP
refuse le planning avant CAS au lieu de traiter silencieusement cette propriété
active comme absente. Ce signal est revalidé à l’apply/recover comme les autres
réglages des plugins de date.

La précondition d’écriture reste un CAS SHA-256 exact sur le fichier complet :
le settlement n’affaiblit pas le CAS pré-effet. Aucun timestamp n’est ignoré
avant l’effet. Pendant le postflight, la réconciliation d’une réponse perdue ou
un status après interruption, l’adaptateur peut accepter une seule ligne
top-level du frontmatter supplémentaire uniquement si toutes ces preuves sont
réunies :

- il s’agit d’une propriété de modification configurée annoncée par le
  Bridge ;
- la preuve provient toujours de l’identité backend et de la cible logique
  scellées ;
- les deux valeurs sont des dates locales canoniques et la valeur observée
  avance ;
- le timestamp observé appartient à la vraie fenêtre apply-settlement, durable
  et bornée à cinq minutes maximum ;
- remplacer cette seule ligne observée par sa valeur scellée rend la note
  byte-identical au contenu after scellé.

Le reçu conserve le SHA-256 cible scellé et le SHA-256 réellement observé après
settlement. Toute dérive du corps, du YAML, d’une seconde ligne, non monotone,
hors fenêtre, non protégée ou non configurée reste non vérifiée. Un Bridge qui
n’annonce pas ce contrat additif conserve le comportement historique par hash
exact.

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
frontmatter protégé et absence de fuite du contenu scellé. Elle couvre aussi une
réponse perdue suivie d’un timestamp Frontmatter Date Manager borné, la
réconciliation après redémarrage et le refus d’un timestamp accompagné d’une
vraie dérive concurrente.

La fixture de concurrence force aussi deux connexions au journal à observer la
même opération planifiée. Le perdant de la transition conditionnelle
`planned → applying` recharge et retourne le reçu durable gagnant, sans exposer
d’erreur interne ni tenter une seconde écriture.

Le rafraîchissement du cache après commit traite une note Markdown vide comme
un contenu valide. La gate d’intégration commite un remplacement vide, vérifie
la ligne SQLite partagée, puis désactive les lectures REST et prouve que le
fallback cache retourne la note vide plutôt que l’ancien contenu.

La fixture de recovery couvre aussi un ancien exécuteur qui commite avant
qu’une édition tierce fasse correspondre la note à aucun des deux hash scellés.
Le conflit CAS suivant reste `outcome_unknown` ; il ne devient pas un conflit
terminal au seul motif que la tentative de recovery n’a elle-même rien écrit.

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
avec un SHA-256 final identique au SHA-256 avant mutation. Ces garanties sont
publiées dans Optimike Obsidian MCP 2.6.0 ; les paliers de capacités suivants
restent des décisions séparées de l’autorité du dépôt.
