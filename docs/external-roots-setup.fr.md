# Racines documentaires externes — configuration et exploitation

Version anglaise : [external-roots-setup.md](external-roots-setup.md)

Les racines documentaires externes permettent à un client MCP de découvrir et
de lire des fichiers explicitement autorisés qui restent hors du coffre
Obsidian : PDF, documents Office, jeux de données, dossiers projet ou
bibliothèques gérées par une autre application.

Cette fonction est principalement un courtier en lecture, pas un second coffre
ni un gestionnaire de fichiers générique :

- le MCP autorise des identifiants logiques et confine chaque requête à une
  racine ;
- il sait lister, lire les métadonnées, calculer un hash et lire du texte UTF-8
  dans des limites explicites ;
- `external_handoff` peut préparer un snapshot vérifié pour un client qui possède
  les outils PDF, Office, OCR ou binaires adaptés ;
- un workflow stdio local, autorisé séparément, peut déplacer un fichier régulier
  dans la même racine et réparer ses références ÉLYSIA exactes ;
- il n’indexe, ne synchronise, n’upload, ne crée, ne remplace, ne supprime et ne
  sauvegarde aucun document externe.

Le mode de livraison dépend du transport :

- le stdio local retourne un `local_path` éphémère ;
- un profil HTTP direct authentifié peut retourner un `http_ticket` optionnel ;
- aucun mode ne retourne le chemin physique source ;
- aucun mode ne modifie la source ni n’accorde un droit de copie durable.

Voir [ADR — Racines documentaires externes](adr/ADR-External-Document-Roots.md)
et [ADR — Livraison HTTP gouvernée des artefacts externes](adr/ADR-HTTP-External-Artifact-Delivery.md).
La frontière move/réparation est portée par
[ADR — Intégrité des références externes](adr/ADR-External-Reference-Integrity.fr.md).

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

| Champ          | Contrat                                                                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | Identifiant logique stable en minuscules : lettres, chiffres, `.`, `_` et `-`.                                                                           |
| `path`         | Dossier absolu. Les chemins préfixés UNC sont refusés ; un stockage réseau mappé ou monté n’est pas détecté et reste non supporté.                       |
| `capabilities` | Une ou plusieurs valeurs parmi `visible`, `readable`, `handoff`, `move`. `handoff` exige `readable` ; `move` est une autorisation positive indépendante. |
| `include`      | Allowlist de globs de style Git. Défaut : `["**"]`. Un fichier qui ne correspond à aucun motif est refusé, même sans extension.                          |
| `exclude`      | Denylist de globs. Défaut : `.git` et `node_modules`. `exclude` l’emporte sur `include`.                                                                 |
| `limits`       | Limites bornées optionnelles décrites ci-dessous. Les champs inconnus sont refusés.                                                                      |

Les capacités sont distinctes :

- les identifiants, capacités, états de disponibilité et limites des racines
  sont toujours exposés par `external_runtime_status` et
  `external_roots_list` ;
- `visible` autorise le listing borné et les métadonnées de fichiers ;
- `readable` autorise le hash et la lecture UTF-8 directe ;
- `handoff` autorise un snapshot vérifié via un mode de livraison supporté par
  le transport actif.
- `move` autorise la planification d’un déplacement de fichier régulier dans la
  même racine. L’apply et le rollback exigent encore les deux gates du processus
  et le stdio local.

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

## 3. Profil stdio local recommandé

L’entrypoint local recommandé est `dist/stdio-proxy.js`. Définir
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

Le proxy réutilise ou démarre le backend HTTP persistant sur localhost et
intercepte localement les tools des racines externes. `external_handoff`
retourne donc un `local_path` vérifié que le même client peut consommer.

Ne pas enregistrer le proxy et l’endpoint HTTP direct comme deux copies du même
MCP dans un seul client par défaut. Cela duplique la surface d’outils et rend le
routage ambigu.

## 4. Profil HTTP direct optionnel

