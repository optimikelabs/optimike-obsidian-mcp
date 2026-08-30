# Contrat d’observabilité du transport HTTP Streamable

Optimike MCP expose les signaux consommables par un monitoring externe ou une gateway OSS. Il ne construit ni plateforme d’incident, ni dashboard, ni backend de monitoring.

## Trois endpoints, trois significations

### `GET /healthz`

Liveness non authentifiée uniquement. HTTP `200` signifie que le processus et le listener HTTP répondent. Cela ne prouve pas qu’Obsidian Desktop, le coffre filesystem, le cache partagé, un bridge ou un fournisseur sémantique est disponible.

Les champs de compatibilité existants restent présents :

```json
{
  "ok": true,
  "status": "healthy",
  "state": "live",
  "transport": "streamable-http",
  "endpoint": "/mcp"
}
```

### `GET /readyz`

Readiness non authentifiée et nettoyée pour le profil runtime configuré. Elle renvoie :

- HTTP `200` pour `ready` et `degraded` ;
- HTTP `503` pour `critical`.

Un service dégradé peut encore servir un sous-ensemble documenté. Un service critique ne peut pas servir le profil attendu en sécurité.

### `GET /statusz`

Statut détaillé authentifié. Il utilise la même protection pré-authentification par source, la même authentification et le même quota d’identité vérifiée que `/mcp`. Il ajoute uniquement des agrégats sur les sessions, l’admission et l’occupation des compteurs de quotas. Il ne renvoie jamais de token Bearer, d’identité client brute, de contenu documentaire, de chemin documentaire ou de chemin personnel du coffre.

## États de readiness

| État       | Signification                                                                   | HTTP sur `/readyz` |
| ---------- | ------------------------------------------------------------------------------- | -----------------: |
| `ready`    | Le profil attendu est disponible depuis une source vérifiée                     |              `200` |
| `degraded` | Un fallback borné reste utilisable, ou une dépendance non critique est dégradée |              `200` |
| `critical` | Aucune source vérifiée ne peut servir le profil attendu en sécurité             |              `503` |

L’état contient des raisons stables et exploitables, par exemple `live_obsidian_unavailable_using_stale_fallback`, `cache_refresh_failed`, `headless_cache_unavailable` ou `headless_vault_and_cache_unavailable`. Le texte d’exception d’un rafraîchissement échoué n’est jamais renvoyé.

## Provenance et fraîcheur

Le contrat distingue les sources suivantes :

- `live-obsidian` ;
- `filesystem` ;
- `cache` ;
- `snapshot` ;
- `unknown`.

Il expose aussi l’origine interne (`obsidian_api`, `filesystem`, `cache`, `snapshot` ou `unknown`), le timestamp d’observation, l’âge en millisecondes, la connaissance ou non de la fraîcheur et le statut stale.

Une source n’est jamais qualifiée de `live-obsidian` uniquement parce que le service tourne en mode `live`. Le transport sonde le service REST Obsidian configuré indépendamment du cache facultatif. Un probe authentifié, récent et réussi rend donc un profil live prêt même si le cache est désactivé. Une observation issue d’un cache prêt dont la vraie source de rafraîchissement est `rest` est aussi normalisée vers l’origine publique `obsidian_api` et doit rester dans le seuil de fraîcheur. Au-delà, la provenance devient `snapshot` et le service passe en dégradé. Un échec connu de rafraîchissement du cache est signalé sous forme de dégradation expurgée. Un fallback stale n’est jamais présenté comme live.

La cadence du probe live est la plus petite valeur entre 30 secondes et la
moitié du seuil de fraîcheur configuré. Abaisser ce seuil ne peut donc pas
laisser un profil live sain sans cache devenir stale entre deux probes fixes de
30 secondes.
Un probe direct récent prime sur une preuve plus ancienne issue du cache :
s’il déclare l’API REST indisponible, les lectures live et les mutations sont
retirées immédiatement, même si un snapshot précédemment rafraîchi par REST
reste exploitable comme fallback.
Un timestamp d’observation situé plus de cinq secondes dans le futur constitue
une preuve invalide. Il n’autorise jamais la readiness live ni les mutations ;
un payload de cache exploitable peut uniquement rester disponible comme
fallback stale avec une raison de diagnostic stable.

Seuil de fraîcheur par défaut :

```dotenv
MCP_OBSERVABILITY_STALE_AFTER_MS=900000
```

## Dépendances et capacités momentanément indisponibles

Le statut distingue :

- si Obsidian Desktop est requis et vérifié ;
- si le coffre filesystem configuré existe ;
- si le backend de lecture du cache partagé est prêt ;
- si les lectures live, filesystem, cache et les mutations sont actuellement possibles.

`temporarilyUnavailable` contient des identifiants de capacités stables, jamais du texte d’exception. Un profil headless read-only peut donc être `ready` tout en indiquant que `live-obsidian-reads` et `mutations` sont indisponibles par conception. L’existence du chemin du coffre ne suffit pas : la readiness headless reste `critical` tant que le cache partagé n’a pas terminé un build exploitable depuis le filesystem.

Le mode hybride suit la même règle de preuve : sans observation vérifiée de l’API live ni fallback borné prêt, il est `critical`, et non simplement `degraded`. La capacité de mutation utilise le mode d’écriture validé centralement par le runtime ; l’observabilité ne réinterprète pas l’environnement brut.

## Logs structurés de requêtes

Chaque requête HTTP émet un événement de fin lorsque le corps de sa réponse est terminé, annulé par le client ou en erreur. La simple création d’une `Response` streamée n’est pas considérée comme une fin. L’événement contient :

