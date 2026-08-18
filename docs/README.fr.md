# Hub de documentation

English version: [README.md](README.md)

![Carte de la documentation Optimike Obsidian MCP par besoin](assets/readme/documentation-hub.fr.svg)

Cette page renvoie chaque question vers son document d’autorité. Optimike MCP 3.0 sépare les capacités du runtime de la surface d’outils exposée à une session cliente.

## Commencer selon son rôle

| Je suis… | Commencer ici | Puis utiliser |
| --- | --- | --- |
| Nouvel utilisateur local | [Vue produit](../README.fr.md) | [Profils de surface](tool-surface-profiles.fr.md), [Opérations](../OPERATIONS.fr.md) |
| Opérateur Codex ou agent local | [Profils de surface](tool-surface-profiles.fr.md) | [Routage agent](mcp-routing-guide.fr.md), [Opérations](../OPERATIONS.fr.md) |
| Opérateur headless/serveur | [Profil serveur headless](headless-server-profile.fr.md) | [Matrice runtime](runtime-capability-matrix.fr.md), [Sécurité](../SECURITY.fr.md) |
| Intégrateur gateway | [Compatibilité gateway OSS](gateway-compatibility.fr.md) | [Sécurité HTTP](http-multiclient-security.fr.md), [Backpressure](http-concurrency-backpressure.fr.md) |
| Intégrateur client MCP | [Profils de surface](tool-surface-profiles.fr.md) | [Registre des outils](obsidian_mcp_tools_spec.md), [Matrice runtime](runtime-capability-matrix.fr.md) |
| Opérateur de documents externes | [Configuration External Roots](external-roots-setup.fr.md) | [ADR External Roots](adr/ADR-External-Document-Roots.md), [ADR intégrité](adr/ADR-External-Reference-Integrity.fr.md) |
| Opérateur Tasks/Operon | [Contrat Operon MCP](operon-mcp-contract.fr.md) | [Audit CLI/API](operon-cli-audit.fr.md), [Validation locale](operon-local-validation.md), [profil ÉLYSIA public](../profiles/elysia-tasks/README.fr.md) |
| Contributeur ou reviewer | [Décisions d’architecture](adr/README.md) | [ADR surface V3](adr/ADR-Tool-Surface-Profiles-V3.md), [Arbre du dépôt](tree.md) |

## Trouver la page d’autorité

| Question | Autorité |
| --- | --- |
| Quel profil choisir pour ce client ? | [Profils de surface](tool-surface-profiles.fr.md) |
| Quels noms d’outils publics existent en 3.0 ? | [Tool Surface](obsidian_mcp_tools_spec.md) |
| Quels outils ce runtime peut-il enregistrer ? | [Matrice des capacités](runtime-capability-matrix.fr.md) |
| Comment exécuter et maintenir le service ? | [Opérations](../OPERATIONS.fr.md) |
| Quelle famille d’outils possède une intention ? | [Guide de routage](mcp-routing-guide.fr.md) |
| Comment fonctionner sans Obsidian Desktop ? | [Profil serveur headless](headless-server-profile.fr.md) |
| Comment fonctionnent lecture, handoff, move et réparation de liens externes ? | [Configuration External Roots](external-roots-setup.fr.md) |
| Quelle est la frontière de sécurité HTTP ? | [Sécurité](../SECURITY.fr.md) et [ADR HTTP](adr/ADR-HTTP-External-Artifact-Delivery.md) |
| Comment une session est-elle liée à un profil ? | [ADR surface V3](adr/ADR-Tool-Surface-Profiles-V3.md) |
| Quel profil gateway OSS a été prouvé de bout en bout ? | [Compatibilité gateway OSS](gateway-compatibility.fr.md) |
| Comment les lectures et mutations Operon sont-elles gouvernées ? | [Contrat Operon MCP](operon-mcp-contract.fr.md) |
| Comment fonctionne le remplacement atomique d’une note ? | [Remplacement gouverné](governed-note-replacement.fr.md) |
| Comment gouverner des changements Frontmatter préservant la source ? | [Frontmatter P1](governed-frontmatter-p1.fr.md) |
| Comment modifier des formules Bases en sécurité ? | [Formules Bases P2](governed-base-formula-p2.fr.md) |
| Comment modifier un graphe JSON Canvas existant ? | [Canvas P3](governed-canvas-p3.fr.md) |
| Pourquoi exposer Operon plutôt qu’un passthrough CLI ? | [Audit CLI / Developer API](operon-cli-audit.fr.md) |
| Qu’est-ce qui a changé ? | [Changelog](../CHANGELOG.md) |