Le Streamable HTTP direct est un profil de service explicite. Il exige un
backend supervisé déjà démarré ; il n’est pas auto-démarré par un client distant.

Valeurs locales sûres :

```text
MCP_TRANSPORT_TYPE=http
MCP_HTTP_HOST=127.0.0.1
MCP_HTTP_PORT=3010
MCP_HTTP_PORT_RETRIES=0
MCP_EXTERNAL_ROOTS_FILE=/chemin/absolu/external-roots.json
```

Démarrer et vérifier :

```bash
npm run build
npm run start:daemon
curl http://127.0.0.1:3010/healthz
```

`/healthz` est une sonde de vie non authentifiée et ne retourne volontairement
qu’un état minimal sans chemin. Utiliser les outils authentifiés
`obsidian_runtime_status` et `obsidian_runtime_maintenance` pour les détails de
runtime, cache, configuration ou intégrité.

Le port configuré est déterministe par défaut. Définir
`MCP_HTTP_PORT_RETRIES` à une valeur bornée uniquement si des ports de repli
contrôlés sont acceptables.

### Activer le handoff HTTP par ticket

La livraison binaire HTTP est désactivée par défaut. L’activer uniquement sur un
profil HTTP authentifié :

```text
MCP_HTTP_HANDOFF_ENABLED=true
MCP_AUTH_MODE=jwt
MCP_AUTH_SECRET_KEY=<secret-d-au-moins-32-caracteres>
```

OAuth peut aussi fournir l’identité authentifiée, mais le déploiement OAuth
distant reste un pilote tant que les métadonnées de ressource protégée et
l’interopérabilité client ne sont pas validées.

Réglages bornés optionnels des tickets HTTP :

| Variable                               |  Défaut | Maximum |
| -------------------------------------- | ------: | ------: |
| `MCP_HTTP_HANDOFF_TTL_MS`              |  60 000 | 300 000 |
| `MCP_HTTP_HANDOFF_MAX_TICKETS`         |      16 |     128 |
| `MCP_HTTP_HANDOFF_MAX_FILE_BYTES`      |  25 Mio | 200 Mio |
| `MCP_HTTP_HANDOFF_MAX_TOTAL_BYTES`     | 128 Mio |   1 Gio |
| `MCP_HTTP_HANDOFF_TRANSFER_TIMEOUT_MS` | 120 000 | 600 000 |

Le broker refuse le placeholder d’authentification de développement et exige le
scope `external:read` sur l’identité authentifiée. Définir
`MCP_HTTP_HANDOFF_ENABLED=true` sans cette identité réelle et correctement
scopée n’ouvre pas le handoff binaire.

### Séquence du handoff HTTP

1. Appeler `external_handoff` via la session MCP HTTP authentifiée.
2. Recevoir `delivery: http_ticket`, la provenance logique, le SHA-256,
   l’expiration, l’endpoint fixe et le nom du header de ticket.
3. Envoyer `GET /external-handoff` au même service.
4. Envoyer la même identité bearer ainsi que
   `X-External-Handoff-Ticket: <ticket-opaque>`.
5. Vérifier `Content-Length`, `X-Artifact-SHA256` et les octets téléchargés.

Le ticket :

- porte un seul snapshot mémoire vérifié ;
- est lié à l’empreinte du token bearer, au client ID et au sujet ;
- exige le scope `external:read` lors de son émission ;
- est à usage unique ;
- expire rapidement ;
- n’apparaît jamais dans une URL ;
- ne divulgue aucun chemin source ou temporaire.

Un téléchargement interrompu consomme le ticket. Demander un nouveau handoff au
lieu de rejouer l’ancien ticket.

### Frontière HTTP distante

Un profil distant reste un pilote derrière un reverse proxy TLS de confiance ou
une frontière de service équivalente. Il exige une politique d’origines
explicite, des limites de connexion et de corps, une configuration de confiance
des headers transmis, une authentification, une supervision du processus et des
contrôles réseau ou firewall.

