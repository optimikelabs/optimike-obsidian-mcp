# Inventaire OpenAPI facultatif des Bridges

Les trois Bridges utilisent les types publics du package npm Local REST 5.3.0, observ? comme publi? le 28 septembre. Ce num?ro ne certifie pas le plugin install?. Aucun bundle Local REST n'est embarqu? ? l'ex?cution.

L'observateur conserve les chemins et m?thodes authentifi?s dont le montage a r?ussi. Les handlers, arguments, receivers, cha?nages et nettoyages natifs restent inchang?s. Aucun outil MCP ni deuxi?me chemin de mutation n'est ajout?. Le superviseur de lifecycle garde son r?le.

L'API d'extension v3 permet une contribution OpenAPI par Bridge. Un host ancien ou une publication facultative en ?chec ne d?sactive pas les routes. Le diagnostic console se limite ? published, unsupported ou failed, sans message priv?.

## Limite explicite

La couverture route-and-method-only ne pr?tend pas d?crire les sch?mas complets de requ?te/r?ponse. Les contrats versionn?s et le capability doctor restent n?cessaires avant une mutation. Le pattern Express original explicite les param?tres Bases multi-segments. Aucun exemple priv?, secret ou chemin physique n'est publi?.

## V?rification

npm run test:bridge-openapi v?rifie la publication, ses erreurs et le montage des vrais entrypoints sur des providers contr?l?s. L'inventaire correspond aux routes enregistr?es ; elles restent identiques avec un host ancien, actuel ou en collision. Ces fixtures ne remplacent pas le gate Desktop dans un coffre jetable attest? : OpenAPI fusionn?e, disable/re-enable, nettoyage et grants inchang?s.
