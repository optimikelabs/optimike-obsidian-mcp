# Import volontaire d’images — Contrat candidat V1

Cette famille importe une image choisie depuis un fichier déjà présent sur le serveur MCP. Elle ne télécharge pas automatiquement les images référencées, ne publie rien et ne modifie pas une note.

## Choix de l’utilisateur

Référencer, afficher ou lire une image distante ne vaut pas autorisation de l’importer. Réutiliser une image locale ne doit ni la dupliquer ni la recomprimer. L’import résulte d’une demande explicite ou d’une politique de workflow délibérément autorisée. Aucun comportement particulier de clipping, aspiration, migration de masse, écrasement ou nettoyage automatique n’est ajouté.

## Configuration et accès

L’opérateur choisit un dossier existant avec `MCP_ASSET_FOLDER`, configure `OBSIDIAN_VAULT`, puis autorise les écritures avec `MCP_ASSET_IMPORT_ENABLED=true` et `MCP_WRITE_MODE=full`. Activer l’import sans racine de coffre ou sans dossier d’assets est une erreur de configuration. Le dossier peut être `X/Images`, sans que cette convention soit imposée par le serveur générique. Aucun dossier n’est créé implicitement. `MCP_ASSET_WEBP_QUALITY` vaut 75 par défaut, entre 1 et 100. Aucun réglage du plugin Image Converter n’est modifié.

La source est un fichier serveur dans une ExternalRoot autorisant `readable` et `handoff`, sous ses filtres et limites existants. En HTTP, les trois opérations, y compris la consultation d’un reçu, exigent une identité non-développement avec le scope `external:read`. Le chemin d’un fichier attaché à ChatGPT n’est pas un chemin serveur.

Les outils `asset_import_plan`, `asset_import_apply` et `asset_import_status` forment une famille facultative complète du profil `full` en runtime live/hybrid-live. La surface par défaut reste à 87 outils live ; le catalogue transversal contient 94 noms, dont trois conditionnels. Les hypothèses de disponibilité sont déclarées dans le catalogue.

## Effets et preuves

Le plan reçoit `source: {rootId, relativePath, sha256}`, `name` et `idempotencyKey`. Il vérifie l’original, le décode, applique la conversion et fige les octets dans le journal privé existant. Il ne crée ni image dans le coffre ni lien dans une note. Les URL, base64 fournis au modèle, chemins absolus arbitraires et arguments non déclarés sont refusés. Préserver l’original requiert `preserveOriginal: true` et une justification `exceptionReason`.

L’application reprend uniquement le plan scellé et sa clé, revérifie les permissions et crée le fichier sans écraser un existant. Le reçu ne fournit un embed utilisable qu’après vérification. Son insertion dans une note passe ensuite par une opération gouvernée distincte : aucune atomicité image + note n’est promise.

Après réponse perdue ou interruption, consulter le statut sans réimporter. Le statut ne crée, convertit, remplace ni supprime rien. Des octets identiques prouvent l’état observé, pas l’auteur de la création ni l’indexation Obsidian. Une dérive ultérieure retire l’embed utilisable. Le cockpit existant projette les opérations en attente ; aucune reprise générique n’est inventée.

## Limites

Sources : 8 MiB ; résultat : 2 MiB ; décodage : 16 777 216 pixels cumulés sur 32 frames maximum. Deux workers et deux préparations simultanées au plus ; 32 imports en attente dans le journal. Le délai, les octets et le décodage sont bornés. Un processus séparé n’est pas une sandbox de sécurité du système d’exploitation.

WebP sans redimensionnement par défaut, orientation EXIF appliquée, transparence conservée. SVG inerte borné et animations prises en charge sont préservés sans modification des octets. Les références SVG externes et le contenu actif sont refusés. APNG et séquences AVIF non qualifiées sont refusés plutôt qu’aplatis silencieusement.

La création native est limitée à Windows x64 sur disque local fixe NTFS, avec parents maintenus ouverts et identités vérifiées. Reparse points, chemins réseau et liens inattendus sont refusés. Pas de repli vers une écriture générique par chemin.

Un échec après création peut laisser un fichier partiel. Le reçu reste incertain ; le fichier n’est ni supprimé automatiquement ni écrasé à la tentative suivante. Ce comportement conservateur ne constitue pas un rollback. L’opérateur peut ensuite décider d’un traitement distinct explicitement autorisé.

## Qualification

`npm run test:assets` couvre des fixtures isolées et des appels SDK MCP en mémoire jusqu’à la création native. Le transport réel d’une pièce jointe ChatGPT vers le serveur, HTTP de bout en bout, TLS et l’indexation Desktop restent `NOT_RUN`. Les tests ne modifient pas le coffre installé. La CI et la revue doivent porter sur le SHA exact ; aucune installation, fusion ou mise en production n’est implicite.

Contrat technique détaillé : [asset-import.md](asset-import.md).
