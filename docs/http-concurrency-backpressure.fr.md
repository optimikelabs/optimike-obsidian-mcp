# Concurrence et backpressure du transport HTTP Streamable

Les quotas limitent la fréquence des requêtes. Ils ne protègent pas Obsidian, le cache partagé, les fournisseurs sémantiques, les scans filesystem ou les bridges contre un trop grand nombre d’opérations simultanées. M2 ajoute donc une admission bornée après l’authentification et le quota d’identité, avant l’exécution des outils MCP.

## Couches d’admission

Chaque opération HTTP admise doit respecter tous les plafonds applicables :

1. opérations globales en vol ;
2. opérations en vol pour l’identité client vérifiée ;
3. opérations coûteuses en vol, globalement et pour cette identité ;
4. mutations en vol, globalement et pour cette identité.

Une mutation consomme aussi une capacité d’opération coûteuse. Une requête qui ne peut pas s’exécuter immédiatement rejoint une file bornée. La mise en file ne crée jamais une nouvelle identité et ne fait confiance à aucun header déclaratif.

Le flux longue durée `GET /mcp` ne conserve pas un slot d’opération pendant toute la connexion. Son impact processus est borné par le registre de sessions M1. `POST /mcp`, `DELETE /mcp` et `GET /external-handoff` passent par l’admission. Le streaming d’un artefact externe reste également borné par les limites existantes du broker de handoff : tickets en attente, transferts en vol et durée maximale.

## Valeurs par défaut

| Variable                                        |    Défaut | Fonction                                           |
| ----------------------------------------------- | --------: | -------------------------------------------------- |
| `MCP_HTTP_MAX_IN_FLIGHT`                        |      `32` | Toutes les opérations HTTP admises                 |
| `MCP_HTTP_MAX_IN_FLIGHT_PER_IDENTITY`           |       `8` | Opérations d’une identité vérifiée                 |
| `MCP_HTTP_EXPENSIVE_MAX_IN_FLIGHT`              |       `4` | Opérations coûteuses globales                      |
| `MCP_HTTP_EXPENSIVE_MAX_IN_FLIGHT_PER_IDENTITY` |       `2` | Opérations coûteuses d’une identité                |
| `MCP_HTTP_MUTATION_MAX_IN_FLIGHT`               |       `4` | Mutations globales                                 |
| `MCP_HTTP_MUTATION_MAX_IN_FLIGHT_PER_IDENTITY`  |       `1` | Mutations d’une identité                           |
| `MCP_HTTP_MAX_QUEUED`                           |      `64` | Opérations en file au total                        |
| `MCP_HTTP_MAX_QUEUED_PER_IDENTITY`              |       `8` | Opérations en file pour une identité               |
| `MCP_HTTP_QUEUE_WAIT_TIMEOUT_MS`                |    `5000` | Attente maximale en file                           |
| `MCP_HTTP_MAX_REQUEST_BODY_BYTES`               | `1048576` | Taille maximale du corps JSON-RPC avant HTTP `413` |
| `MCP_HTTP_REQUEST_BODY_READ_TIMEOUT_MS`         |    `5000` | Deadline serveur pour recevoir un corps complet    |
| `MCP_HTTP_BACKPRESSURE_RETRY_AFTER_SECONDS`     |       `1` | Indication prudente de retry                       |

Toutes les valeurs sont validées avant l’ouverture du listener HTTP. Une limite par identité ne peut pas dépasser sa limite globale. La capacité de mutation ne peut pas dépasser la capacité coûteuse, qui ne peut pas dépasser la capacité globale.

Une file de taille zéro est possible uniquement lorsque les deux limites de file sont à zéro. Toute saturation produit alors un refus déterministe immédiat.

Le quota par IP source s’applique avant toute mise en mémoire du corps. Son
refus pré-authentification en `429` utilise l’id JSON-RPC `null`, ne clone ni ne
parse le corps non fiable et annule le flux entrant. Après ce contrôle source,
une garde transport ne lit jamais plus que la taille configurée avant que
l’authentification ou le quota d’identité puisse lire l’id JSON-RPC. Un corps
déclaré ou streamé au-delà de la limite est refusé en HTTP `413`. Un corps
chunked qui ne se termine pas avant le deadline serveur est annulé et refusé en
HTTP `504`.

