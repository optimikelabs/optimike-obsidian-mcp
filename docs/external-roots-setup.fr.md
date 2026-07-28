# Racines documentaires externes — configuration et exploitation

Les racines documentaires externes permettent à un client MCP de découvrir et
lire des fichiers explicitement autorisés qui restent hors du coffre Obsidian :
PDF, documents Office, jeux de données, dossiers projet ou bibliothèques gérées
par une autre application.

Cette fonction est un courtier en lecture seule, pas un second coffre :

- le MCP autorise des identifiants logiques et confine chaque requête à une
  racine ;
- il sait lister, lire les métadonnées, calculer un hash et lire du texte UTF-8
  dans des limites explicites ;
- un client stdio local peut demander une copie temporaire vérifiée avec
  `external_handoff`, puis employer ses propres outils PDF, Office ou OCR ;
- il n’indexe, ne synchronise, ne déplace, ne renomme, n’écrit et ne sauvegarde
  aucun document externe.

## 1. Créer une configuration locale à la machine

Copier [`external-roots.example.json`](external-roots.example.json) hors du
dépôt. Ne jamais committer le fichier configuré : il contient des chemins
propres à la machine.

Exemple Unix :

```json
{
  "version": 1,
  "roots": [
    {
      "id": "project.documents",
      "path": "/srv/documents/project",
      "capabilities": ["visible", "readable", "handoff"],
      "include": ["**/*.md", "**/*.pdf", "**/*.docx"],
      "exclude": ["**/.git/**", "**/node_modules/**", "**/~$*"],
      "limits": {
        "maxDepth": 6,
        "maxFileBytes": 52428800,
        "maxListEntries": 500,
        "maxTextChars": 200000
      }
    }
  ]
}
```

Exemple JSON Windows :

```json
{
  "version": 1,
  "roots": [
    {
      "id": "project.documents",
      "path": "B:\\Documents\\Projet",
      "capabilities": ["visible", "readable", "handoff"],
      "include": ["**/*.md", "**/*.pdf", "**/*.docx"],
      "exclude": ["**/.git/**", "**/node_modules/**", "**/~$*"],
      "limits": {
        "maxDepth": 6,
        "maxFileBytes": 52428800,
        "maxListEntries": 500,
        "maxTextChars": 200000
      }
    }
  ]
}
```

Les antislashs JSON doivent être doublés. Les chemins préfixés UNC sont refusés.
Un lecteur réseau mappé ou un système réseau monté derrière un chemin d’apparence
locale ne peut pas être détecté de manière fiable et reste hors garanties.

## 2. Contrat de configuration

L’objet racine est strict :

| Champ     | Contrat                                                    |
| --------- | ---------------------------------------------------------- |
| `version` | Doit valoir `1`.                                           |
| `roots`   | De zéro à 32 racines. Chaque identifiant doit être unique. |

Chaque racine est également stricte :

| Champ          | Contrat                                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | Identifiant logique stable en minuscules : lettres, chiffres, `.`, `_` et `-`.                                                     |
| `path`         | Dossier absolu. Les chemins préfixés UNC sont refusés ; un stockage réseau mappé ou monté n’est pas détecté et reste non supporté. |
| `capabilities` | Une ou plusieurs valeurs parmi `visible`, `readable`, `handoff`. `handoff` exige `readable`.                                       |
| `include`      | Allowlist de globs de style Git. Défaut : `["**"]`. Un fichier qui ne correspond à aucun motif est refusé, même sans extension.    |
| `exclude`      | Denylist de globs. Défaut : `.git` et `node_modules`. `exclude` l’emporte sur `include`.                                           |
| `limits`       | Limites bornées optionnelles décrites ci-dessous. Les champs inconnus sont refusés.                                                |

Les capacités sont distinctes :

- les identifiants, capacités, états de disponibilité et limites des racines
  sont toujours exposés par `external_runtime_status` et
  `external_roots_list` ;
