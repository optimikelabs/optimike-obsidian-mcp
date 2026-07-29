# Compatibilité avec les gateways OSS

English version: [gateway-compatibility.md](gateway-compatibility.md)

Ce document consigne l’audit M4 et la preuve reproductible de bout en bout. Une
gateway reste optionnelle. C’est un plan d’accès, pas l’autorité de permissions
d’Optimike MCP.

## Décision

Utiliser **agentgateway en routage HTTP transparent** pour le premier pilote
avec gateway.

Optimike MCP doit continuer à :

- vérifier le bearer token d’origine et en dériver l’identité fonctionnelle ;
- appliquer scopes, politique d’écriture et capacités des racines externes ;
- lier sessions MCP et tickets HTTP à cette identité ;
- imposer quotas, concurrence, CAS, idempotence et rollback.

La gateway peut ajouter TLS, politique réseau, routage et limites externes
indépendantes. Elle ne doit ni remplacer ni élargir ces contrôles.

## Projets audités

| Projet                                                            | Adéquation au pilote                                                                                                       | Décision                                                                       |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [agentgateway](https://github.com/agentgateway/agentgateway)      | Binaire autonome Apache-2.0 ; routes HTTP transparentes et fonctions MCP ; binaire v1.4.0 disponible pour Windows et Linux | Sélectionné et testé de bout en bout                                           |
| [IBM ContextForge](https://github.com/IBM/mcp-context-forge)      | Plateforme large de registre, fédération, transformation, authentification et administration                               | Option entreprise crédible plus tard ; trop large pour le premier pilote borné |
| [Microsoft MCP Gateway](https://github.com/microsoft/mcp-gateway) | Routage MCP avec sessions et gestion de cycle de vie, centré Kubernetes, Azure et Entra ID                                 | Non retenu pour le pilote local/headless                                       |

Cette comparaison ne prétend pas que les deux projets écartés sont dangereux
ou incompatibles. Leur adéquation a été évaluée depuis leur architecture et
leur documentation officielles. Leur routage de l’endpoint auxiliaire n’a pas
été prouvé de bout en bout.

## Pourquoi le mode HTTP transparent

Optimike expose deux surfaces :

- l’endpoint Streamable HTTP `/mcp` ;
- l’endpoint de téléchargement authentifié `/external-handoff`.

Une cible virtuelle exclusivement MCP ne prouve que `/mcp`. La route
agentgateway retenue transmet toute la surface HTTP bornée : le même bearer
token, `Mcp-Session-Id`, `X-External-Handoff-Ticket`, les en-têtes de
corrélation, le streaming et les codes de statut atteignent Optimike sans
transformation.

Utiliser l’exemple revu :
[agentgateway.transparent.example.yaml](agentgateway.transparent.example.yaml).

Ne pas activer de retry de mutation dans la gateway. Une lecture peut être
rejouée selon sa propre sémantique. Une mutation doit conserver sa clé
d’idempotence et ses préconditions CAS ; si une réponse est perdue après
admission, il faut réconcilier l’état via les outils de statut ou le journal
d’Optimike, pas rejouer aveuglément.

## Preuve reproductible

Le harness est
[`scripts/test-agentgateway-compatibility.mjs`](../scripts/test-agentgateway-compatibility.mjs).
Il exige un binaire agentgateway fourni explicitement et vérifié par checksum :

```powershell
$env:AGENTGATEWAY_BIN = "C:\chemin\vers\agentgateway-windows-amd64.exe"
$env:AGENTGATEWAY_COMMIT = "<commit upstream>"
npm run test:gateway:agentgateway
```

Le run vérifié du 29 juillet 2026 utilise agentgateway `v1.4.0`, commit upstream
`83c952731ee79b4372e3a031382c4ff419ddfee1`, avec le SHA-256 de l’asset Windows :

```text
f60ac4318c0352a18c2419842fe1cc1fdca0521500848260a3f03a2f98d4ac87
```

Il valide :

- initialisation Streamable HTTP et transmission de l’en-tête de session ;
- deux identités vérifiées derrière la même IP de gateway ;
- propriété des sessions ;
- requêtes concurrentes et refus de surcharge bornés ;
- transmission de `429` et `Retry-After` ;
- retry déterministe d’une lecture ;
- annulation d’un stream suivie d’une requête saine ;
- transmission de l’autorisation et du ticket vers `/external-handoff` ;
- refus d’une mauvaise identité, du replay et d’un ticket expiré ;
- absence de chemin physique de racine externe dans les résultats MCP,
  téléchargement et statut ;
- `/statusz` authentifié et transmission des en-têtes de corrélation.

Le probe de replay d’une mutation est volontairement indisponible dans le
profil `headless-readonly`. La sûreté des mutations reste couverte par les
tests CAS/idempotence dédiés et par le pilote M5 sur un coffre copié ou dédié.

## Frontière de déploiement

Cette preuve valide la compatibilité. Elle n’autorise pas une exposition
publique directe.

Pour un pilote distant, exiger en plus :

- terminaison TLS avec frontière de confiance revue ;
- réseau privé ou allowlist d’ingress explicite ;
- mode OAuth conforme afin qu’Optimike valide l’issuer, l’audience et les
  scopes. Le mode JWT à secret partagé utilisé par le harness loopback valide
  la signature et les scopes, mais n’impose ni issuer ni audience ;
- aucune confiance dans `X-Forwarded-For` sans proxy immédiat explicitement
  approuvé ;
- timeouts explicites et aucun retry automatique de mutation ;
- supervision de `/healthz`, `/readyz`, `/statusz` authentifié, des `429`,
  `503` et des logs structurés.

Aucune gateway Optimike maison n’est nécessaire.
