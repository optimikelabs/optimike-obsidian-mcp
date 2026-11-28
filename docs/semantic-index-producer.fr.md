# Producteur d’index sémantique autonome

Utiliser Node 22.12 ou ultérieur et un bridge BitNet qui expose son identité
d’encodage sur `GET /health`. Lancer la commande installée
`optimike-semantic-index`. Depuis le dépôt, lancer `npm run build` puis
`node scripts/semantic-index-producer.mjs`.

```text
optimike-semantic-index --vault <coffre> --index <index> --endpoint <origine-bitnet> --model <id-modèle> --revision <révision-modèle> --model-sha256 <sha256-poids-attendu>
```

Utiliser un dossier dédié à l’index, hors du coffre, sur un système de fichiers
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

Chaque note est encodée avec son fil d’Ariane, suivi de `:\n` et du Markdown.
Chaque bloc est encodé avec son fil d’Ariane parent et ses lignes d’origine,
bornes incluses. Le parseur jsbrains est épinglé. La CLI indexe les blocs non
vides hors frontmatter et plages exclues. Elle applique sa propre politique
de sélection, indépendamment des minima et de la préférence parent/enfant de
Smart Connections Desktop. En CUDA, elle appelle `/bitnet/embed-batch` par lots
de quatre au plus. Sur CPU, elle appelle `/bitnet/embed`. Les deux routes
reçoivent `purpose: document`. Un vecteur tronqué, invalide ou non normalisé en
L2 arrête la génération.

Le producteur recontrôle l’inventaire et les empreintes avant publication.
L’incrémental retrouve les vecteurs de la génération active à partir du texte
UTF-8 exact et du profil d’encodage. Un échec de lecture, un changement du
coffre ou un changement d’identité du bridge peut arrêter la publication. Le
coffre peut encore changer entre le dernier contrôle et le remplacement du
pointeur. Pour une vue à un instant précis, utiliser un instantané stable du
système de fichiers et lui dédier un dossier d’index.

## Publication et reprise

- `<index>/CURRENT` contient l’identifiant de la génération active et un retour
  à la ligne.
- `<index>/generations/<id>/` contient un index Smart Environment v3 immuable.
  Le manifeste `generation.json` consigne l’identité du coffre, le modèle et son
  profil, les empreintes du corpus et des entrées, les références aux vecteurs,
  les comptes et les sommes de contrôle.
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
configuration du lecteur pour adopter une autre génération. Un lecteur qui gère
le pointeur peut résoudre `CURRENT` une seule fois par requête et tenir compte de
la génération dans toutes ses lectures et clés de cache.
