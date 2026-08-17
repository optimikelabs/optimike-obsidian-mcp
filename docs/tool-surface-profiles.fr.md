# Profils de surface d’outils

Version anglaise : [tool-surface-profiles.md](tool-surface-profiles.md)

Optimike Obsidian MCP sépare deux contrats qui répondent à deux problèmes
différents :

- le **mode runtime** contrôle ce que le backend peut fournir en sécurité (`live`, `hybrid`, `headless-readonly`, `headless-guarded`, `headless-filesystem`) ;
- le **profil d’outils** contrôle ce qu’un client MCP voit avant `tools/list`.

Les profils réduisent l’ambiguïté côté modèle et le volume des schémas exposés.
Ils ne constituent pas une frontière d’autorisation. Les contrôles runtime,
write-mode, bridge, scopes, confirmations et CAS restent autoritaires même si un
outil est visible.

## Profils publics

| Profil | Usage visé | Surface complète live/hybrid |
| --- | --- | ---: |
| `standard` | Lecture/recherche générale du coffre + authoring note/frontmatter courant | 19 outils |
| `authoring` | `standard` + tags, authoring/formules Bases et authoring Canvas | 31 outils |
| `tasks` | Compatibilité Markdown Tasks + contrat MCP Operon complet | 31 outils |
| `full` | Surface compatibilité/admin 2.x du runtime actif | 72 outils |

Ces nombres sont des projections du registre actuel et peuvent être plus faibles
dans un runtime plus restreint. Par exemple, `standard` expose 9 outils en
`headless-readonly`. `full` signifie « tous les outils enregistrés par le runtime
actif », pas « toujours 72 outils ».

Le registre canonique couvre 76 noms uniques entre tous les runtimes, car quatre
outils existent uniquement en `headless-filesystem` et ne font donc pas partie
des 72 outils live/hybrid.

## Nom de la recherche sémantique

Les profils modernes n’exposent qu’un seul nom public :

```text
smart_semantic_search
```

Les anciens alias `smart_search` et `smart-search` sont masqués dans `standard`,
`authoring` et `tasks`. Ils restent visibles uniquement dans `full` pendant la
branche 2.x pour ne pas casser silencieusement un client public existant. Leur
suppression physique est réservée à la 3.0, sauf décision ultérieure d’assumer
une rupture SemVer en mineure.

Tout nouveau routage agentique ou intégration doit utiliser uniquement
`smart_semantic_search`.

## Familles gouvernées

Une famille gouvernée est exposée atomiquement. Lorsqu’un profil expose l’une de
ces familles, les quatre opérations restent visibles ensemble :

```text
plan → apply → status → recover
```

Cela vaut pour le remplacement gouverné de note, la projection Frontmatter, les
formules Base et le patch de graphe Canvas.

Un profil ne modifie jamais le contenu scellé du plan, son journal, sa clé
d’idempotence, son binding backend ni son autorité de récupération. Un plan
durable créé dans une session peut être inspecté ou récupéré depuis une autre
session ou un autre profil qui expose la même famille, sous réserve des
politiques runtime et d’écriture/sécurité habituelles.

## Canonique et fallback direct

Les profils modernes peuvent masquer un outil direct de compatibilité lorsque
la famille gouvernée correspondante est réellement enregistrée. Ils conservent
la voie directe lorsqu’aucun équivalent gouverné n’existe dans le runtime.

Exemple actuel :

- `live` / `hybrid` live : la famille complète `obsidian_frontmatter_patch_*`
  est exposée et `obsidian_manage_frontmatter` est masqué ;
- `headless-guarded` / `headless-filesystem` : la famille gouvernée Frontmatter
  n’existe pas, donc `obsidian_manage_frontmatter` reste le fallback borné.

`full` n’applique jamais cette suppression au profit de la voie canonique.

## Sélection en stdio

Le comportement historique reste `full` lorsqu’aucun profil n’est indiqué.

Via argument :

```bash
node dist/stdio-proxy.js --tool-profile standard
```

ou via environnement :

```bash
MCP_TOOL_PROFILE=standard node dist/stdio-proxy.js
```

`--tool-profile` gagne sur `MCP_TOOL_PROFILE`. Un profil inconnu ou un argument
répété échoue fermé au lieu de retomber sur `full`.

