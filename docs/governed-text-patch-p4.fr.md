# Patches texte gouvernés du corps Markdown (P4)

Optimike MCP expose une famille bornée pour modifier le corps d’une
note Markdown existante :

```text
obsidian_text_patch_plan → apply → status → recover
```

Cette famille projette l’intention vers le runtime durable existant
`obsidian.note.replace`. Elle ne crée ni second journal ni second CAS. Le plan
lit le binding Atomic Write live, compile la note suivante complète, scelle le
hash avant écriture et le contenu privé, puis ne retourne qu’un reçu opaque.

## Intentions admises

- `append_body` ajoute un texte littéral non vide à la fin du corps ;
- `prepend_body` l’ajoute au début du corps ;
- `replace_literal` remplace par défaut une occurrence exacte unique ;
- le remplacement de toutes les occurrences exige `occurrence: all` et
  l’intention explicite scellée `intent: replace_all`.

Les opérations sont ordonnées et bornées. Regex, cible active, création de
fichier, ressource non Markdown, frontmatter mal fermé et correspondance
ambiguë sont refusés avant la création du plan enfant. Sans `frontmatterOperations`, le frontmatter reste
identique octet pour octet. Les vraies lignes de tâches Markdown sont
protégées ; les exemples placés dans un bloc de code fenced restent du texte.

## Représentation du texte et protection des tâches

Les fins de ligne LF, CRLF et mixtes sont supportées. Un CR nu ou un BOM UTF-8
est refusé fail-closed avant le plan. Les offsets publics et les comptes de
caractères protégés utilisent des unités de code UTF-16 JavaScript ; les
limites d’admission en octets utilisent des octets UTF-8.

Les exemples en forme de tâche placés dans un bloc fenced ne sont éditables
que si le scanner CommonMark-like et le parsing Operon les classent tous deux
comme fenced. Tout désaccord reste protégé, y compris une ambiguïté de fence
dans une citation.

## Concurrence et recovery

Deux plans peuvent sceller le même état initial, mais seul le premier CAS
Atomic Write correspondant peut committer. L’autre reçu devient conflictuel
sans écraser le gagnant. Après timeout ou perte de réponse, appeler `status`,
puis `recover` uniquement avec le même `planRef` et la même clé. Ne jamais
recréer aveuglément un patch.

Les noms configurés des propriétés de création, modification et dernière vue
proviennent du statut du Bridge. P4 hérite du settlement existant : un unique
timestamp de modification valide dans la fenêtre scellée peut être réconcilié ;
toute autre dérive du corps ou du frontmatter reste fail-closed. Le cache est
rafraîchi après un commit prouvé et ne décide jamais du CAS.

## Outils directs de compatibilité

Quand le quartet P4 complet est disponible, les profils live curatés le
préfèrent et masquent `obsidian_update_note` et `obsidian_search_replace`.
Le profil explicite `full` et les fallbacks headless conservent ces outils
directs, sans leur attribuer de reçu durable ni de garantie CAS.

## Canary live dans Pilot 2

Exécuter le canary live uniquement sur une note Markdown jetable existante du
coffre Pilot 2 ouvert. La commande exige le nom du coffre, la clé Local REST
API, la confirmation explicite et le commit candidat exact sur 40 caractères :

```powershell
$env:OBSIDIAN_TEXT_PATCH_CANARY_PATH="Canary/modified-time-settlement.md"
$env:OBSIDIAN_TEXT_PATCH_CANARY_VAULT="operon-bridge-pilot-vault-2.5.0"
$env:OBSIDIAN_TEXT_PATCH_CANARY_CONFIRM="I_UNDERSTAND_THIS_NOTE_WILL_BE_TEMPORARILY_PATCHED"
$env:OBSIDIAN_TEXT_PATCH_CANARY_EXPECTED_COMMIT="<SHA exact du candidat>"
$env:OBSIDIAN_API_KEY="<clé Local REST API>"
$env:MCP_WRITE_MODE="full"
npm run smoke:governed-text-patch-live
```

