# Guide de routage MCP

Version anglaise : [mcp-routing-guide.md](mcp-routing-guide.md)

Docs liées : [README](../README.fr.md),
[Guide d’exploitation](../OPERATIONS.fr.md),
[Matrice des capacités runtime](runtime-capability-matrix.fr.md),
[Profil serveur headless](headless-server-profile.fr.md) et
[Racines documentaires externes](external-roots-setup.fr.md)

Ce guide aide les agents à choisir la bonne couche pour travailler avec Obsidian.

## Décision par défaut

| Besoin                                                                     | Utiliser                                                        | Pourquoi                                                                          |
| -------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Lire, lister, rechercher, Tasks, recherche sémantique                      | Optimike MCP                                                    | Surface stable entre live, hybrid et headless.                                    |
| Lire un document explicitement configuré hors du coffre                    | Outils external-roots du MCP                                    | Confinement default-deny avec chemins logiques portables.                         |
| Comportement Obsidian complet, commandes, active file, Bases via plugin    | Optimike MCP en `live` ou `hybrid` avec Obsidian Desktop ouvert | C'est le seul mode avec sémantique Desktop/plugin.                                |
| Serveur backend sûr au-dessus d'un vault synchronisé                       | Optimike MCP en `headless-readonly` d'abord                     | Pas besoin de Desktop et aucun risque d'écriture.                                 |
| Écritures Markdown/frontmatter/tags/admin bornées sur copie ou vault dédié | Optimike MCP en `headless-filesystem`                           | Sécurité de chemins, dry-run par défaut et préconditions.                         |
| Édition fichier directe ponctuelle hors contrat MCP                        | Outils filesystem                                               | Utile pour du travail local type repo, mais l'agent porte tous les garde-fous.    |
| Actions ou diagnostics app-native Obsidian                                 | Obsidian CLI                                                    | Utile comme plan de contrôle Desktop/app, pas comme headless strict.              |
| Savoir écrire la syntaxe Markdown, Bases ou Canvas Obsidian                | Skills ou docs de format Obsidian                               | Les skills enseignent les conventions ; elles n'exécutent pas les opérations MCP. |

## Nouveau en V2.2

Utiliser `obsidian_validate_format` avant les écritures risquées ou le contenu généré :

- `kind: markdown` vérifie frontmatter YAML, tags, wikilinks, embeds, callouts et code fences.
- `kind: base` vérifie YAML `.base`, views, références de formules et formes courantes.
- `kind: canvas` vérifie JSON Canvas, nodes, edges, IDs, géométrie et références d'edges.
- `kind: auto` infère depuis l'extension de `filePath`.

Utiliser `obsidian_manage_canvas` seulement en `headless-filesystem` :

- `validate` lit et valide un `.canvas` existant.
- `create` écrit un `.canvas` structurellement valide.
- `add_text_node` ajoute un nœud texte.
- `connect_nodes` ajoute une edge entre deux node IDs existants.

Le dry-run est le défaut pour les opérations d'écriture.

## Routage documentaire externe

Un lien Obsidian vers un fichier local n’autorise pas l’accès à ce fichier.
Employer les outils external-roots uniquement lorsque l’opérateur a
explicitement configuré un identifiant logique.

Workflow agent :

1. Appeler `external_runtime_status` ou `external_roots_list` ; ne jamais déduire
   une racine depuis un chemin physique trouvé dans une note.
2. Employer `external_list` et `external_stat` avec l’identifiant et un chemin
   relatif à la racine.
3. Employer `external_read` uniquement pour du texte UTF-8 borné.
4. Pour un PDF ou un document Office, demander explicitement
   `external_handoff`, puis transmettre la copie temporaire retournée à un outil
   local adapté du client.
5. Conserver comme provenance l’identifiant logique, le chemin relatif et le
   SHA-256. Ne jamais persister le chemin temporaire.

Ne pas promettre l’extraction au seul motif que le handoff fonctionne :
l’extraction dépend du client appelant. Ne pas copier silencieusement le contenu
externe dans le coffre, le fusionner à la recherche du coffre ou traiter la
racine configurée comme une sauvegarde.

## Ce que le headless valide mais ne garantit pas

La validation headless attrape les erreurs locales de format. Elle ne rend pas Obsidian, ne charge pas les plugins communautaires, n'évalue pas le comportement exact de l'UI Bases, n'exécute pas les formules, ne résout pas les backlinks via l'index interne Obsidian et ne confirme pas le layout visuel Canvas.

## Règle pratique pour agents

1. Valider le contenu généré avec `obsidian_validate_format`.
2. Si le comportement Desktop/plugin compte, utiliser `live` ou `hybrid` avec Obsidian ouvert.
3. Sur backend, commencer par `headless-readonly`.
4. Activer `headless-filesystem` seulement sur copie ou vault dédié avec rollback.
