# Optimike Obsidian MCP

[![Dernière version](https://img.shields.io/github/v/release/optimikelabs/optimike-obsidian-mcp?display_name=tag&sort=semver)](https://github.com/optimikelabs/optimike-obsidian-mcp/releases/latest)
English: [README.md](README.md) · [Docs](docs/README.fr.md) · [Exploitation](OPERATIONS.fr.md) · [Sécurité](SECURITY.fr.md)

![Vue d’ensemble Optimike Obsidian MCP](docs/assets/readme/overview.fr.svg)

Optimike Obsidian MCP fournit aux agents une surface gouvernée au-dessus d’un
coffre Obsidian : notes, Tasks et Operon, Bases, recherche sémantique,
fonctionnement headless, observabilité runtime et accès borné aux documents
externes.

## Profils runtime

- `live` : Obsidian Desktop et Local REST API.
- `hybrid` : outils live quand l’API répond, lectures dégradées sinon.
- `headless-readonly` : profil le plus sûr pour serveur, CI et copie Sync.
- `headless-guarded` : écritures très bornées sur copie ou coffre dédié.
- `headless-filesystem` : opérations filesystem explicites et préconditionnées.

Le serveur Node ne doit pas être exposé directement à Internet. Le HTTP distant
reste pilote derrière TLS, authentification, réseau privé et supervision revus.

## Démarrage

Node.js `>=22.7.5` :

```bash
git clone https://github.com/optimikelabs/optimike-obsidian-mcp.git
cd optimike-obsidian-mcp
npm install
npm run build
node dist/stdio-proxy.js
```

## Remplacement atomique gouverné d’une note

Le candidat 2.6 expose quatre outils métier :

- `obsidian_note_replace_plan`
- `obsidian_note_replace_apply`
- `obsidian_note_replace_status`
- `obsidian_note_replace_recover`

Ils ne sont enregistrés qu’en `live`, ou en `hybrid` avec API. Ils réutilisent
l’adaptateur et le journal durables de la 2.5 sans créer de second moteur ni de
surface générique `operation_*`.

Le plan scelle la cible, le binding backend et les preuves SHA-256. Apply accepte
uniquement le `planRef` opaque et la même clé d’idempotence. Après une réponse
incertaine, consulter status avant une récupération du plan exact. Recover
n’est pas un undo et n’accepte aucun nouveau payload.

La politique d’écriture MCP courante, les règles de frontmatter protégé et le
write gate de l’Atomic Write Bridge, désactivé par défaut, sont revalidés avant
tout effet. La garantie atomique couvre la transition de la note cible imposée
par `Vault.process` ; Sync, watchers, plugins, indexeurs et automatisations
externes restent hors de cette frontière de récupération.

Voir la [surface des outils](docs/obsidian_mcp_tools_spec.md#governed-atomic-note-replacement)
et la [matrice runtime](docs/runtime-capability-matrix.fr.md).

## Documents externes

Les racines externes sont désactivées par défaut. Le handoff stdio retourne un
`local_path` vérifié ; le HTTP authentifié peut retourner un `http_ticket` borné
et à usage unique. Aucun de ces modes n’autorise une mutation.

L’unique mutation externe est un move stdio local dans la même racine, avec
préconditions, journal, réparation exacte des références ÉLYSIA et rollback
compensatoire. Elle n’ajoute ni upload, création, remplacement, suppression ni
synchronisation.

## Validation

```bash
npm run build
npm run test:runtime
npm run test:operation-runtime
npm run test:governed-note-replace-mcp
npm run test:external-roots
npm run test:docs
npm run test:package
npm run audit:production
```

La CI tourne sur Linux et Windows avec des coffres jetables. Le canary Obsidian
live reste une gate opérateur explicite avant merge ou release.

Créé par **Optimike — Mickaël Ahouansou**. Licence : [LICENSE](LICENSE).