- `visible` autorise le listing borné et les métadonnées de fichiers ;
- `readable` autorise le hash et la lecture UTF-8 directe ;
- `handoff` autorise une copie temporaire vérifiée, uniquement en stdio local.

Valeurs par défaut et plafonds du schéma :

| Limite           |  Défaut |   Maximum |
| ---------------- | ------: | --------: |
| `maxDepth`       |       6 |        20 |
| `maxFileBytes`   |  50 Mio |   200 Mio |
| `maxListEntries` |     500 |     5 000 |
| `maxTextChars`   | 200 000 | 2 000 000 |

`external_read` accepte les fichiers UTF-8 valides portant les extensions
`.txt`, `.md`, `.markdown`, `.csv`, `.json`, `.yaml`, `.yml`, `.xml`, `.html`,
`.htm` et `.log`. Pour un document binaire autorisé, employer
`external_handoff`.

## 3. Configurer un client stdio local

L’entrypoint recommandé est `dist/stdio-proxy.js`. Définir
`MCP_EXTERNAL_ROOTS_FILE` sur ce processus MCP, jamais dans le coffre.

Codex sous Windows :

```toml
[mcp_servers.optimike-obsidian-mcp-stdio]
command = "node"
args = ['E:\chemin\vers\optimike-obsidian-mcp\dist\stdio-proxy.js']

[mcp_servers.optimike-obsidian-mcp-stdio.env]
MCP_EXTERNAL_ROOTS_FILE = 'C:\Users\vous\.config\optimike\external-roots.json'
```

Codex sous Unix :

```toml
[mcp_servers.optimike-obsidian-mcp-stdio]
command = "node"
args = ["/chemin/vers/optimike-obsidian-mcp/dist/stdio-proxy.js"]

[mcp_servers.optimike-obsidian-mcp-stdio.env]
MCP_EXTERNAL_ROOTS_FILE = "/home/vous/.config/optimike/external-roots.json"
```

Claude Code, Gemini CLI, OpenClaw, Hermes Agent et les autres clients MCP locaux
peuvent employer la même commande stdio et la même variable si leur
implémentation permet de configurer l’environnement du processus. Leur syntaxe,
leurs approbations et leur accès au chemin local retourné restent propres au
client. Le dépôt ne promet pas une parité identique entre eux.

| Client              | Intégration visée                                       | Ce que ce dépôt vérifie                                                         |
| ------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Codex               | Proxy stdio local avec environnement du processus       | Usage de production configuré et workflow pilote.                               |
| Claude Code         | Serveur stdio local configuré par le client             | Conception compatible avec le protocole ; setup propre au client non testé ici. |
| Gemini CLI          | Serveur stdio local configuré par le client             | Conception compatible avec le protocole ; setup propre au client non testé ici. |
| OpenClaw            | Processus MCP local si son déploiement le supporte      | Conception compatible ; accès au chemin dépendant du déploiement.               |
| Hermes Agent        | Processus MCP local si son déploiement le supporte      | Conception compatible ; accès au chemin dépendant du déploiement.               |
| Client HTTP distant | Status/list/stat/read selon la politique de déploiement | Handoff de chemin physique toujours refusé.                                     |

Le cœur MCP n’installe ni ne configure les extracteurs du client. Sans outil PDF
ou Office local adapté, un client peut toujours lister, lire les métadonnées,
hasher et lire les documents UTF-8 autorisés, mais pas extraire un binaire.

## 4. Redémarrer et vérifier

Le JSON est chargé une seule fois au démarrage du processus MCP. Après toute
modification du fichier ou de la variable d’environnement, redémarrer le client
MCP ou son serveur.

Séquence de vérification recommandée :

1. Appeler `external_runtime_status` ; confirmer `enabled: true`,
   `localHandoffAllowed: true` et l’identifiant logique attendu.
