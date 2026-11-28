# Producteur d’index sémantique autonome

Utiliser Node 22.12 ou ultérieur et un bridge BitNet qui expose son identité
d’encodage sur `GET /health`. Lancer la commande installée
`optimike-semantic-index`. Depuis le dépôt, lancer `npm run build` puis
`node scripts/semantic-index-producer.mjs`.

```text
optimike-semantic-index --vault <coffre> --index <index> --endpoint <origine-bitnet> --model <id-modèle> --revision <révision-modèle> --model-sha256 <sha256-poids-attendu>
```

Utiliser un dossier dédié à l’index, hors de tout coffre Obsidian, sur un système de fichiers
local. Le bridge reçoit les textes à encoder et leur provenance relative au
coffre. Utiliser un service de confiance et limiter l’accès à l’index et à ses
sauvegardes. Sous Windows, définir ces droits sur le dossier parent avant la
première génération. Prendre la révision et le SHA-256 dans la distribution du
modèle ou le verrou de déploiement. La CLI vérifie le SHA-256 déclaré par le
bridge pour les poids.

## Corpus et encodage

La CLI parcourt le Markdown UTF-8 en lecture seule et ignore les noms commençant
par un point. Répéter `--exclude-path` pour chaque chemin relatif à exclure,
fichier ou dossier, en respectant la casse et avec des barres obliques. Répéter
`--exclude-heading` pour chaque titre exact à exclure parmi les titres reconnus
par le parseur. Le producteur retire ces plages du texte des notes et écarte les
blocs qui les recouvrent. Fournir ces options à chaque lancement. Les liens
symboliques exigent une exclusion explicite. La traversée vers un autre volume
est refusée.

La règle jsbrains `SmartSource.should_embed` retient les notes dont la taille
en octets dépasse `--min-note-chars` (300 par défaut, y compris avec la valeur 0).
Chaque note retenue est encodée avec son fil d’Ariane, suivi de `:\n` et du Markdown.
Chaque bloc est encodé avec son fil d’Ariane parent et ses lignes d’origine,
bornes incluses. La CLI utilise le parseur épinglé de jsbrains et sa règle
`SmartBlock.should_embed`. Régler `--min-block-chars` sur la valeur utilisée
par Smart Connections pour le corpus (300 par défaut). Pour une configuration
Smart Connections avec des seuils de 200 pour les notes et 250 pour les blocs,
passer `--min-note-chars 200 --min-block-chars 250`. La règle écarte un
parent quand des descendants retenus atteignent les deux bornes définies par
jsbrains. Le frontmatter et les plages exclues restent hors de la recherche
par blocs. CUDA utilise `/bitnet/embed-batch` par lots de quatre au plus,
répartis entre les notes. Le CPU utilise `/bitnet/embed`. Les deux routes
reçoivent `purpose: document` et les vecteurs sont validés.

L’adaptateur générique jsbrains estime la limite à 3,7 caractères par token.
Le producteur fournit le texte exact et laisse le tokenizer BitNet appliquer
la limite annoncée dans `max_tokens` (32 768 pour le bridge actuel). Une
troncature ou un refus de taille écarte l’entrée. Le lecteur strict exige un
vecteur de note par source. Quand une note est écartée, ses blocs le sont aussi,
même s’ils tiennent dans le contexte. Le manifeste et la sortie de la CLI indiquent les
chemins ou blocs écartés et leur motif, y compris un UTF-8 invalide ou un
chemin incompatible avec le lecteur strict. Un échec de lecture arrête la
génération.

Le producteur recontrôle l’inventaire et les empreintes avant publication.
L’incrémental retrouve les vecteurs de la génération active à partir du texte
UTF-8 exact et du profil d’encodage. Un échec de lecture, un changement du
coffre ou un changement d’identité du bridge peut arrêter la publication. Le
coffre peut encore changer entre le dernier contrôle et le remplacement du
pointeur. Pour une vue à un instant précis, utiliser un instantané stable du
système de fichiers et lui dédier un dossier d’index.

Avant d’encoder, la CLI compare l’inventaire aux chemins de la génération
active. Avant de sceller la génération, elle vérifie à nouveau les chemins qui
seront réellement publiés. Elle refuse si plus de 10 % ou plus de 50 chemins
actifs seraient perdus. Les options `--max-deletion-percent` et
`--max-deletions` règlent ces seuils. Les renommages, exclusions, chemins
incompatibles et notes actives refusées pour un UTF-8 invalide ou par BitNet
entrent dans le calcul. Les notes écartées par le seuil de taille sont
signalées par `note_below_min_size` et exemptées. Utiliser `--allow-deletions`
pour une exécution après avoir vérifié que les pertes sont voulues.

## Amorçage depuis Smart Connections v3

```text
optimike-semantic-index bootstrap --from-smart-env <smart-env> --vault <coffre> --index <index> --endpoint <origine-bitnet> --model <id-modèle> --revision <révision-modèle> --model-sha256 <sha256-poids-attendu>
```

Utiliser un dossier d’index sans `CURRENT`, séparé du coffre et de Smart
Environment. Les deux dossiers sources sont lus en lecture seule. Si Desktop
indexe encore, utiliser un instantané stable de Smart Environment. L’import
compare le fournisseur actif, l’identifiant du modèle, les dimensions, le
budget de tokens et l’empreinte v3. Il vérifie l’empreinte de la note courante,
la référence du vecteur et, pour une section, la clé du bloc, ses lignes
inclusives et son empreinte. Une note doit avoir la même entrée sans filtrage.
Si Smart Connections a des titres exclus, les notes sont réencodées. Une
limite prudente en octets UTF-8 réserve une marge pour la tokenisation. Toute
ligne incompatible, trop longue ou invalide passe par l’encodage normal.