Le canary vérifie les quatre outils, append/prepend/remplacement littéral du
corps, un conflit de plan périmé, le settlement dynamique de la date de
modification et une restauration octet pour octet. Le nom de propriété est lu
depuis le contrat Atomic Write live ; il n'est jamais codé en dur. Le plugin de
date supporté est désactivé seulement pendant une restauration CAS directe,
verrouillée par le binding backend Atomic Write déjà attesté, puis réactivé et
contrôlé. La restauration ne crée pas un nouveau plan gouverné après retrait du
rôle dynamique de settlement.

Le script affiche le répertoire exact de récupération avant la connexion. Le
backup privé et le journal vivent dans le dossier temporaire du système. Les
logs runtime vivent dans la frontière ignorée par Git
`logs/governed-text-patch-live/`, imposée par la configuration du serveur. En
cas de succès, ou d'échec géré avant toute mutation, ces répertoires privés
sont supprimés. Si la restauration exacte de la note ou de l'état du plugin ne
peut pas être prouvée, ils sont conservés et leurs chemins exacts sont
affichés. La preuve JSON expurgée est écrite dans le dossier temporaire du
système et son chemin exact est affiché. La perte de réponse est couverte par
les tests déterministes du runtime, car le canary stdio live n'expose pas
d'injecteur de perte de réponse.

## Retour rapide et certification

`apply` et `recover` acceptent `completionMode: deferred | verified` (défaut :
`deferred`). Un CAS avec dates automatiques peut rendre `applying`,
`postflight.status: pending` et `postflight.checkAfter` sans `afterProof`.
Appeler `status` à partir de cette échéance ; seul `committed` avec `verified`
certifie le résultat. Le mode `verified` attend la même fenêtre complète.
L’attente reste durable après redémarrage et ne provoque pas de second CAS.
Voir le [contrat commun des modes](governed-note-replacement.fr.md#modes-de-retour-pour-note-corps-et-frontmatter).


## Plan combiné corps et frontmatter

`obsidian_text_patch_plan` accepte désormais `frontmatterOperations` en option,
avec les mêmes `set` / `delete` structurés que la projection frontmatter. Le
compilateur applique le patch du corps, puis le patch YAML sur ce résultat,
et scelle UNE note suivante avec UN CAS et UNE observation des dates. Les
deux politiques d'écriture et la protection des dates s'appliquent. Un échec
YAML ou un conflit refuse l'ensemble ; aucune moitié du patch n'est appliquée.

La preuve distingue les plages du corps (coordonnées de chaque opération) et
celles du frontmatter (entrée = sortie du compilateur corps). `composition`
lie le hash intermédiaire et le hash final. Hors de ces plages autorisées,
les octets sont préservés. Sans cette option, le frontmatter reste inchangé.

## Taille des reçus et diagnostic

Les quatre outils acceptent `responseMode: compact | detailed`. Le défaut
`detailed` préserve la compatibilité. `compact` conserve références/digests,
état, permissions, postflight et `checkAfter`, sans les longues preuves de
plages. `detailedReceipt` indique l'appel status permettant de relire toute
la preuve. Un reçu compact pending ne certifie jamais la réussite.

`diagnostics: true` ajoute des durées par appel serveur : statut du Bridge,
lecture de note, lecture préalable au CAS, CAS atomique et rafraîchissement du
cache. Les durées excluent le transport client et ne sont pas persistées dans
l'intention scellée. Les appels concurrents ont des compteurs isolés.

## Représentation des clés autorisées après FDM

FDM peut retirer des guillemets ou développer une collection YAML lors de sa
mise à jour de date. La postflight reconnaît ce changement uniquement pour
les clés frontmatter autorisées par la projection scellée : présence et valeurs
YAML doivent être identiques, le compilateur doit reconstruire leur forme
scellée, et le vérificateur original doit ensuite accepter une seule date
modifiée valide avec tous les autres octets exactement identiques. Une clé
supprimée ne peut réapparaître. Toute dérive du corps, création, d'une clé
inconnue ou du type YAML reste incertaine. Aucune seconde écriture n'est faite.
Le reçu détaillé expose settlementAuthorizedFormatKeyCount et le hash réellement
observé ; le journal conserve les clés concernées, y compris après redémarrage.