Définir `MCP_TRUST_PROXY=true` uniquement si un reverse proxy de confiance
réécrit les headers de forwarding et si la politique réseau bloque l’accès
direct au processus Node. Le serveur ignore `X-Forwarded-For` par défaut ; le
booléen ne suffit pas à authentifier un proxy.

Ne pas exposer directement le serveur Node sur Internet en se contentant de
lier `MCP_HTTP_HOST=0.0.0.0`.

## 5. Matrice des clients

| Client                           | Intégration visée                                          | Ce que ce dépôt vérifie                                                                                       |
| -------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Codex                            | Proxy stdio local avec environnement du processus          | Usage de production configuré et workflow de handoff par chemin local.                                        |
| Claude Code                      | Serveur stdio local configuré par le client                | Conception compatible avec le protocole ; setup propre au client non testé ici.                               |
| Gemini CLI                       | Serveur stdio local configuré par le client                | Conception compatible avec le protocole ; setup propre au client non testé ici.                               |
| OpenClaw                         | Processus MCP local si son déploiement le supporte         | Conception compatible ; accès au chemin dépendant du déploiement.                                             |
| Hermes Agent                     | Processus MCP local si son déploiement le supporte         | Conception compatible ; accès au chemin dépendant du déploiement.                                             |
| Client HTTP direct sur localhost | Status/list/stat/read et handoff optionnel par ticket      | Tests automatisés Streamable HTTP, JWT, ticket, replay, identité et binaire.                                  |
| Client HTTP distant              | Même protocole derrière des contrôles de déploiement revus | Architecture et tests serveur automatisés ; interopérabilité avec de vrais clients distants encore en pilote. |

Le cœur MCP n’installe ni ne configure les extracteurs du client. Sans outil PDF
ou Office adapté, un client peut toujours lister, lire les métadonnées, hasher et
lire les documents UTF-8 autorisés, mais pas extraire un binaire.

## 6. Redémarrer et vérifier

La configuration JSON des racines et les réglages des tickets HTTP sont chargés
au démarrage du processus. Redémarrer le client MCP ou le service après toute
modification.

Séquence de vérification recommandée :

1. Appeler `external_runtime_status` et confirmer `enabled: true` ainsi que
   l’identifiant logique attendu.
2. Utiliser une identité portant `external:read` pour tout appel HTTP direct de
   status, list, stat, read, hash ou handoff sur les racines externes.
3. Examiner `handoffModes` :
   - le stdio doit exposer `local_path` ;
   - un service HTTP direct authentifié et activé doit exposer `http_ticket`.
4. Appeler `external_roots_list` et confirmer que la racine est `available`.
5. Appeler `external_list` avec l’identifiant et une profondeur bornée.
6. Appeler `external_stat`, puis `external_read` sur un petit fichier UTF-8.
7. Si nécessaire, appeler `external_handoff` et consommer le mode retourné.
8. Confirmer qu’aucun résultat public ne contient le chemin physique de la
   racine.

Vérifications du dépôt :

```bash
npm run test:external-roots
npm run test:http-external-handoff
MCP_EXTERNAL_ROOTS_FILE=/chemin/absolu/external-roots.json npm run smoke:external-roots
MCP_EXTERNAL_ROOTS_FILE=/chemin/absolu/external-roots.json npm run smoke:external-roots:mcp
```

Sous PowerShell :

```powershell
npm run test:external-roots
npm run test:http-external-handoff
$env:MCP_EXTERNAL_ROOTS_FILE = 'C:\Users\vous\.config\optimike\external-roots.json'
npm run smoke:external-roots
npm run smoke:external-roots:mcp
```

Ces contrôles ne testent pas la même frontière :

- `test:external-roots` emploie des fixtures jetables et teste le confinement,
  les allowlists, l’identité du handle, la redaction, les limites, le cycle du
  handoff local, le proxy stdio et la livraison HTTP authentifiée par ticket dans
  les CI Linux et Windows ;
