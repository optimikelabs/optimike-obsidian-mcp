# Import volontaire d’images — Contrat candidat V2

Cette famille importe une image choisie explicitement. La source peut être un fichier déjà présent sur le serveur MCP dans une ExternalRoot autorisée ou, lorsque l’option est activée, un fichier fourni par l’hôte ChatGPT via le contrat MCP. Elle ne télécharge pas automatiquement les images simplement référencées, ne publie rien et ne modifie pas une note.

## Choix de l’utilisateur

Référencer, afficher ou lire une image distante ne vaut pas autorisation de l’importer. Réutiliser une image locale ne doit ni la dupliquer ni la recomprimer. L’import résulte d’une demande explicite ou d’une politique de workflow délibérément autorisée. Aucun comportement particulier de clipping, aspiration, migration de masse, écrasement ou nettoyage automatique n’est ajouté.

## Configuration et accès

L’opérateur choisit un dossier existant avec `MCP_ASSET_FOLDER`, configure `OBSIDIAN_VAULT`, puis autorise les écritures avec `MCP_ASSET_IMPORT_ENABLED=true` et `MCP_WRITE_MODE=full`. Au moins une voie d’entrée doit être configurée : `MCP_EXTERNAL_ROOTS_FILE` pour les fichiers serveur déjà présents ou `MCP_ASSET_CHATGPT_FILE_INGRESS_ENABLED=true` pour les paramètres fichier fournis par ChatGPT. Cette seconde voie exige aussi `MCP_ASSET_CHATGPT_FILE_HOSTS`, une allowlist séparée par virgules ou retours à la ligne de noms DNS exacts observés et approuvés pendant la qualification de l’hôte ; les URL complètes, formes IP littérales ou numériques canonisées par l’analyseur d’URL, et wildcards sont refusées. Le dossier peut être `X/Images`, sans que cette convention soit imposée par le serveur générique. Aucun dossier n’est créé implicitement. `MCP_ASSET_WEBP_QUALITY` vaut 75 par défaut, entre 1 et 100. Aucun réglage du plugin Image Converter n’est modifié.

`obsidian_runtime_status` expose avant tout plan une projection `assetPolicy` expurgée : dossier cible relatif au coffre, existence du dossier, conversion, voies d’entrée actives, nombre de hosts ChatGPT autorisés (jamais leurs valeurs) et relation avec le `attachmentFolderPath` observé dans `.obsidian/app.json`. Un dossier fixe configuré par Obsidian peut être proposé comme suggestion, mais il ne remplace jamais silencieusement `MCP_ASSET_FOLDER` et n’est jamais créé automatiquement. Les politiques « racine du coffre » ou « relatif à la note » sont signalées comme telles. Un dossier de configuration Obsidian personnalisé n’est pas deviné et apparaît donc comme indisponible tant qu’il n’est pas pris en charge explicitement.

Une source ExternalRoot reste soumise à `readable` + `handoff`, à ses filtres et à ses limites. En HTTP, les trois opérations, y compris la consultation d’un reçu, exigent une identité non-développement avec le scope `external:read`. Le chemin local d’un fichier attaché à ChatGPT n’est jamais traité comme un chemin serveur.

Les outils `asset_import_plan`, `asset_import_apply` et `asset_import_status` forment une famille facultative complète du profil `full` en runtime live/hybrid-live. La surface par défaut reste à 87 outils live ; le catalogue transversal contient 94 noms, dont trois conditionnels. Les hypothèses de disponibilité sont déclarées dans le catalogue.

## Effets et preuves

