# Hub documentaire

English version: [README.md](README.md)

![Carte de la documentation Optimike Obsidian MCP selon le besoin du lecteur](assets/readme/documentation-hub.fr.svg)

Cette page route chaque lecteur vers un document faisant autorité pour sa
question.

## Commencer selon son rôle

| Je suis…                        | Commencer ici                                             | Puis utiliser                                                                                                                          |
| ------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Nouvel utilisateur local        | [Présentation](../README.fr.md)                           | [Exploitation](../OPERATIONS.fr.md)                                                                                                    |
| Opérateur Codex ou agent local  | [Exploitation](../OPERATIONS.fr.md)                       | [Routage agentique](mcp-routing-guide.fr.md)                                                                                           |
| Opérateur headless/serveur      | [Profil serveur headless](headless-server-profile.fr.md)  | [Matrice runtime](runtime-capability-matrix.fr.md), [Sécurité](../SECURITY.fr.md)                                                      |
| Intégrateur d’une gateway       | [Compatibilité gateways OSS](gateway-compatibility.fr.md) | [Sécurité HTTP](http-multiclient-security.fr.md), [Backpressure](http-concurrency-backpressure.fr.md)                                  |
| Intégrateur d’un client MCP     | [Surface des outils](obsidian_mcp_tools_spec.md)          | [Matrice runtime](runtime-capability-matrix.fr.md)                                                                                     |
| Opérateur de documents externes | [Configuration des racines](external-roots-setup.fr.md)   | [ADR racines externes](adr/ADR-External-Document-Roots.md), [ADR intégrité des références](adr/ADR-External-Reference-Integrity.fr.md) |
| Opérateur Tasks/Operon          | [Contrat MCP Operon](operon-mcp-contract.md)              | [Validation locale](operon-local-validation.md), [profil public ÉLYSIA](../profiles/elysia-tasks/README.fr.md)                         |
| Contributeur ou relecteur       | [Décisions d’architecture](adr/README.md)                 | [Arbre du dépôt](tree.md), README des plugins                                                                                          |

## Trouver la page qui fait foi

| Question                                                                      | Autorité                                                                                |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Quels outils existent ?                                                       | [Surface des outils](obsidian_mcp_tools_spec.md)                                        |
| Quels outils sont disponibles dans chaque runtime ?                           | [Matrice des capacités](runtime-capability-matrix.fr.md)                                |
| Comment lancer et maintenir le service ?                                      | [Exploitation](../OPERATIONS.fr.md)                                                     |
| Quelle surface un agent doit-il utiliser ?                                    | [Guide de routage](mcp-routing-guide.fr.md)                                             |
| Comment fonctionner sans Obsidian Desktop ?                                   | [Profil serveur headless](headless-server-profile.fr.md)                                |
| Comment fonctionnent lecture, handoff, move et réparation de liens externes ? | [Configuration des racines](external-roots-setup.fr.md)                                 |
| Quelle frontière de sécurité HTTP est supportée ?                             | [Sécurité](../SECURITY.fr.md) et [ADR HTTP](adr/ADR-HTTP-External-Artifact-Delivery.md) |
| Quel profil de gateway OSS a été prouvé de bout en bout ?                     | [Compatibilité gateways OSS](gateway-compatibility.fr.md)                               |
| Comment les lectures et mutations Operon sont-elles gouvernées ?              | [Contrat MCP Operon](operon-mcp-contract.md)                                            |
| Pourquoi une décision d’architecture a-t-elle été prise ?                     | [Index des ADR](adr/README.md)                                                          |
| Qu’est-ce qui a changé ?                                                      | [Changelog](../CHANGELOG.md)                                                            |

## Familles de capacités

### Coffre et structures Obsidian

- notes, métadonnées et tags : [Surface des outils](obsidian_mcp_tools_spec.md#core-notes) ;
- Bases : [Surface des outils](obsidian_mcp_tools_spec.md#bases) ;
- Canvas et validation : [Surface des outils](obsidian_mcp_tools_spec.md#canvas-and-format-validation).

### Tâches et exécution

- lectures compatibles Tasks : [Surface des outils](obsidian_mcp_tools_spec.md#tasks) ;
- contrat Operon gouverné : [Contrat MCP Operon](operon-mcp-contract.md) ;
- bridge Operon inclus : [README Operon Bridge](../plugins/obsidian-operon-bridge/README.md) ;
- bridge Bases inclus : [README Bases Bridge](../plugins/obsidian-bases-bridge/README.md).

### Recherche et runtime

- recherche sémantique et providers : [Exploitation](../OPERATIONS.fr.md) ;
- modes runtime : [Matrice des capacités](runtime-capability-matrix.fr.md) ;
- cache, santé et maintenance : [Exploitation](../OPERATIONS.fr.md).

### Documents externes

- configuration et parcours clients : [Configuration des racines](external-roots-setup.fr.md) ;
- routage agentique : [Guide de routage](mcp-routing-guide.fr.md#routage-des-documents-externes) ;
- frontière de livraison HTTP : [ADR HTTP](adr/ADR-HTTP-External-Artifact-Delivery.md) ;
- move local, réparation exacte des liens et rollback :
  [ADR intégrité des références](adr/ADR-External-Reference-Integrity.fr.md).

## Propriété documentaire

- Les README présentent le produit, les profils et le premier démarrage réussi.
- Les guides d’exploitation portent le runtime local et le dépannage.
- La surface des outils porte les noms et la sémantique des outils.
- La matrice runtime porte leur disponibilité par mode.
- Les guides de configuration portent les exemples.
- Les ADR portent décisions, statuts, frontières et options rejetées.
- Le changelog porte les versions et changements non publiés.

Ne pas recopier limites, variables d’environnement ou registres d’outils dans
plusieurs pages lorsqu’un lien vers l’autorité suffit.