L’amorçage reprend les clés et la sélection par plages de Smart Connections
4.7.2, avec la politique de sélection 2 de Smart Environment v3. Il lit les
seuils des notes et des blocs, l’activation des vecteurs de blocs, les titres
exclus, les motifs de fichiers et dossiers et les règles Git ignore
enregistrées. Les seuils explicites de la CLI priment. La génération conserve
les paramètres de sélection pour les incrémentaux suivants, y compris sur une
autre machine. Pour adopter une autre configuration Desktop, amorcer un nouveau
dossier d’index. Le rapport compte les notes dont la taille en octets est inférieure
ou égale au seuil parmi les exclusions. Si le vecteur d’une note est écarté,
ses sections sont également absentes de la génération publiée.

Pour importer une section, la règle de sa source doit indiquer la version 2,
le minimum effectif des blocs et un budget de `floor(max_tokens * 3.7)`.
`sectionsWithRuleMismatch` compte les sections sélectionnées qui ont une
référence SC et dont la règle est absente ou incompatible. Ce nombre bloque la
publication s’il est non nul. `--allow-selection-mismatch` autorise le
réencodage de ces sections par le parcours normal.

Avant d’encoder le reste, le producteur réencode un échantillon déterministe
réparti par type de vecteur et par mois UTC d’encodage selon la référence SC.
Les dates manquantes forment un groupe. Le plafond par défaut est de 100.
Utiliser un encodeur avec un cache de
documents vierge. Si le bridge déclare un résultat issu du cache, le contrôle
s’arrête. Le cosinus minimal doit atteindre 0,995 et la médiane 0,999.
L’empreinte v3 ne permet pas d’identifier les poids d’origine ni de retrouver
toutes les entrées historiques. Les titres exclus dans la configuration
actuelle n’établissent pas les règles actives lors des encodages passés.
L’empreinte de texte SC sur 32 bits utilise l’octet faible de chaque unité
UTF-16. Une égalité d’empreinte peut donc masquer un changement de texte. Le
manifeste marque les vecteurs importés avec `sc-hash32`, conserve la marque
lors d’une réutilisation et consigne le contrôle, les effectifs et comparaisons
par groupe ainsi que les nombres de vecteurs importés et encodés par type.

Ajouter `--verify-only` pour obtenir en JSON la couverture de l’import, les
lignes à encoder et l’accord sur l’échantillon. Le rapport compare aussi les
clés des sections aux références Smart Environment admissibles, y compris
hors du corpus parcouru. Utiliser `--max-samples` avec une valeur de 20 à 500
pour fixer le plafond dans les deux modes du bootstrap. La vérification seule prend le verrou du
producteur et peut créer le dossier d’index. Il n’encode pas les autres lignes
et ne publie aucune génération.
Le décompte des lignes à encoder précède les éventuels refus pour longueur.

## Publication et reprise

- `<index>/CURRENT` contient l’identifiant de la génération active et un retour
  à la ligne.
- `<index>/generations/<id>/` contient un index Smart Environment v3 immuable.
  Le manifeste `generation.json` consigne l’identité du coffre, le modèle et son
  profil, les empreintes du corpus et des entrées, les références aux vecteurs,
  les comptes et les sommes de contrôle.
  Le lecteur externe exige au moins une note. Un corpus vide bloque la
  publication et préserve le pointeur précédent s’il existe.
- Le producteur valide la génération puis renomme un pointeur temporaire situé
  à côté de `CURRENT` pour le remplacer atomiquement. Un échec peut laisser une
  génération non publiée. Le pointeur précédent reste lisible jusqu’au
  remplacement.
  Windows peut refuser le remplacement pendant qu’un autre processus tient le
  pointeur ouvert. Fermer ce fichier puis relancer le producteur. Le lecteur
  doit refermer le pointeur dès qu’il a copié l’identifiant.
- Un changement de profil d’encodage exige `--rebuild`. Cette option réencode
  tous les vecteurs et maintient les contrôles d’identité et de cohérence. Pour
  indexer un autre coffre, choisir un autre dossier d’index.
- Un arrêt brutal peut laisser `.producer.lock`, avec le PID et l’heure de
  démarrage. Vérifier que le processus a bien pris fin et empêcher tout autre
  lancement avant de retirer le verrou. `CURRENT` reste utilisable.
- Conserver les générations active et précédente. Supprimer les générations
  plus anciennes et les restes `.staging-*` ou `.CURRENT-*` après l’arrêt des
  producteurs et la fin des lectures, y compris celles qui visent un chemin de
  génération fixe. Le producteur conserve les anciennes générations pour laisser
  ces lectures se terminer.

Pour un serveur configuré avec `SMART_ENV_DIR`, indiquer au démarrage le dossier
de la génération publiée, le coffre correspondant dans `OBSIDIAN_VAULT` et le
service d’encodage de requêtes dans `OLLAMA_BASE_URL`. Mettre à jour la
configuration du lecteur pour adopter une autre génération. Si le serveur gère
`SMART_ENV_GENERATION_POINTER`, lui donner le chemin absolu de `CURRENT` et
fixer le profil de requête correspondant avec `SMART_ENV_QUERY_FINGERPRINT`.
Conserver `OBSIDIAN_VAULT` et `OLLAMA_BASE_URL` comme indiqué ci-dessus.
