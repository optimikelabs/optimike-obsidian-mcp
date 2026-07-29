# Pilote Linux headless multi-client

English version: [headless-multiclient-pilot.md](headless-multiclient-pilot.md)

Documentation liée : [Profil serveur headless](headless-server-profile.fr.md), [Sécurité HTTP multi-client](http-multiclient-security.fr.md), [Concurrence et backpressure HTTP](http-concurrency-backpressure.fr.md), [Observabilité HTTP](http-observability-contract.fr.md), [Compatibilité gateway](gateway-compatibility.fr.md)

## Décision

Le premier profil Linux multi-agent est un **pilote en lecture seule sur une
copie ou un coffre dédié**. Il ne certifie ni un coffre personnel vivant, ni une
exposition Internet distante, ni la parité avec Obsidian Desktop et ses plugins.

La preuve automatisée crée un coffre et un cache jetables, démarre le vrai
serveur Streamable HTTP en `headless-readonly`, puis connecte plusieurs clients
authentifiés indépendamment. Commande :

```bash
npm run test:http-headless-multiclient
```

Le même test est obligatoire dans la CI Ubuntu et Windows. Il prouve le contrat
serveur portable ; un véritable hôte Linux reste une gate opérationnelle
terrain.

## Matrice des capacités

| Capacité                                                        | Linux `headless-readonly` | Source requise                                              | Verdict du pilote                                                    |
| --------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| Streamable HTTP, sessions, identité JWT, quotas et backpressure | Oui                       | Processus Optimike MCP                                      | Automatisé avec plusieurs clients concurrents distincts              |
| Liveness, readiness et statut expurgé                           | Oui                       | Runtime HTTP et cache filesystem                            | Automatisé ; l’existence d’un chemin ne suffit pas à la readiness    |
| Liste, lecture et recherche globale du coffre                   | Oui                       | Copie/coffre dédié et cache filesystem                      | Automatisé sur une fixture jetable                                   |
| Tâches Markdown legacy                                          | Oui                       | Markdown/cache filesystem                                   | Lecture seule ; ce n’est pas le moteur natif de filtres Operon       |
| Liste/requête Bases                                             | Oui                       | Fallback local `.base` et Markdown                          | Fallback local en lecture seule                                      |
| Lecture de racines externes et handoff HTTP par ticket          | Optionnel                 | Allowlist explicite et scope `external:read`                | Couvert par les suites handoff et gateway séparées                   |
| Écriture de notes, frontmatter, tags, Bases ou Canvas           | Non                       | Profil d’écriture guarded/filesystem                        | Les outils d’écriture ne doivent pas être enregistrés                |
| Move externe et réparation des références                       | Non en HTTP direct        | Stdio local et `headless-filesystem` sur copie/coffre dédié | CAS, journal et rollback restent locaux                              |
| Lectures/écritures Obsidian live                                | Non                       | Obsidian Desktop et Local REST API                          | Jamais déduit de la fraîcheur filesystem                             |
| Filtres natifs et mutations Operon                              | Non                       | Bridge Operon vivant dans Obsidian                          | Un snapshot validé peut seulement fournir certaines lectures bornées |

## Environnement du pilote

Conserver le listener HTTP en loopback pendant le premier run :

```bash
OBSIDIAN_RUNTIME_MODE=headless-readonly
OBSIDIAN_VAULT=/srv/obsidian/optimike-pilot-vault
OBSIDIAN_CACHE_SOURCE=filesystem
OBSIDIAN_SHARED_CACHE_DB_PATH=/var/lib/optimike-mcp/cache/shared-cache.sqlite
OBSIDIAN_ENABLE_CACHE=true
LOGS_DIR=/var/log/optimike-mcp
MCP_WRITE_MODE=readonly
MCP_TRANSPORT_TYPE=http
MCP_HTTP_HOST=127.0.0.1
MCP_HTTP_PORT=3010
MCP_HTTP_PORT_RETRIES=0
MCP_AUTH_MODE=jwt
MCP_AUTH_SECRET_KEY=<secret-gere-hors-du-repo>
```

Donner une identité bearer différente à chaque agent. Un libellé d’affichage
n’est pas une identité d’autorisation. Le cache, les logs et les secrets restent
hors du coffre.

## Modèle systemd minimal

Ce modèle n’expose volontairement que le loopback. Adapter les chemins et la
gestion des secrets à l’hôte :

```ini
[Unit]
Description=Optimike Obsidian MCP headless pilot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=optimike-mcp
Group=optimike-mcp
WorkingDirectory=/opt/optimike-obsidian-mcp
EnvironmentFile=/etc/optimike-mcp/headless.env
ExecStart=/usr/bin/node /opt/optimike-obsidian-mcp/dist/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/srv/obsidian/optimike-pilot-vault
ReadWritePaths=/var/lib/optimike-mcp /var/log/optimike-mcp

[Install]
WantedBy=multi-user.target
```

Valider l’unité effective et les permissions filesystem avant démarrage. Le
compte de service lit le coffre pilote et n’écrit que dans les dossiers de cache
et de logs.

## Reverse proxy ou gateway

Une gateway est optionnelle. Elle n’est utile que si un plan d’accès doit
ajouter TLS, politique réseau ou routage. Optimike MCP continue de vérifier
l’identité bearer et conserve les scopes, la politique d’écriture, les
permissions de racines, le CAS, l’idempotence et le rollback.

Pour le premier pilote gateway, utiliser la
[route HTTP transparente agentgateway testée](agentgateway.transparent.example.yaml).
Elle doit transmettre :

- `/mcp` et `/external-handoff` ;
- `Authorization`, `Mcp-Session-Id` et `X-External-Handoff-Ticket` ;
- le streaming, l’annulation, les statuts `429`/`503` et `Retry-After`.

Ne pas activer de retry des mutations. Ne pas faire confiance à `Forwarded` ou
`X-Forwarded-For` sans proxy immédiat explicitement configuré qui remplace les
valeurs non fiables. Lier Optimike directement à `0.0.0.0` ne fait pas partie de
ce pilote.

## Run terrain

1. Créer une copie ou un coffre dédié non sensible.
2. Garder toute synchronisation headless en pull-only.
3. Placer le cache hors du coffre.
4. Lancer `npm run test:http-headless-multiclient`.
5. Lancer `npm run smoke:headless-server-profile` sur la copie.
6. Démarrer le service systemd loopback et connecter deux vrais agents avec
   deux identités bearer distinctes.
7. Vérifier `/healthz`, `/readyz` et `/statusz` authentifié.
8. Tester liste, lecture, recherche, tâches et Bases pendant au moins 30 minutes.
9. Confirmer que les outils d’écriture coffre/Bases sont absents, que les
   mutations Operon échouent fermé sans Bridge live et qu’aucun fichier du
   coffre n’a changé.

Go uniquement si toutes les étapes sont vertes. Aucun enregistrement de log ne
doit contenir de token bearer, secret d’authentification ou contenu de note ;
les événements structurés de fin de requête HTTP doivent aussi omettre les
chemins physiques du coffre. Le déploiement reste pilote tant que le reverse
proxy, la gateway, l’émetteur OAuth réel ou la frontière réseau distante n’ont
pas été revus sur l’hôte cible.
