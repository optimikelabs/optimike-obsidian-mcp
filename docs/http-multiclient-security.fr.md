# Sécurité multi-client du transport HTTP Streamable

Ce document décrit le contrat M1 d’identité et de quotas HTTP. Il s’applique au transport HTTP Streamable direct, au backend persistant utilisé par le proxy stdio et aux déploiements derrière une gateway OSS.

## Frontière de confiance

Optimike MCP n’accepte une identité client fonctionnelle qu’après validation JWT ou OAuth. L’identité est dérivée des claims vérifiés d’issuer, d’identifiant client et de subject. Lorsqu’un token vérifié ne contient pas de subject, une empreinte HMAC du token calculée côté serveur sert uniquement de discriminant de secours.

Les valeurs suivantes ne constituent jamais une preuve d’identité :

- `X-Client-Id` ou un header déclaratif similaire ;
- `Forwarded` ou `X-Forwarded-For` ;
- un identifiant de session MCP ;
- le nom déclaré dans `clientInfo` par le client MCP ;
- le nom d’un processus proxy stdio.

Les tokens Bearer bruts ne sont conservés que lorsqu’un contrat existant en dépend, par exemple la liaison d’un ticket de handoff externe à l’identité. Ils ne deviennent jamais un champ de log, un détail d’erreur ou une clé de quota en clair.

## Deux plans de quotas indépendants

### Protection pré-authentification par source

Chaque requête vers `/mcp` et `/external-handoff` consomme d’abord une capacité bornée associée à l’adresse source. Cette protection couvre le coût de validation des credentials absents, malformés ou invalides.

Le quota fonctionnel par identité vérifiée s’applique lorsque l’outil MCP émet
le ticket de handoff. La consommation de ce ticket mono-usage et lié à
l’identité reste protégée par la limite d’adresse source et par
l’authentification, mais ne consomme pas une seconde unité d’identité. Un ticket
émis avec la dernière unité disponible de la fenêtre doit rester utilisable.

Valeurs par défaut :

```text
fenêtre : 900000 ms
requêtes par source hors loopback : 600
politique loopback : elevated
requêtes par source loopback : 3000
nombre maximal de sources suivies : 5000
```

### Quota fonctionnel par client

Après authentification réussie, la requête consomme une seconde capacité associée à l’identité vérifiée.

Valeurs par défaut :

```text
fenêtre : 900000 ms
requêtes par identité vérifiée : 100
nombre maximal d’identités suivies : 10000
```

Conséquences :

- deux identités valides derrière une même IP disposent de quotas fonctionnels isolés ;
- une même identité sur plusieurs connexions partage un quota ;
- changer d’adresse source ne réinitialise pas le quota fonctionnel ;
- une authentification absente ou invalide reste soumise à la protection pré-authentification ;
- tous les états sont bornés et les compteurs expirés sont nettoyés périodiquement.

Une requête refusée renvoie HTTP `429`, une erreur JSON, `Retry-After`, `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` et `X-Optimike-Rate-Limit-Scope`.

## Politique loopback

Le loopback n’est jamais exempté. La politique par défaut `elevated` accorde une capacité pré-authentification plus large au trafic local des proxies, tout en maintenant une borne. `MCP_HTTP_LOOPBACK_POLICY=shared` applique également au loopback la limite standard.

Cette distinction concerne uniquement la protection secondaire par source. Le quota fonctionnel reste associé à l’identité vérifiée.

## Proxies approuvés

Les headers de proxy sont ignorés par défaut. `MCP_TRUSTED_PROXIES` doit contenir uniquement les IP ou CIDR des proxies immédiats explicitement approuvés :

```dotenv
MCP_TRUSTED_PROXIES=10.20.0.10/32,2001:db8:42::10/128
```

Lorsque le pair réseau immédiat est approuvé, la chaîne est parcourue depuis le bord de confiance vers le premier saut non approuvé. Une chaîne invalide échoue de manière fermée et l’adresse du socket fait foi.

`MCP_TRUST_PROXY=true` ne suffit plus. Si cet ancien flag est activé sans allowlist explicite, le démarrage est refusé.