- `test:http-external-handoff` isole le contrat du broker et du transport HTTP ;
- `smoke:external-roots` valide le service configuré et une vraie racine pilote ;
- `smoke:external-roots:mcp` valide le contrat MCP via l’entrypoint stdio direct
  avec la racine configurée ;
- le client de production exige toujours une vérification propre au client.

## 7. Cycle de vie et sécurité du handoff

`external_handoff` ne retourne jamais le chemin source.

Le service de handoff local lit via un handle vérifié et possède une copie bornée
en mode `0600` sur les plateformes qui appliquent les permissions POSIX :

- les copies expirent après une heure et sont nettoyées toutes les cinq minutes ;
- un service conserve au maximum 16 fichiers et 512 Mio ;
- les copies les plus anciennes sont évincées pour libérer de la place ;
- le processus supprime son dossier lors d’un arrêt normal ;
- un service configuré ultérieur récupère les dossiers détenus par des processus
  morts ou des heartbeats périmés.

Le broker HTTP ne possède ni ne supprime ce cache local. Il vérifie la copie et
conserve un snapshot mémoire borné tant que le ticket est en attente et pendant
le téléchargement par flux découpé. La réservation de capacité n’est libérée
qu’à la fin ou à l’annulation du flux ; un ticket inutilisé expiré est nettoyé
sans livraison.

La provenance portable est l’identifiant logique, le chemin relatif, la taille,
la date de modification et le SHA-256, pas un chemin local ni un ticket.

## 8. Move local gouverné et réparation des références

L’unique mutation external-root est une transaction stdio locale sur un fichier
régulier. Elle sert à préserver les références ÉLYSIA, pas à remplacer les
outils filesystem.

### Ajouter l’identité stable à côté du lien cliquable

```md
- [Ouvrir le brief](file:///B:/Documents/Projet/brief%20final.docx) — `external-ref:project.documents::brief%20final.docx`
```

Le lien reste cliquable. Le code inline adjacent porte l’identifiant logique et
le chemin relatif à la racine, encodé canoniquement en pourcentage. `/` sépare
les segments encodés. Le token n’expose pas le chemin configuré de la racine et
n’autorise aucun accès par lui-même.

Seule une paire exacte token/lien dans le même paragraphe Markdown actif peut
être réparée automatiquement. Chemins physiques nus, tokens incohérents ou
orphelins, candidats multiples, syntaxe non supportée et sections
d’historique/exemple/archive/release passent en revue manuelle. Une seule
occurrence en revue manuelle bloque l’apply.

### Activer explicitement le pilote

Conserver les exemples ordinaires ci-dessus en lecture seule. Pour une racine
pilote non sensible, ajouter volontairement `move` :

```json
"capabilities": ["visible", "readable", "handoff", "move"]
```

Puis configurer le processus stdio local :

```text
MCP_WRITE_MODE=full
MCP_EXTERNAL_MOVE_ENABLED=true
MCP_EXTERNAL_MOVE_JOURNAL_PATH=<chemin-sqlite-local-absolu-optionnel>
```

Les trois autorisations sont nécessaires pour l’apply et le rollback : mode
write complet, feature flag et capacité `move` de la racine. Scan, plan et
status ne déplacent pas le fichier, mais restent stdio-only car le proxy possède
la racine locale et le journal.

### Exécuter la transaction

1. Appeler `external_references_scan` avec `rootId`, `relativePath` et un
   `searchInPath` relatif au coffre, optionnel.
2. Appeler `external_move_plan` avec `sourceRelativePath`,
   `targetRelativePath`, `searchInPath` et une `idempotencyKey` unique.
3. Examiner `external_move_status` ; ne poursuivre que si `readyToApply` vaut
   true et `manualReview` est vide.
4. Appeler `external_move_apply` avec le `planId` retourné et la même
   `idempotencyKey`.