Les gardes de corps bruts partagent un pool global anonyme distinct, borné par
les mêmes grandeurs globales de concurrence, file et timeout. Une rafale venant
de nombreuses adresses sources encore autorisées ne peut donc pas ouvrir un
nombre illimité de buffers proches de la taille maximale avant
l’authentification. Un refus de la garde annule le corps non lu.

Après vérification de l’identité, l’inspection du corps `POST` conserve toujours
un slot standard. La même limite en octets et le même délai serveur bornent
cette lecture admise ; un timeout ou un dépassement libère le slot exactement
une fois.

Le profil HTTP accepte exactement une enveloppe JSON-RPC par `POST`. Un tableau
JSON à la racine est refusé par défaut en HTTP `400` avant d’atteindre le
handler MCP : compter un batch comme une seule opération contournerait le
contrat de concurrence. Le client doit envoyer chaque membre séparément.

## Classes d’opérations explicites

La liste coûteuse par défaut contient les alias de recherche sémantique, la maintenance runtime, la recherche globale, les requêtes Bases, les scans et requêtes Tasks, certaines opérations de reconstruction ou validation Operon, les lectures externes et le handoff externe.

La liste de mutations contient les outils enregistrés de notes, frontmatter,
tags, canvas, filesystem, Bases, Operon, déplacements externes et opérations
gouvernées qui changent un état. Les appels gouvernés `plan`, `apply` et
`recover` y figurent parce qu’ils écrivent un état durable ou peuvent
exécuter/réconcilier une mutation backend. Ces listes sont explicites et
configurables :

```dotenv
MCP_HTTP_EXPENSIVE_TOOLS=smart_semantic_search,obsidian_global_search,bases_query,query_tasks,external_handoff
MCP_HTTP_MUTATION_TOOLS=obsidian_update_note,obsidian_search_replace,operon_update_task
```

Modifier ces listes change la politique de capacité. Il faut utiliser les noms exacts des outils enregistrés et revoir le résultat. Un outil inconnu reste standard, le serveur ne déduit pas sa classe à partir de son nom.

## File bornée et équitable

La file est partitionnée par identité vérifiée et distribuée en round-robin. Les opérations restent FIFO à l’intérieur d’une même identité. Un client qui accumule des appels ne peut donc pas affamer les autres identités.

L’état de file respecte les bornes globales et par identité. Les entrées d’identité actives ou en attente sont supprimées lorsque leur compteur revient à zéro. Aucun token Bearer, chemin documentaire ou contenu de requête n’est conservé dans l’état d’admission.

Une requête conserve un seul deadline pendant la lecture bornée de son corps et
la requalification de son slot standard en capacité coûteuse ou mutation. Le
parsing et les deux admissions ne reçoivent pas chacun un nouveau timeout.
`X-Optimike-Queue-Wait-Ms` rapporte l’attente cumulée depuis la première
tentative d’admission lorsqu’une requalification a lieu.

## Sémantique de refus

Un refus d’admission renvoie HTTP `503` avec :

- `Retry-After` ;
- `X-Optimike-Backpressure` : `queue-full`, `identity-queue-full`, `timeout` ou `cancelled` ;
- `X-Optimike-Operation-Class` : `standard`, `expensive` ou `mutation` ;
- `X-Request-Id` ;
- une erreur JSON-RPC avec `data.retryable` et `data.admission`.

Une réponse admise expose `X-Optimike-Operation-Class` et `X-Optimike-Queue-Wait-Ms`.

`503` signifie que l’opération n’a pas été admise. Le transport ne la rejoue pas. Une gateway ne peut effectuer un retry que selon la sémantique propre de l’outil. Les lectures sont généralement rejouables. Une mutation doit conserver la clé d’idempotence et les préconditions CAS existantes ; une gateway ne doit jamais les inventer ou les supprimer.

