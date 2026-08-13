# Hub documentaire

English version: [README.md](README.md)

![Carte de la documentation Optimike Obsidian MCP selon le besoin du lecteur](assets/readme/documentation-hub.fr.svg)

Cette page route chaque lecteur vers l’autorité utile sans recopier les contrats.

## Entrées principales

| Besoin | Autorité |
| --- | --- |
| Découvrir le produit | [Présentation](../README.fr.md) |
| Lancer et maintenir le service | [Exploitation](../OPERATIONS.fr.md) |
| Connaître les outils | [Surface des outils](obsidian_mcp_tools_spec.md) |
| Vérifier la disponibilité par mode | [Matrice runtime](runtime-capability-matrix.fr.md) |
| Comprendre le remplacement atomique gouverné | [Contrat dédié](governed-note-replacement.fr.md) |
| Router un agent | [Guide de routage](mcp-routing-guide.fr.md) |
| Déployer en headless | [Profil serveur](headless-server-profile.fr.md) |
| Vérifier la frontière de sécurité | [Sécurité](../SECURITY.fr.md) |
| Configurer les documents externes | [Racines externes](external-roots-setup.fr.md) |
| Exploiter Operon | [Contrat MCP Operon](operon-mcp-contract.fr.md) |
| Comprendre MCP versus CLI | [Audit CLI / API](operon-cli-audit.fr.md) |
| Revoir les décisions | [Index des ADR](adr/README.md) |
| Lire l’historique | [Changelog](../CHANGELOG.md) |

## Familles de capacités

### Coffre Obsidian

- notes, métadonnées et tags : [surface des outils](obsidian_mcp_tools_spec.md#core-notes) ;
- remplacement atomique gouverné : [contrat dédié](governed-note-replacement.fr.md) ;
- Bases : [surface des outils](obsidian_mcp_tools_spec.md#bases) ;
- Canvas et validation : [surface des outils](obsidian_mcp_tools_spec.md#canvas-and-format-validation).

### Tâches et exécution

- lectures Tasks : [surface des outils](obsidian_mcp_tools_spec.md#tasks) ;
- mutations Operon gouvernées : [contrat Operon](operon-mcp-contract.fr.md) ;
- limites de la CLI et de la Developer API : [audit](operon-cli-audit.fr.md) ;
- bridge Atomic Write : [README du plugin](../plugins/obsidian-atomic-write-bridge/README.md).

### Runtime et recherche

- modes et disponibilité : [matrice runtime](runtime-capability-matrix.fr.md) ;
- cache, santé, maintenance et recherche sémantique : [exploitation](../OPERATIONS.fr.md) ;
- déploiement et menaces : [sécurité](../SECURITY.fr.md).

### Documents externes

- configuration : [racines externes](external-roots-setup.fr.md) ;
- routage : [guide MCP](mcp-routing-guide.fr.md#routage-des-documents-externes) ;
- move local et réparation exacte : [ADR d’intégrité](adr/ADR-External-Reference-Integrity.fr.md) ;
- livraison HTTP : [ADR HTTP](adr/ADR-HTTP-External-Artifact-Delivery.md).

## Propriété documentaire

- Les README présentent le produit et le premier démarrage.
- Les guides d’exploitation portent les commandes et le dépannage.
- La surface des outils porte les noms et la sémantique.
- La matrice porte la disponibilité par mode.
- Les ADR portent décisions, frontières et options rejetées.
- Le changelog porte les versions et changements non publiés.