Un réseau privé ne remplace ni TLS, ni l’authentification Bearer, ni la politique de confiance des proxies.

## Identité du proxy stdio

Le proxy stdio se connecte au même backend HTTP persistant que les clients HTTP directs. Un backend sécurisé exige donc :

```dotenv
MCP_BACKEND_BEARER_TOKEN=<token vérifié propre à cet agent>
```

Il faut provisionner un credential par agent lorsqu’une isolation des quotas et de la concurrence est nécessaire. Réutiliser un credential signifie volontairement partager la même identité, le même quota et, dans les jalons suivants, les mêmes limites de concurrence. Optimike MCP ne traite jamais un simple label fourni par le proxy comme une preuve.

Le profil personnel de développement peut fonctionner sans authentification configurée hors production. Tous ces proxies reçoivent alors la même identité de développement explicite et partagent donc le même quota fonctionnel.

## Liaison des sessions

Une session MCP HTTP est liée à l’identité vérifiée qui l’a initialisée. Une autre identité authentifiée ne peut pas réutiliser son identifiant. La réponse ne permet pas de distinguer ce cas d’une session absente ou expirée.

Le registre des sessions, local au processus, est borné par `MCP_HTTP_MAX_SESSIONS`, avec une valeur par défaut de 500. Une saturation renvoie `503` et `Retry-After`. Ce contrat ne constitue pas un stockage de sessions distribué.

## Configuration

| Variable                                   |                                   Défaut | Fonction                                           |
| ------------------------------------------ | ---------------------------------------: | -------------------------------------------------- |
| `MCP_HTTP_PREAUTH_RATE_LIMIT_WINDOW_MS`    |                                 `900000` | Fenêtre de protection par source                   |
| `MCP_HTTP_PREAUTH_RATE_LIMIT_MAX`          |                                    `600` | Requêtes par source hors loopback et par fenêtre   |
| `MCP_HTTP_LOOPBACK_POLICY`                 |                               `elevated` | `shared` ou `elevated`                             |
| `MCP_HTTP_LOOPBACK_PREAUTH_RATE_LIMIT_MAX` |                                   `3000` | Requêtes loopback par fenêtre avec `elevated`      |
| `MCP_HTTP_IDENTITY_RATE_LIMIT_WINDOW_MS`   |                                 `900000` | Fenêtre du quota fonctionnel                       |
| `MCP_HTTP_IDENTITY_RATE_LIMIT_MAX`         |                                    `100` | Requêtes par identité et par fenêtre               |
| `MCP_HTTP_PREAUTH_RATE_LIMIT_MAX_KEYS`     |                                   `5000` | Borne des compteurs par source                     |
| `MCP_HTTP_IDENTITY_RATE_LIMIT_MAX_KEYS`    |                                  `10000` | Borne des compteurs d’identité                     |
| `MCP_HTTP_RATE_LIMIT_CLEANUP_INTERVAL_MS`  |                                 `300000` | Intervalle de nettoyage                            |
| `MCP_HTTP_MAX_SESSIONS`                    |                                    `500` | Borne des sessions locales au processus            |
| `MCP_TRUSTED_PROXIES`                      |                                     vide | Allowlist d’IP ou CIDR de proxies                  |
| `MCP_HTTP_IDENTITY_HASH_KEY`               | secret JWT ou clé aléatoire du processus | Clé HMAC dédiée facultative, 32 caractères minimum |
| `MCP_BACKEND_BEARER_TOKEN`                 |                                     vide | Credential du proxy stdio vers un backend sécurisé |

Toutes les valeurs numériques sont validées au démarrage. Une valeur invalide ou dangereuse arrête le processus avant l’ouverture du listener HTTP.

## Ce que ce jalon ne modifie pas

- les scopes et autorisations des outils ;
- la validation des origins ;
- la write policy et le frontmatter protégé ;
- le confinement du coffre et des racines externes ;
- le refus des symlinks et junctions ;
- le CAS et l’idempotence des mutations ;
- les journaux de mutation et le rollback ;
- les tickets éphémères et à usage unique du handoff externe ;
- le statut exclusivement stdio de `external_move_*`.

Une gateway ne peut élargir aucune de ces permissions.
