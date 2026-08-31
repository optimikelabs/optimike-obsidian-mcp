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
- les événements ordonnés `tool`, `clarification` et `final` ;
- la preuve de succès dérivée du harness ;
- le nombre réel d'outils, les octets de schéma et le hash canonique de la
  surface `tools/list`.

Le manifeste de run associé contient les schémas publics mesurés. Le scoring
strict exige `EXPECTED_COMMIT`, vérifie le checkout courant, recalcule chaque
mesure de surface et hash de fixture, valide le hash du fichier de traces et
recalcule le succès depuis les preuves déterministes de routage et de sûreté.

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