2. Appeler `external_roots_list` ; confirmer que la racine est `available`.
3. Appeler `external_list` avec l’identifiant et une profondeur bornée.
4. Appeler `external_stat`, puis `external_read` sur un petit fichier pilote
   UTF-8.
5. Si nécessaire, appeler `external_handoff` sur un document autorisé et
   vérifier que le client ouvre bien la copie temporaire retournée.

Vérifications du dépôt sous Unix :

```bash
npm run test:external-roots
MCP_EXTERNAL_ROOTS_FILE=/chemin/absolu/external-roots.json npm run smoke:external-roots
MCP_EXTERNAL_ROOTS_FILE=/chemin/absolu/external-roots.json npm run smoke:external-roots:mcp
```

Sous PowerShell :

```powershell
npm run test:external-roots
$env:MCP_EXTERNAL_ROOTS_FILE = 'C:\Users\vous\.config\optimike\external-roots.json'
npm run smoke:external-roots
npm run smoke:external-roots:mcp
```

Ces contrôles ne testent pas la même frontière :

- `test:external-roots` emploie des fixtures jetables et teste le confinement,
  les allowlists, l’identité du handle, la redaction, les limites, le cycle des
  copies temporaires, le vrai proxy stdio et le refus du handoff HTTP ;
- `smoke:external-roots` valide le service configuré et une vraie racine pilote ;
- `smoke:external-roots:mcp` valide le contrat MCP via l’entrypoint stdio direct
  avec la racine configurée ;
- le client de production doit encore être vérifié via `dist/stdio-proxy.js`
  avec les cinq appels décrits plus haut.

## 5. Cycle de vie du handoff et sécurité

`external_handoff` ne retourne pas le chemin source. Il lit via un handle vérifié
et crée une copie détenue par le processus en mode `0600` sur les plateformes
qui appliquent les permissions de fichiers POSIX.

- le handoff est refusé en HTTP ;
- les copies expirent après une heure et sont nettoyées toutes les cinq minutes ;
- un service conserve au maximum 16 fichiers et 512 Mio de copies ;
- les copies les plus anciennes sont évincées pour libérer de la place ;
- le processus supprime son dossier lors d’un arrêt normal ;
- un service configuré ultérieur récupère les dossiers détenus par des processus
  morts ou des heartbeats périmés.

Le chemin retourné est éphémère. Le client doit l’utiliser pendant l’opération
courante et ne jamais le conserver comme provenance documentaire.

La provenance portable est l’identifiant logique, le chemin relatif, la taille,
la date de modification et le SHA-256 lorsqu’il est retourné, pas le chemin
temporaire.

## 6. Retour arrière et dépannage

Le retour arrière échoue fermé :

1. retirer `MCP_EXTERNAL_ROOTS_FILE` de la configuration du client MCP ;
2. redémarrer le processus MCP ;
3. appeler `external_runtime_status` et confirmer `enabled: false`.

Cette opération ne supprime ni ne modifie aucun document source. Les éventuelles
copies temporaires suivent leur cycle de nettoyage normal.

| Erreur/état             | Vérification                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `configuration_invalid` | Chemin de config absolu, JSON valide, version `1`, champs connus et règles d’identifiant. |
| `root_unavailable`      | Le dossier existe et le processus MCP peut y accéder.                                     |
| `capability_denied`     | La racine déclare la capacité exigée par l’opération.                                     |
| `path_not_allowed`      | Le chemin relatif correspond à `include` et pas à `exclude`.                              |
| `path_link_unsupported` | Retirer les symlinks/jonctions du chemin demandé.                                         |
| `too_large`             | Vérifier `maxFileBytes` et le budget agrégé du handoff.                                   |
| `unsupported`           | Employer un texte UTF-8 avec `external_read`, ou le handoff stdio pour un binaire.        |
| Handoff refusé          | Employer un client stdio local ; HTTP ne divulgue volontairement aucun chemin.            |

Le serveur ne déduit jamais une nouvelle racine à partir d’un chemin trouvé dans
une note Obsidian.
