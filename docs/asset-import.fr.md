# Import volontaire d?images ? Contrat candidat V1

Cette famille importe une image choisie depuis un fichier d?j? pr?sent sur le serveur MCP. Elle ne t?l?charge pas automatiquement les images r?f?renc?es, ne publie rien et ne modifie pas une note.

## Choix de l?utilisateur

R?f?rencer, afficher ou lire une image distante ne vaut pas autorisation de l?importer. R?utiliser une image locale ne doit ni la dupliquer ni la recomprimer. L?import r?sulte d?une demande explicite ou d?une politique de workflow d?lib?r?ment autoris?e. Aucun comportement particulier de clipping, aspiration, migration de masse, ?crasement ou nettoyage automatique n?est ajout?.

## Configuration et acc?s

L?op?rateur choisit un dossier existant avec `MCP_ASSET_FOLDER`, puis autorise les ?critures avec `MCP_ASSET_IMPORT_ENABLED=true` et `MCP_WRITE_MODE=full`. Le dossier peut ?tre `X/Images`, sans que cette convention soit impos?e par le serveur g?n?rique. Aucun dossier n?est cr?? implicitement. `MCP_ASSET_WEBP_QUALITY` vaut 75 par d?faut, entre 1 et 100. Aucun r?glage du plugin Image Converter n?est modifi?.

La source est un fichier serveur dans une ExternalRoot autorisant `readable` et `handoff`, sous ses filtres et limites existants. En HTTP, les trois op?rations, y compris la consultation d?un re?u, exigent une identit? non-d?veloppement avec le scope `external:read`. Le chemin d?un fichier attach? ? ChatGPT n?est pas un chemin serveur.

Les outils `asset_import_plan`, `asset_import_apply` et `asset_import_status` forment une famille facultative compl?te du profil `full` en runtime live/hybrid-live. La surface par d?faut reste ? 87 outils live ; le catalogue transversal contient 94 noms, dont trois conditionnels. Les hypoth?ses de disponibilit? sont d?clar?es dans le catalogue.

## Effets et preuves

Le plan re?oit `source: {rootId, relativePath, sha256}`, `name` et `idempotencyKey`. Il v?rifie l?original, le d?code, applique la conversion et fige les octets dans le journal priv? existant. Il ne cr?e ni image dans le coffre ni lien dans une note. Les URL, base64 fournis au mod?le, chemins absolus arbitraires et arguments non d?clar?s sont refus?s. Pr?server l?original requiert `preserveOriginal: true` et une justification `exceptionReason`.

L?application reprend uniquement le plan scell? et sa cl?, rev?rifie les permissions et cr?e le fichier sans ?craser un existant. Le re?u ne fournit un embed utilisable qu?apr?s v?rification. Son insertion dans une note passe ensuite par une op?ration gouvern?e distincte : aucune atomicit? image + note n?est promise.

Apr?s r?ponse perdue ou interruption, consulter le statut sans r?importer. Le statut ne cr?e, convertit, remplace ni supprime rien. Des octets identiques prouvent l??tat observ?, pas l?auteur de la cr?ation ni l?indexation Obsidian. Une d?rive ult?rieure retire l?embed utilisable. Le cockpit existant projette les op?rations en attente ; aucune reprise g?n?rique n?est invent?e.

## Limites

Sources : 8 MiB ; r?sultat : 2 MiB ; d?codage : 16 777 216 pixels cumul?s sur 32 frames maximum. Deux workers et deux pr?parations simultan?es au plus ; 32 imports en attente dans le journal. Le d?lai, les octets et le d?codage sont born?s. Un processus s?par? n?est pas une sandbox de s?curit? du syst?me d?exploitation.

WebP sans redimensionnement par d?faut, orientation EXIF appliqu?e, transparence conserv?e. SVG inerte born? et animations prises en charge sont pr?serv?s sans modification des octets. Les r?f?rences SVG externes et le contenu actif sont refus?s. APNG et s?quences AVIF non qualifi?es sont refus?s plut?t qu?aplatis silencieusement.

La cr?ation native est limit?e ? Windows x64 sur disque local fixe NTFS, avec parents maintenus ouverts et identit?s v?rifi?es. Reparse points, chemins r?seau et liens inattendus sont refus?s. Pas de repli vers une ?criture g?n?rique par chemin.

Un ?chec apr?s cr?ation peut laisser un fichier partiel. Le re?u reste incertain ; le fichier n?est ni supprim? automatiquement ni ?cras? ? la tentative suivante. Ce comportement conservateur ne constitue pas un rollback. L?op?rateur peut ensuite d?cider d?un traitement distinct explicitement autoris?.

## Qualification

`npm run test:assets` couvre des fixtures isol?es et des appels SDK MCP en m?moire jusqu?? la cr?ation native. Le transport r?el d?une pi?ce jointe ChatGPT vers le serveur, HTTP de bout en bout, TLS et l?indexation Desktop restent `NOT_RUN`. Les tests ne modifient pas le coffre install?. La CI et la revue doivent porter sur le SHA exact ; aucune installation, fusion ou mise en production n?est implicite.

Contrat technique d?taill? : [asset-import.md](asset-import.md).