Le proxy stdio local conserve cette frontière. Un résultat applicatif HTTP,
notamment un refus d’admission `503` ou un `404` ordinaire, est renvoyé à l’appel
concerné sans retirer le transport backend partagé ni interrompre les appels
frères déjà admis. Seul le contrat Streamable HTTP exact de session invalide
provoque une rotation et le rejeu de l’appel rejeté. Une rupture réseau ne peut
être rejouée qu’une fois, et seulement si l’annotation backend prouve
`readOnlyHint: true` ; une mutation n’est jamais rejouée et renvoie
`backend_outcome_unknown` afin que son propre contrat de statut, d’idempotence
ou de recovery réconcilie le résultat. La reconnexion est sérialisée, les
annotations sont liées à la génération et les générations retirées disposent
d’un drain borné avant fermeture forcée.

## Libération des slots

Un slot accordé est libéré exactement une fois après une erreur aval, la fin du
corps de réponse ou son annulation. La simple création d’une `Response` en
streaming ne libère pas le slot tant que les octets sont encore transmis. Une
requête retirée de la file par timeout ou annulation n’a jamais consommé de slot
en vol. Les listeners d’abort et les timers sont supprimés quand l’item quitte
la file.

Le contrôleur expose uniquement des instantanés agrégés : compteurs actifs, compteurs de file, admissions, refus et maxima observés. Il n’étiquette aucune métrique avec une identité brute, un token, un chemin ou les arguments d’un outil.

## Sécurité des mutations

M2 ne modifie que l’admission. Il ne change pas :

- les préconditions CAS ;
- les clés d’idempotence ;
- la write policy et les scopes ;
- les journaux de mutation ;
- le rollback ;
- le frontmatter protégé ;
- le confinement des chemins ;
- le statut exclusivement stdio de `external_move_*`.

La CI exécute une charge concurrente déterministe ainsi que les contrats existants de CAS note, recherche-remplacement exacte, external move et mutations Operon. Le backpressure ne remplace aucune de ces garanties.

## Commande de test

```bash
npm run test:http-backpressure
npm run test:stdio-proxy-reliability
```

La suite tourne sur Ubuntu et Windows. Elle prouve les plafonds globaux, par client, coûteux et mutation, les limites de file, l’équité, le timeout, l’annulation, le nettoyage des slots, les headers de retry et une charge déterministe sans coffre personnel.

Pour une preuve stdio live contre Obsidian Desktop, construire d’abord, puis
démarrer un backend HTTP temporaire dédié en mode `readonly`, sur un port
unique, avec des chemins d’état et de journaux uniques et des limites
d’admission volontairement basses. Attendre `/healthz` et `/readyz`, puis lancer
directement le client sans reconstruire `dist` sous le processus actif :

```bash
OBSIDIAN_STDIO_BACKPRESSURE_CANARY_PATH="chemin/vers/note-jetable-ou-non-sensible.md" \
MCP_HTTP_PORT=39117 \
node scripts/smoke-stdio-backpressure-live.mjs
```

Le canary ne passe que si au moins une lecture réussit, au moins un appel est
refusé par le contrat d’admission JSON-RPC exact avec
`data.applicationCode: SERVICE_UNAVAILABLE`, aucun
appel frère ne renvoie `Connection closed`, puis une nouvelle lecture réussit.
Il n’accepte que `queue-full`, `identity-queue-full`, `timeout` ou `cancelled`
dans `data.admission`, avec le message et la valeur `data.retryable`
correspondants. Un `503` générique, un échec upstream ou un rate-limit `429`
n’est pas une preuve de backpressure. Connexion, découverte, burst, lecture de
contrôle et arrêt sont tous bornés par des watchdogs. Ne pas utiliser pour ce
gate un backend partagé déjà sollicité à répétition : sa fenêtre indépendante
de rate-limit par identité, longue de 15 minutes, peut masquer l’admission par
un `429` légitime.

Le canary impose `MCP_PROXY_REQUIRE_EXISTING_BACKEND=true` : une cible
indisponible échoue fermée au lieu de laisser un backend détaché non suivi.
Après le run, arrêter le backend suivi, vérifier qu’aucun listener ne subsiste
sur son port, puis supprimer son état privé et son dossier de logs ignoré.