## Contrat public 3.0

- Les profils sont choisis avant `tools/list` : `standard`, `authoring`, `tasks`, `full`.
- Le stdio direct accepte `--tool-profile` ou `MCP_TOOL_PROFILE`.
- HTTP utilise `/mcp/{profile}` ; `/mcp` est l’alias de compatibilité de `/mcp/full`.
- Une session ne peut pas changer de profil.
- Un outil masqué n’est pas appelable.
- Les familles gouvernées sont exposées atomiquement.
- La recherche sémantique utilise uniquement `smart_semantic_search` ; les deux anciens alias ont été supprimés.

## Familles de capacités

### Coffre et structure Obsidian

- lectures et recherche sémantique : [Tool Surface](obsidian_mcp_tools_spec.md#core-vault-and-search) ;
- Notes directes et gouvernées : [Tool Surface](obsidian_mcp_tools_spec.md#direct-note-operations) ;
- Frontmatter et tags : [Tool Surface](obsidian_mcp_tools_spec.md#frontmatter-and-tags) ;
- Bases : [Tool Surface](obsidian_mcp_tools_spec.md#bases) ;
- Canvas : [Tool Surface](obsidian_mcp_tools_spec.md#canvas).

### Tâches et exécution

- lectures Tasks-compatible : [Tool Surface](obsidian_mcp_tools_spec.md#tasks-compatible-markdown) ;
- contrat Operon gouverné : [Contrat Operon MCP](operon-mcp-contract.fr.md) ;
- frontière MCP/CLI : [Audit CLI / Developer API](operon-cli-audit.fr.md) ;
- implémentation du Bridge : [README Operon Bridge](../plugins/obsidian-operon-bridge/README.md).

### Runtime et transport

- sélection de profil : [Profils de surface](tool-surface-profiles.fr.md) ;
- modes de runtime : [Matrice runtime](runtime-capability-matrix.fr.md) ;
- cache, santé et maintenance : [Opérations](../OPERATIONS.fr.md) ;
- HTTP multiclient : [Sécurité HTTP](http-multiclient-security.fr.md) et [ADR surface V3](adr/ADR-Tool-Surface-Profiles-V3.md).

### Documents externes

- configuration et workflows : [External Roots](external-roots-setup.fr.md) ;
- routage sémantique : [Guide de routage](mcp-routing-guide.fr.md#documents-externes) ;
- livraison HTTP : [ADR HTTP](adr/ADR-HTTP-External-Artifact-Delivery.md) ;
- move local, réparation et rollback : [ADR intégrité](adr/ADR-External-Reference-Integrity.fr.md).

## Propriété documentaire

- Les README expliquent le produit et le premier démarrage réussi.
- Les profils de surface possèdent les contrats de découverte/session.
- Les guides d’opérations possèdent la configuration runtime et le dépannage.
- Tool Surface possède les noms publics et leur sémantique concise.
- La matrice runtime possède la disponibilité structurelle par mode.
- Les contrats de domaine possèdent les garanties des mutations gouvernées.
- Les ADR possèdent décisions, frontières et alternatives rejetées.
- Le changelog possède les releases et migrations.

Ne pas dupliquer listes d’outils, limites ou contrats de variables d’environnement lorsqu’un lien vers la page d’autorité suffit.