5. Vérifier cible et notes réparées. Si le résultat vérifié doit être annulé,
   appeler `external_move_rollback` avec les mêmes identifiants avant de modifier
   le fichier ou les notes réparées.

Le dossier parent cible doit déjà exister. Source et cible doivent être des
fichiers réguliers dans la même racine logique et sur le même volume ; la cible
doit être absente. L’apply revérifie taille, date de modification et SHA-256 de
la source. Il emploie une séquence hard-link/unlink sans écrasement et échoue
fermé si le filesystem ne peut pas prouver le move.

Chaque réparation de note est planifiée avec un SHA-256 attendu. En Obsidian
live, l’écriture utilise la version Local REST API et `If-Match` de Markdown
Patch 2.x ; une édition concurrente provoque un conflit, jamais un écrasement.
Le journal SQLite local persiste l’état du plan et les préimages des notes pour
la compensation. Le traiter comme une donnée locale sensible : ne jamais le
committer ni le partager.

Le HTTP direct refuse scan, plan, status, apply et rollback. Les tickets HTTP
restent des handoffs en lecture seule.

Il n’existe toujours aucun upload, create, replace, déplacement de dossier,
move entre racines/volumes, overwrite, delete, corbeille ou sync external-root.

Les stockages cloud, synchronisés, mappés ou montés n’héritent pas des garanties
de mutation du filesystem local. SharePoint, Google Drive, OneDrive et services
similaires ont besoin de connecteurs spécifiques pour des écritures gouvernées.

## 9. Retour arrière et dépannage

Désactiver la livraison HTTP par ticket sans modifier une racine ni un fichier
source :

1. retirer `MCP_HTTP_HANDOFF_ENABLED` ou le passer à `false` ;
2. redémarrer le service HTTP ;
3. appeler `external_runtime_status` et confirmer l’absence de `http_ticket`.

Désactiver toutes les racines externes :

1. retirer `MCP_EXTERNAL_ROOTS_FILE` de la configuration du client ;
2. redémarrer le processus ;
3. confirmer `external_runtime_status.enabled: false`.

Erreurs fréquentes :

| Erreur/état              | Vérification                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `configuration_invalid`  | Chemin de config absolu, JSON valide, version `1`, champs connus et règles d’identifiant.                       |
| `root_unavailable`       | Le dossier existe et le processus MCP peut y accéder.                                                           |
| `capability_denied`      | La racine déclare la capacité exigée ; le mode ticket HTTP est activé et utilise une vraie authentification.    |
| `path_not_allowed`       | Le chemin relatif correspond à `include` et pas à `exclude`.                                                    |
| `path_link_unsupported`  | Retirer les symlinks ou jonctions du chemin demandé.                                                            |
| `target_exists`          | Choisir une cible absente ; l’overwrite n’est jamais autorisé.                                                  |
| `precondition_failed`    | Refaire scan et plan après modification de source, note ou état de plan.                                        |
| `too_large`              | Limites de racine et budget agrégé du handoff local ou HTTP.                                                    |
| `unsupported`            | Employer un texte UTF-8 avec `external_read`, ou un mode de handoff supporté pour le binaire.                   |
| Ticket HTTP indisponible | Vérifier feature flag, auth, identité bearer, TTL, usage unique et redémarrage du service.                      |
| Port inattendu           | Garder `MCP_HTTP_PORT_RETRIES=0` ou examiner le repli borné configuré.                                          |
| Échec client distant     | Vérifier proxy TLS, allowlist Origin, métadonnées auth, confiance forwarding, firewall et compatibilité client. |

Le serveur ne déduit jamais une nouvelle racine à partir d’un chemin trouvé dans
une note Obsidian.
Désactiver le move sans affecter les lectures en passant
`MCP_EXTERNAL_MOVE_ENABLED=false` ou en retirant `move` de la racine, puis en
redémarrant le processus stdio.