- `requestId` (un UUID généré, également renvoyé dans `X-Request-Id`) ;
- l’identité client vérifiée pseudonymisée lorsque l’authentification a réussi ;
- le transport ;
- la méthode et la route HTTP ;
- la méthode MCP ou le nom de l’outil lorsqu’il peut être classé sans risque ;
- la durée ;
- le résultat et le statut HTTP ;
- les résultats de quotas ;
- le résultat d’admission ou de backpressure ;
- la classe d’opération et le temps d’attente ;
- la provenance courante et le statut stale ;
- une empreinte HMAC par processus, facultative, des valeurs fournies par
  l’appelant pour `correlationId` et `incidentId`. Les valeurs brutes ne sont
  jamais conservées en clair.

Les erreurs applicatives mappées utilisent le statut de la vraie réponse
d’erreur et ne sont journalisées qu’après la fin de son corps. Si le corps
échoue après la production des headers, l’événement conserve le statut placé
sur le réseau et indique `result: exception` au lieu d’inventer ensuite un
HTTP `500`.

## Enveloppe d’erreur HTTP publique

Chaque rejet HTTP, y compris la limite pré-authentification, l’authentification,
le refus d’origin, la capacité de session, le backpressure d’admission, le
routage de profil invalide et le fallback Hono, utilise une même enveloppe
JSON-RPC. `error.data.requestId` est le même UUID que `X-Request-Id` et que
l’entrée structurée d’ErrorHandler. Le champ protocolaire `error.code` est
toujours un entier JSON-RPC. La catégorie applicative fermée reste disponible
uniquement dans `error.data.applicationCode`. L’enveloppe ne contient sinon
qu’un message de catalogue et des diagnostics serveur autorisés ; elle ne
reflète jamais un corps de requête, un chemin de profil, un token ou un message
d’exception.

Les mappages stables du transport sont `503` pour `SERVICE_UNAVAILABLE` et
`504` pour `TIMEOUT`. Un identifiant JSON-RPC n’est reflété que depuis une
enveloppe de requête `2.0` valide et uniquement s’il vaut `null`, une chaîne ou
un nombre fini (y compris `0`) ; une enveloppe invalide, un objet ou un tableau
produit `null`.

Les méthodes JSON-RPC et noms d’outils contrôlés par l’appelant ne sont journalisés que s’ils respectent une grammaire stricte d’identifiant de 128 caractères. Les autres valeurs sont remplacées par le libellé HTTP contrôlé, ce qui empêche caractères de contrôle, contenu documentaire et valeurs démesurées d’entrer dans le champ d’opération.

Les clients peuvent envoyer des indications de corrélation :

```http
X-Correlation-Id: incident-42:retry.1
X-Incident-Id: inc_2026-07-29_001
```

Seuls 1 à 128 caractères de `[A-Za-z0-9._:-]` sont acceptés. Une valeur
invalide est ignorée au lieu d’être journalisée. Les valeurs acceptées sont
empreintes par HMAC avec un secret généré pour le processus en cours ;
L’empreinte permet donc de corréler les événements pendant la durée de vie de
ce processus, mais elle n’est pas stable après un redémarrage. L’UUID
`X-Request-Id` reste l’identifiant public en clair pour corréler une requête
individuelle. Ces headers servent uniquement à la corrélation, jamais à
l’authentification ou à l’autorisation.

Les logs n’incluent pas par défaut :

- `Authorization` ou un token Bearer ;
- les secrets d’authentification ;
- l’issuer, le subject ou le client ID bruts ;
- le corps des requêtes ou réponses ;
- les arguments des outils MCP ;
- le contenu des notes ;
- les chemins physiques du coffre ou des racines externes ;
- les tickets de handoff externe.

## Exemple de readiness nettoyée

```json
{
  "schemaVersion": "1",
  "state": "degraded",
  "ready": true,
  "degraded": true,
  "critical": false,
  "runtimeMode": "hybrid",
  "provenance": {
    "source": "snapshot",
    "origin": "obsidian_api",
    "observedAt": "2026-07-29T11:45:00.000Z",
    "freshnessMs": 1200000,
    "stale": true,
    "freshnessKnown": true
  },
  "capabilities": {
    "liveObsidianReads": false,
    "filesystemReads": true,
    "cacheReads": true,
    "mutations": false,
    "temporarilyUnavailable": ["live-obsidian-reads", "mutations"]
  },
  "reasons": ["live_obsidian_unavailable_using_stale_fallback"]
}
```

## Compatibilité et limites

- `/healthz` reste non authentifié et conserve les champs historiques `ok`, `status`, `transport` et `endpoint`.
- `/readyz` ne contient ni secret ni chemin et peut servir de probe de readiness à un load balancer.
- `/statusz` est authentifié et soumis aux quotas, mais reste une surface opérationnelle à ne pas exposer publiquement sans TLS et politique réseau.
- La santé est locale au processus. Elle ne prétend ni haute disponibilité en cluster, ni stockage distribué des sessions.
- Le serveur expose les signaux. L’alerting, la rétention, les dashboards et la gestion d’incident restent externes.

## Tests

```bash
npm run test:http-observability
```

La suite tourne sur Ubuntu et Windows. Elle prouve le vocabulaire réel `rest` du cache, la readiness directe de l’API live sans cache, la readiness stricte du mode hybride, le cache filesystem exploitable, l’échec de rafraîchissement expurgé, le snapshot stale, les états degraded et critical, la fin et l’annulation des corps streamés, les noms d’opérations bornés, la journalisation des rejets Origin, les codes HTTP des endpoints, l’authentification de `/statusz`, les agrégats nettoyés et l’absence de tokens, secrets, contenu documentaire et chemins personnels dans les surfaces d’observabilité.