Le plan reçoit exactement une source, plus `name` et `idempotencyKey`. La claim d’idempotence en cours lie aussi le type et l’identité de la source : un fichier ChatGPT et une ExternalRoot ne peuvent pas courir sous la même clé publique ; le second mode de source contradictoire est refusé avant téléchargement hôte ou lecture ExternalRoot. Le parcours historique utilise `source: {rootId, relativePath, sha256}`. Le parcours ChatGPT utilise `file: {download_url, file_id, mime_type (facultatif), file_name (facultatif)}`, champ annoncé à l’hôte avec `_meta["openai/fileParams"] = ["file"]`. Cet objet doit être fourni par l’hôte ; une URL arbitraire passée comme simple argument n’est pas une alternative. Le serveur accepte l’URL HTTPS temporaire uniquement si son hostname exact figure dans `MCP_ASSET_CHATGPT_FILE_HOSTS`, sans redirection libre, avec délai et limite de 8 MiB ; les IP littérales sont refusées et la résolution DNS doit rester entièrement hors réseaux privés, loopback, link-local ou site-local. Aucun fichier de staging n’est créé et l’URL temporaire n’est pas conservée dans le journal : seule une identité synthétique `file_id` + hash et les octets convertis figés sont durables. Le plan ne crée ni image dans le coffre ni lien dans une note. Les base64 fournis au modèle et chemins absolus arbitraires restent refusés. Préserver l’original requiert `preserveOriginal: true` et une justification `exceptionReason`.

L’application reprend uniquement le plan scellé et sa clé, revérifie les permissions et crée le fichier sans écraser un existant. Le reçu ne fournit un embed utilisable qu’après vérification. Son insertion dans une note passe ensuite par une opération gouvernée distincte : aucune atomicité image + note n’est promise.

Après réponse perdue ou interruption, consulter le statut sans réimporter. Le statut ne crée, convertit, remplace ni supprime rien. Des octets identiques prouvent l’état observé, pas l’auteur de la création ni l’indexation Obsidian. Une dérive ultérieure retire l’embed utilisable. Le cockpit existant projette les opérations en attente ; aucune reprise générique n’est inventée.

## Limites

Sources : 8 MiB ; résultat : 2 MiB ; décodage : 16 777 216 pixels cumulés sur 32 frames maximum. Deux workers et deux préparations simultanées au plus ; pour un fichier hôte ChatGPT, le slot de préparation est réservé avant tout téléchargement HTTPS, donc un plan excédentaire refusé ne met aucun octet source en mémoire. Les appels portant la même clé partagent le slot déjà réservé. Le journal admet 32 imports en attente. Le délai, les octets et le décodage sont bornés. Un processus séparé n’est pas une sandbox de sécurité du système d’exploitation.

WebP sans redimensionnement par défaut, orientation EXIF appliquée, transparence conservée. SVG inerte borné et animations prises en charge sont préservés sans modification des octets. Les références SVG externes et le contenu actif sont refusés. APNG et séquences AVIF non qualifiées sont refusés plutôt qu’aplatis silencieusement.

La création native est limitée à Windows x64 sur disque local fixe NTFS, avec parents maintenus ouverts et identités vérifiées. Reparse points, chemins réseau et liens inattendus sont refusés. Pas de repli vers une écriture générique par chemin.

Un échec après création peut laisser un fichier partiel. Le reçu reste incertain ; le fichier n’est ni supprimé automatiquement ni écrasé à la tentative suivante. Ce comportement conservateur ne constitue pas un rollback. L’opérateur peut ensuite décider d’un traitement distinct explicitement autorisé.

## Qualification

`npm run test:assets` couvre des fixtures isolées, la découverte de destination, le schéma fichier ChatGPT et des appels SDK MCP jusqu’à la création native. Les fixtures fichier hôte prouvent un seul téléchargement pendant le plan puis le même cycle `plan → apply → status`, sans retéléchargement, le rejet d’un host non autorisé avant réseau, une provenance synthétique non-collidable, la compatibilité Node 24 avec `lookup(..., {all:true})` tout en validant toutes les adresses résolues, la coalescence entre deux serveurs MCP partageant le même runtime asset, la réservation de la capacité de deux plans avant téléchargement et une claim d’idempotence commune aux modes fichier ChatGPT et ExternalRoot. Un troisième plan distinct ou une clé contradictoire mixed-source est refusé avant réseau ou lecture source. Le test réel d’une pièce jointe ChatGPT contre le connecteur déployé, ses hôtes temporaires de téléchargement, TLS et l’indexation Desktop restent `NOT_RUN`. Les tests ne modifient pas le coffre installé. La CI et la revue doivent porter sur le SHA exact ; aucune installation, fusion ou mise en production n’est implicite.

Contrat technique détaillé : [asset-import.md](asset-import.md).
