# Évaluation du routage et décision sur les profils (P6)

English version: [tool-routing-evaluation-p6.md](tool-routing-evaluation-p6.md)

P6 rend les décisions de surface reproductibles. Il ne suppose pas qu'une
surface plus petite est automatiquement meilleure et ne transforme pas la
préférence d'un modèle en autorité de sûreté.

## Décision pour la 3.8

- Les profils publics restent `standard`, `authoring`, `tasks` et `full`.
- Aucun outil n'est supprimé ni déplacé vers un autre profil public en 3.8.
- Aucun profil combinant authoring et tasks n'est ajouté. Leur union expose 60
  outils en live, alors que le corpus actuel ne contient aucun parcours répété
  prouvant qu'un changement de profil fait perdre un contexte nécessaire ou un
  reçu durable.
- Le registre cross-runtime de 81 noms est désormais classé et exporté comme
  inventaire versionné. Aucun alias de compatibilité n'est encore enregistré.

C'est un rejet fondé sur les preuves de cette release, pas une interdiction
définitive. Un profil de workflow pourra être réexaminé lorsqu'un parcours
mesuré dans une même session exigera à la fois une mutation d'authoring et une
mutation ou un recovery Operon.

## Deux couches de preuve indépendantes

### Autorité déterministe de la CI

Le corpus versionné, le contrat de trace et le scorer offline décident les faits
qui ne nécessitent aucun juge LLM :

- exactitude du premier outil et de sa famille ;
- appels interdits et mutation avant une clarification obligatoire ;
- succès établi par une post-condition du harness ;
- appels au-dessus du minimum déclaré par le corpus, sans prétendre que cet
  excédent est nécessairement inutile ;
- nombre réel d'outils de `tools/list` et octets UTF-8 réels du schéma ;
- reproductibilité et liaison de la trace au corpus, au commit, au modèle et sa
  configuration, au runtime, au profil, à la fixture et au numéro de run.

Un score qualitatif élevé ne peut jamais annuler une violation de sûreté.

### Jugement probabiliste optionnel

La rubrique data-only est indépendante du fournisseur et n'effectue aucun appel
réseau. Elle peut seulement juger des qualités résiduelles : accord de
l'explication finale avec les preuves fournies et utilité réelle d'une
clarification. Chaque jugement est lié au hash immuable de la trace. Une
comparaison par paires inverse la position des candidats ; un désaccord devient
une égalité ou un résultat à faible confiance.

Aucun run live de modèle ne bloque la CI. Toutes les traces brutes sont
conservées ; un rapport ne sélectionne jamais seulement le meilleur run.

## Contrat du corpus et des traces

`evals/tool-routing-corpus.json` conserve les 31 cas d'origine comme baseline
P6 dans une enveloppe versionnée. Chaque cas déclare sa famille attendue et sa
règle de clarification, en plus des premiers outils acceptables et des choix
interdits exacts.

Une trace JSONL reproductible enregistre :

- l'ID et le SHA-256 du corpus ;
- le SHA Git, le harness et sa version ;
- le modèle et sa configuration explicite ;
- le mode runtime, la surface exposée, le SHA-256 de fixture et le numéro de run ;
- un SHA-256 du contexte de cas prouvant qu'un profil ciblé et `full` ont reçu
  les mêmes cas de comparaison dans le même ordre ;
- les événements ordonnés `tool`, `clarification` et `final` ;
- la preuve de succès dérivée du harness ;
- le nombre réel d'outils, les octets de schéma et le hash canonique de la
  surface `tools/list`.

Le manifeste de run associé contient les schémas publics mesurés. Le scoring
strict exige `EXPECTED_CANDIDATE_COMMIT`, enregistre le checkout propre du
vérificateur comme `verifierSha` et conserve le commit source historique du
manifeste comme `candidateSha`. Il crée un worktree détaché propre sur
`candidateSha`, installe les dépendances verrouillées, supprime tout ancien
`dist/` ignoré, reconstruit le candidat, lie sémantiquement le corpus fourni au
blob Git exact du candidat, sélectionne la forme d'octets scellée par le
manifeste, puis reconstitue indépendamment chaque surface live canonique de
`tools/list` contre une fixture locale de statut
authentifié. Il compare le hash complet des schémas, recalcule chaque hash de
fixture, valide le hash du fichier de traces et
recalcule le succès depuis les preuves déterministes de routage et de sûreté.
Il exige aussi les quatre profils canoniques, tous les cas attribués à chaque
profil ciblé, les 31 cas sur `full` et deux à cinq répétitions complètes.

Le scorer préserve le hash des octets du corpus scellé par la campagne. Il
utilise les octets fournis quand ils correspondent à ce hash, ou reconstruit le
blob Git du candidat seulement si le manifeste a scellé ce blob et si le corpus
fourni se parse à l'identique. Le rapport enregistre les deux hashes et la
source retenue.

