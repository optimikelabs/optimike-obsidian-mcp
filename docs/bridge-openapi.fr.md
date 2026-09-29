# Inventaire OpenAPI facultatif des Bridges

Les trois Bridges utilisent les types publics du package npm Local REST 5.3.0, observé comme publié le 28 septembre. Ce numéro ne certifie pas le plugin installé. Aucun bundle Local REST n'est embarqué à l'exécution.

L'observateur conserve les chemins et méthodes authentifiés dont le montage a réussi. Les handlers, arguments, receivers, chaînages et nettoyages natifs restent inchangés. Aucun outil MCP ni deuxième chemin de mutation n'est ajouté. Le superviseur de lifecycle garde son rôle.

L'API d'extension v3 permet une contribution OpenAPI par Bridge. Un host ancien ou une publication facultative en échec ne désactive pas les routes. Le diagnostic console se limite à published, unsupported ou failed, sans message privé.

## Limite explicite

La couverture route-and-method-only ne prétend pas décrire les schémas complets de requête/réponse. Les contrats versionnés et le capability doctor restent nécessaires avant une mutation. Le pattern Express original explicite les paramètres Bases multi-segments. Aucun exemple privé, secret ou chemin physique n'est publié.

## Vérification

npm run test:bridge-openapi vérifie la publication, ses erreurs et le montage des vrais entrypoints sur des providers contrôlés. L'inventaire correspond aux routes enregistrées ; elles restent identiques avec un host ancien, actuel ou en collision. Ces fixtures ne remplacent pas le gate Desktop dans un coffre jetable attesté : OpenAPI fusionnée, disable/re-enable, nettoyage et grants inchangés.