Le proxy stdio applique le profil **par client**. S’il doit lancer le backend
HTTP partagé, il lance explicitement ce backend en `full`, puis filtre sa propre
surface client. Un agent `standard` et un agent `tasks` peuvent donc partager le
même backend sans modifier mutuellement leur liste d’outils.

Un outil masqué est aussi refusé lorsqu’il est appelé directement ; le profilage
n’est pas un simple filtrage cosmétique de `tools/list`.

## Sélection en HTTP

Le serveur HTTP expose des routes de profil explicites et immuables :

```text
/mcp              → full (alias de compatibilité 2.x)
/mcp/standard     → standard
/mcp/authoring    → authoring
/mcp/tasks        → tasks
/mcp/full         → full
```

Une session est liée à son identité vérifiée **et** à son profil d’outils. Un
`sessionId` créé sur `/mcp/standard` ne peut pas être réutilisé sur `/mcp/full`,
y compris pour les requêtes de session POST, GET ou DELETE. Un mismatch de
profil échoue fermé avec la même posture générique « session invalide/expirée »
qu’un mismatch d’identité.

Le profil est porté par un contexte de requête uniquement pendant la création du
`McpServer` propre à la session. Il n’est jamais écrit dans un état global du
processus ; plusieurs profils peuvent donc coexister simultanément sur le même
backend HTTP.

## Filtrage supplémentaire côté client

Les profils serveur sont le contrat portable. Un client peut ensuite réduire
encore cette surface avec ses propres fonctions, mais il ne devient jamais la
source de vérité.

Mécanismes complémentaires possibles :

- Codex : `enabled_tools` / `disabled_tools` ;
- Gemini CLI : `includeTools` / `excludeTools` ;
- Claude Code : tool search / chargement différé des outils MCP ;
- Hermes Agent : filtres include/exclude ;
- OpenClaw : `toolFilter.include` / `toolFilter.exclude`.

Ces mécanismes diffèrent selon les harnesses et peuvent évoluer séparément.
Choisir d’abord le profil Optimike adapté, puis n’utiliser le filtrage client que
s’il apporte un gain local supplémentaire.

## Exemples clients

### Codex — stdio

```toml
[mcp_servers.optimike]
command = "node"
args = [
  "/chemin/vers/optimike-obsidian-mcp/dist/stdio-proxy.js",
  "--tool-profile",
  "standard"
]

[mcp_servers.optimike.env]
OBSIDIAN_VAULT = "/chemin/vers/coffre"
OBSIDIAN_RUNTIME_MODE = "live"
OBSIDIAN_BASE_URL = "http://127.0.0.1:27123"
OBSIDIAN_API_KEY = "<cle-local-rest-api>"
```

`enabled_tools` peut éventuellement réduire encore la surface déjà sélectionnée
côté serveur.

### Gemini CLI — stdio

```json
{
  "mcpServers": {
    "optimike": {
      "command": "node",
      "args": [
        "/chemin/vers/optimike-obsidian-mcp/dist/stdio-proxy.js",
        "--tool-profile",
        "standard"
      ],
      "env": {
        "OBSIDIAN_VAULT": "/chemin/vers/coffre",
        "OBSIDIAN_RUNTIME_MODE": "live"
      }
    }
  }
}
```

`includeTools` / `excludeTools` restent des réductions optionnelles côté client.

### Claude Code — stdio

```bash
claude mcp add optimike -- node \
  /chemin/vers/optimike-obsidian-mcp/dist/stdio-proxy.js \
  --tool-profile standard
```

Claude Code peut aussi différer le chargement de grandes surfaces MCP via son
tool search. Le profil serveur reste utile : il définit la surface publique
canonique avant toute stratégie propre au client.

### Client HTTP générique

Le profil vit directement dans l’URL MCP :

```text
http://127.0.0.1:3010/mcp/standard
```

Aucun header propriétaire n’est nécessaire.

## Règle de compatibilité 2.x

Pendant la branche 2.x :

- aucun profil indiqué → `full` ;
- `/mcp` historique → comportement `/mcp/full` ;
- les alias de recherche sémantique restent accessibles uniquement dans `full` ;
- les profils modernes sont opt-in et peuvent être recommandés pour les nouvelles installations ;
- la visibilité ne relâche jamais les contrôles runtime/écriture/sécurité existants.

Une future version majeure pourra faire de `standard` le défaut et retirer les
alias dépréciés après une fenêtre de migration explicite.