Le rapport lie la version du scorer, `verifierSha`, `candidateSha`, les hashes
du corpus, des traces et du manifeste, les hashes des artefacts reconstruits et
ceux des quatre surfaces. Les `publicTools` du candidat et de la comparaison
sont tous deux rehashés par le `measureToolsList` versionné du vérificateur ; le
calcul de digest déclaré par un candidat ne fait jamais autorité pour la
parité. La revalidation ne réécrit ni ne réattribue les
octets d'origine des traces, du corpus, du manifeste ou des fixtures.
`P6_COMPARE_COMMIT` permet d'exiger des surfaces publiques identiques sur un
candidat ultérieur ; toute dérive impose une nouvelle campagne LLM.

Le scorer lui-même ne dépend d'aucun fournisseur. La préparation d'un candidat
propre peut acquérir les dépendances verrouillées via le registre npm configuré
ou son cache ; après cette étape, le rescoring n'appelle aucun modèle ni runtime
externe. La préparation inclut toujours les dépendances de développement
verrouillées nécessaires au build, même si l'appelant utilise un environnement
npm de production. Le scoring legacy sans manifeste utilise seulement le
catalogue versionné et n'exige aucun checkout Git.

La sélection du modèle est regroupée selon le profil recommandé par le corpus.
La surface `full` reçoit exactement le même lot ordonné que le profil ciblé :
le contexte voisin ne peut donc pas biaiser la comparaison des surfaces. Le
scorer recalcule et impose ce hash de contexte pour chaque trace.

Une donnée absente vaut `N/A` ; l'absence de cas de clarification ne produit
jamais artificiellement une exactitude de 100 %.

## Mesurer l'exposition des schémas

La mesure live est readonly. Elle isole caches et journaux dans un dossier
temporaire de l'OS ; les logs transitoires redacted restent sous la frontière
`logs/` gitignored du projet. Chaque dossier de run est supprimé après le run,
et le parent vide est supprimé lorsqu'aucune mesure concurrente ne l'utilise. Elle ne peut donc
pas balayer ni réconcilier les opérations durables d'un utilisateur :

```powershell
$env:OBSIDIAN_RUNTIME_MODE = "live"
$env:OBSIDIAN_VAULT = "C:\chemin\vers\coffre-jetable"
$env:OBSIDIAN_API_KEY = "<clé-local-rest-api>"
$env:EXPECTED_COMMIT = (git rev-parse HEAD)
npm run build
node scripts/measure-tool-profile-schemas.mjs --require-live
```

La sortie contient seulement les noms publics, les volumes, les octets de
schéma canoniques et un SHA-256 par profil. Elle n'affiche jamais la clé API, le
chemin du coffre, les payloads ni le contenu des journaux.

Le sous-processus Codex optionnel reçoit une allowlist explicite de variables
d'environnement. Les chemins du coffre, clés Local REST, clés API fournisseur
et autres variables du processus ne sont jamais hérités. Ce harness utilise la
connexion normale enregistrée par la CLI Codex, pas une clé API d'environnement.

Le harness de sélection reconstruit `dist/` depuis le checkout propre attesté
avant de mesurer `tools/list`, puis revérifie le commit et l'arbre suivi. Un
ancien build ignoré ne peut donc jamais être attribué au SHA courant.
Le scorer strict reconstruit ensuite le candidat dans un worktree détaché et
recalcule ses schémas. Un build ignoré ancien, absent ou étranger est remplacé,
un candidat sale est refusé et un manifeste auto-cohérent venu d'un autre
commit ne peut pas passer en ne modifiant que ses volumes et hashes déclarés.

`Completed` signifie que les tests requis, la CI sur SHA exact et les gates de
review sont tous passés sur la même tête. Une Codex Review terminée qui contient
encore un finding n'est pas une review verte et ne ferme pas la gate.

## Règles du catalogue

Chaque nom enregistré appartient à une classe : canonique unique, alias
redondant, compatibilité historique, opération gouvernée, diagnostic ou
administration.

Deux schémas identiques ne prouvent pas deux contrats identiques. En particulier,
`operon_list_tasks` et `operon_query_tasks`, `apply` et `recover`, ainsi que les
endpoints external move fail-closed gardent des intentions distinctes. Les
fallbacks directs headless restent exposés lorsque la famille gouvernée Desktop
est absente.

Toute suppression physique future ou perte depuis un profil public existant est
une rupture de version majeure. Elle exige une migration documentée et un
remplaçant prouvé dans chaque runtime où l'ancien outil reste nécessaire.

## Vérification

```bash
npm run build
npm run test:tool-routing
npm run test:profiles
npm run test:docs
```
