# Optimike Obsidian MCP

[![Dernière version](https://img.shields.io/github/v/release/optimikelabs/optimike-obsidian-mcp?display_name=tag&sort=semver)](https://github.com/optimikelabs/optimike-obsidian-mcp/releases/latest)
English version: [README.md](README.md) · [Hub documentaire](docs/README.fr.md) · [Exploitation](OPERATIONS.fr.md) · [Sécurité](SECURITY.fr.md)

![Vue d’ensemble d’Optimike Obsidian MCP entre clients agentiques, Obsidian et documents externes gouvernés](docs/assets/readme/overview.fr.svg)

Optimike Obsidian MCP fournit aux clients MCP une surface opérationnelle
gouvernée au-dessus d’un coffre Obsidian : notes, Tasks et Operon, Bases,
recherche sémantique, fonctionnement headless, observabilité runtime et accès
borné aux documents externes autorisés.

## Capacités principales

| Domaine | Surface |
| --- | --- |
| Notes | Lecture, recherche, mise à jour, frontmatter, tags et remplacement atomique gouverné d’une note complète |
| Tâches | Lectures Tasks et 23 outils Operon gouvernés via la Developer API officielle |
| Bases et Canvas | Requêtes/écritures Bases, validation et helpers Canvas bornés |
| Recherche | Smart Connections avec cache durable et embedding Ollama ou OpenAI |
| Runtime | Cache SQLite partagé, santé, maintenance, mode dégradé et profils headless |
| Documents externes | Lectures/handoff gouvernés et move local opt-in avec réparation exacte |

La [surface des outils](docs/obsidian_mcp_tools_spec.md) porte les contrats
individuels. La [matrice runtime](docs/runtime-capability-matrix.fr.md) fait foi
pour leur disponibilité.

## Profils

- `live` : Obsidian Desktop et Local REST API, surface complète.
- `hybrid` : surface live quand l’API répond, lecture dégradée sinon.
- `headless-readonly` : premier profil sûr pour serveur, CI ou copie Sync.
- `headless-guarded` : écritures très bornées sur copie ou coffre dédié.
- `headless-filesystem` : opérations filesystem explicites et préconditionnées.

Le serveur Node ne doit pas être exposé directement à Internet. Le HTTP distant
reste pilote derrière TLS, authentification, réseau privé et supervision revus.

## Démarrage depuis les sources

Pré-requis : Node.js `>=22.7.5`, puis :

```bash
git clone https://github.com/optimikelabs/optimike-obsidian-mcp.git
cd optimike-obsidian-mcp
npm install
npm run build
node dist/stdio-proxy.js
```

Le proxy stdio réutilise le backend local persistant au lieu de reconstruire
l’état lourd du coffre pour chaque client.

## Remplacement atomique gouverné d’une note

Le candidat 2.6 rend publics quatre outils métier :

- `obsidian_note_replace_plan`
- `obsidian_note_replace_apply`
- `obsidian_note_replace_status`
- `obsidian_note_replace_recover`

Ils ne sont enregistrés qu’en `live` ou `hybrid` avec API. Ils réutilisent
l’adaptateur et le journal durables livrés en 2.5.0, sans créer de second moteur
ni de surface générique `operation_*`.

Le plan scelle la cible, le binding backend et les preuves SHA-256. Apply accepte
uniquement le `planRef` opaque et la même clé d’idempotence. Après une réponse
incertaine, le client consulte status avant un éventuel recover du plan exact.
Recover n’est pas un undo et n’accepte aucun nouveau payload.

La politique d’écriture MCP courante, les clés frontmatter protégées et le write
gate de l’Atomic Write Bridge sont revalidés avant tout effet. La garantie
atomique couvre la transition de la note cible imposée par `Vault.process` ;
Sync, watchers, plugins, indexeurs et automatisations externes restent hors de
cette frontière de récupération.

Contrat complet : [surface gouvernée](docs/obsidian_mcp_tools_spec.md#governed-atomic-note-replacement).

## Intégrations optionnelles

- Local REST API pour les fonctions live.
- Bases Bridge pour la surface Bases live.
- Atomic Write Bridge, désactivé par défaut, pour le CAS de note complète.
- Optimike Operon Bridge pour les tâches live gouvernées.
- Smart Connections pour la recherche sémantique.
- Obsidian Tasks pour le parsing Tasks canonique.

Le MCP ne relaie pas génériquement les CLI. Chaque mutation publique doit avoir
un schéma borné, un moindre privilège, une précondition, une idempotence durable,
une preuve postflight et une récupération exacte lorsque le backend peut les
imposer.

## Documents externes

Les racines externes sont désactivées par défaut. Le handoff stdio retourne une
copie temporaire vérifiée ; le HTTP authentifié peut retourner un ticket borné
et à usage unique. Aucun handoff n’autorise une mutation.

L’unique mutation externe est un move local stdio, dans une même racine opt-in,
avec préconditions, journal, réparation exacte des références ÉLYSIA et
rollback compensatoire. Il n’ajoute ni upload, création, remplacement,
suppression ni synchronisation.

## Validation

```bash
npm run build
npm run test:runtime
npm run test:operation-runtime
npm run test:governed-note-replace-mcp
npm run check:operon
npm run test:external-roots
npm run test:docs
npm run test:package
npm run audit:production
```

Les suites utilisent des coffres jetables et tournent en CI Linux/Windows. Le
canary Obsidian live reste une gate opérateur explicite avant merge ou release.

## Documentation

- [Hub documentaire](docs/README.fr.md)
- [Surface des outils](docs/obsidian_mcp_tools_spec.md)
- [Matrice des capacités](docs/runtime-capability-matrix.fr.md)
- [Exploitation](OPERATIONS.fr.md)
- [Sécurité](SECURITY.fr.md)
- [Contrat MCP Operon](docs/operon-mcp-contract.fr.md)
- [Configuration des racines externes](docs/external-roots-setup.fr.md)
- [Décisions d’architecture](docs/adr/README.md)

Créé par **Optimike — Mickaël Ahouansou**. Licence : [LICENSE](LICENSE).
