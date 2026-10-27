# Règles de nom de note (valides partout)

English version: [note-name-rules.md](note-name-rules.md)

Un coffre est souvent ouvert sur plusieurs systèmes (Windows, macOS, iOS, Android) et
synchronisé. Un nom accepté par l'un peut être refusé, ignoré sans bruit ou donner un
lien cassé sur un autre. Le MCP applique donc **une règle partagée** à tout nom qu'il
**crée** : nouvelle note, destination d'un déplacement, fichier écrit par les outils
filesystem headless. La règle est `src/services/noteNameRules.ts` (pure, sans
dépendance ; le Bridge Atomic Write embarque le même fichier).

Elle ne s'applique qu'aux **nouveaux noms**. Une note existante garde son nom : elle
reste lisible, modifiable et déplaçable, et la déplacer vers un nom valide est la voie
de réparation.

## La règle en un paragraphe

Un chemin relatif au coffre, noms séparés par `/`, terminé par `.md` (toute extension
pour les écritures headless `.canvas`/`.base`). Dans chaque nom de dossier ou de
fichier : aucun de `\ : * ? " < > | # ^ [ ] %%`, aucun caractère de contrôle, aucun
caractère invisible ou espace insécable (U+00A0, U+202F, largeur nulle, marques de
direction, BOM…), aucun demi-substitut isolé ni non-caractère, Unicode **NFC**, pas de
point initial, pas d'espace initial ou final, pas de point final sur un dossier, aucun
nom réservé Windows (`CON PRN AUX NUL COM0-9 LPT0-9`, chiffres en exposant inclus, avec
ou sans extension). Chaque nom fait au plus 255 octets UTF-8 et le chemin entier au plus
240 caractères. Un nouveau nom ne doit pas différer d'un voisin existant par la seule
casse ou forme Unicode. Accents, tirets longs, apostrophes typographiques, `·`, `€`,
`&`, parenthèses, emoji et écritures non latines sont valides. ZWJ/ZWNJ ne sont acceptés
qu'entre lettres ou emoji (séquences d'emoji, persan, écritures indiennes).

## D'où vient chaque contrainte

Les sources sont celles du [document anglais](note-name-rules.md#where-each-constraint-comes-from) :
Microsoft Learn (caractères et noms réservés, point/espace final, `MAX_PATH` 260,
pas de normalisation Unicode côté Windows), l'aide officielle Obsidian sur les liens
(`# | ^ : %% [[ ]]` « peuvent ne pas fonctionner comme lien »), la liste des
caractères interdits par OS affichée par Obsidian (v1.8.10, forum), et les rapports
du forum sur NFC/NFD, la longueur, la casse et la synchronisation.

| Contrainte | Conséquence si ignorée |
|---|---|
| `* " \ / < > : \| ?` | Refusé par Windows/Obsidian ; sur un coffre synchronisé le fichier est ignoré ou disparaît sur l'autre système |
| `# ^ [ ] \|` | Nom parfois accepté, mais note inatteignable par un wikilink |
| Point initial | Fichier caché : la note n'apparaît pas dans le coffre, sans erreur |
| Espace ou point final | Non supporté par le shell Windows ; liens fragiles |
| Noms réservés Windows | Création et suppression impossibles normalement |
| NFC | Même nom visible, deux suites d'octets : lien introuvable, doublons, notes qui disparaissent après édition sur macOS |
| Caractères invisibles | Nom valide mais lien cassé (un lien saisi avec une espace normale ne correspond pas) |
| 255 octets / nom, 240 caractères / chemin | Obsidian de bureau accepte plus ; la synchronisation mobile et les sauvegardes échouent ensuite |
| Collisions de casse ou de forme Unicode | Deux fichiers n'en font qu'un sur Windows/macOS : l'un est perdu ou écrasé à la synchronisation |

Les affirmations sur APFS (insensible à la casse et à la normalisation par défaut)
sont de la connaissance générale de la plateforme : la page de référence Apple n'a pas
pu être lue automatiquement.

### Décisions

- **Crochets `[ ]`** : refusés pour les **nouveaux** noms seulement ; `(Guide)` est
  proposé à la place de `[Guide]`. Les notes existantes ne sont pas touchées.
- **NFC** : refusé avec proposition, jamais normalisé en silence (le MCP vérifie et
  refuse, il ne réécrit pas). L'import d'assets exige déjà NFC.
- **Emoji** : acceptés, mais comptés pour 2 unités UTF-16 et 4 octets UTF-8.
- **Non contrôlé** : points de code privés ou non assignés, noms comme `desktop.ini`,
  longueur réelle de la racine du coffre (budget fixe de 240), casse des dossiers
  *existants* du chemin.

## Une réponse de refus

Le contrat de confidentialité P0 est conservé (champs fermés, jamais le chemin soumis) :
`reasonCode` (`note_name_*`, liste fermée), `hint` (phrase fixe nommant la règle ou le
caractère, avec éventuellement `[segment N]` et `[U+XXXX]`), puis `suggestedPath` et
`suggestedName`. Une proposition n'est rendue que si elle respecte elle-même la règle ;
dérivée du texte de l'appelant, elle va à l'appelant seul et jamais au journal
(exception volontaire et documentée à « aucune chaîne dérivée de l'appelant dans
l'enveloppe publique »). Rien n'est renommé ni créé : l'agent renvoie la proposition
s'il l'accepte.

## Proposition (déterministe)

Une entrée conforme est rendue telle quelle. Sinon : `\` devient `/` ; `:` devient
` — ` (une heure `12:30` devient `12-30`) ; `|` devient `-` ; `"` devient `'` ; `[ ]`
deviennent `( )` ; `* ? < > # ^` et `%%` sont supprimés ; contrôles et insécables
deviennent une espace ; invisibles supprimés ; résultat en NFC ; segments vides, points
initiaux et espaces de bord retirés ; un nom réservé reçoit un suffixe `_`
(`CON.md` → `CON_.md`) ; `.md` est ajouté s'il manque. Les espaces créées autour d'un
remplacement sont réduites ; le texte déjà valide n'est pas touché. Pas de proposition
si le résultat serait vide ou si un nom ou le chemin est trop long : raccourcir un titre
est une décision de l'appelant.

## Contrôle en lecture seule avant d'écrire

`obsidian_validate_format` avec `kind: "note_name"` et `filePath` applique la même règle
et renvoie `{ ok, reasonCode, hint, suggestedPath, suggestedName }`. Il ne lit rien et ne
crée rien ; `.md`, `.base` et `.canvas` sont acceptés. Il vérifie la forme seulement : les
collisions de casse demandent le dossier et sont signalées par les outils de plan.

## Voies d'écriture

| Voie | Règle appliquée |
|---|---|
| `obsidian_note_create_plan` / `_apply` et Bridge `note-create` | Règle partagée au plan (refus public), au preflight et à l'apply du Bridge ; voisin replié refusé par le MCP (liste du dossier) et par le Bridge (dossier réel) |
| `obsidian_note_move_plan` / `_apply` et Bridge `native-note-move` | **Destination** seulement (source et voisinage restent sur le contrôle structurel historique) ; voisin replié refusé par le MCP et par le contrôle `absent` du Bridge |
| Headless `obsidian_move_note`, `obsidian_admin_filesystem` (batch_move), `obsidian_update_note`, `obsidian_manage_canvas`, écritures `bases_*` via `VaultFileService` | Règle partagée pour les fichiers qui n'existent pas encore, toute extension ; voisin replié refusé ; les dry-runs l'appliquent aussi. Les chemins avec `\` sont désormais refusés (utiliser `/`) |
| Import d'assets | Sa propre règle, plus stricte, exige déjà NFC et refuse `<>:"/\|?*[]#^`, point initial, point/espace final et noms réservés (limite 160) ; elle ne refuse pas les caractères invisibles |
| Bases Bridge `bases_create` / `bases_upsert_config` historiques | Non couverts : plugin indépendant, désactivé par défaut (`allowLegacyConfigWrites`) |
| Racines externes (`external_*`) | Hors périmètre : chemins hors coffre configurés par l'opérateur, contrat `EXTERNAL_ROOT_PATH_*` propre |

## Limites

- Les dossiers créés implicitement par une écriture headless sont validés, mais un
  dossier parent *existant* à la casse différente n'est pas détecté sur un système de
  fichiers sensible à la casse.
- `same_or_case_only_path` refuse toujours les renommages de casse seule ; un
  renommage NFD→NFC de la même note sur macOS peut être sans effet pour le système de
  fichiers.
- Le budget de 240 caractères est prudent ; une racine courte ou les chemins longs
  activés sous Windows permettraient plus.
