# Doctor des capacités runtime

Version anglaise : [capability-doctor.md](capability-doctor.md)

`obsidian_runtime_status` est la surface diagnostique canonique unique du
processus Optimike MCP actif. Elle conserve le statut runtime redacted existant
et ajoute `capabilityManifest`, un contrat JSON versionné. Aucun nouvel outil
MCP n’est ajouté.

Utilisez-la lorsqu’un outil est absent, qu’un Bridge est froid, qu’Operon semble
en lecture seule ou qu’une requête HTTP a été refusée par l’admission. Le doctor
observe seulement : il ne répare pas le runtime, n’accorde aucune capacité, ne
démarre aucun plugin et ne modifie pas le coffre.

## Contrat

Le premier contrat public est `capabilityManifest.contractVersion: 1`. Chaque
capacité expose trois faits indépendants :

- `discoverable` : au moins un outil préféré de la capacité est présent dans le
  profil MCP actif et dans l’instance serveur concrète ;
- `available` : le contrat backend requis est actuellement utilisable ;
- `authorized` : les identifiants, le switch du Bridge ou le grant Operon
  courant autorisent la capacité.

Ces booléens ne doivent pas être fusionnés. Par exemple, une mutation Operon
peut être découvrable et techniquement disponible avec `authorized: false`
tant que son grant Developer API reste en attente. Un Bridge Canvas sain peut
aussi être disponible et autorisé avec `discoverable: false` dans le profil
`standard`.

Chaque entrée fournit également :

- `state` : `ready`, `degraded`, `blocked`, `unavailable` ou `hidden` ;
- `reasonCode` : une cause machine fermée et stable ;
- `nextAction` : un code d’action sûre fermé ;
- `preferredTools` : des noms d’outils canoniques bornés, jamais des données du
  caller ou du backend.

Le manifeste couvre Local REST, les lectures du coffre, la recherche
sémantique, les lifecycles gouvernés Note, Frontmatter, Canvas et Base, ainsi
que les lectures et écritures Operon. La recherche sémantique n’est utilisable
que si son runtime d’index et l’embedder de requête sont tous deux activés.
`semantic_query_embedding_disabled` signale donc un switch
`ENABLE_QUERY_EMBEDDING` volontairement coupé au lieu d’annoncer l’outil prêt.
Les lectures issues du cache Operon sont
signalées `degraded` avec `operon_snapshot_fallback` ; un snapshot n’est jamais
présenté comme preuve qu’une mutation peut s’exécuter ou a été appliquée.

`operon-write.operations` projette séparément chaque route publique de
mutation. `operon_mutations_disabled` signifie que le switch d’écriture du
Bridge est coupé. `mcp_operon_mutations_disabled` signifie que l’opt-in apply
séparé du MCP reste coupé, tandis que `write_policy_blocked` et
`operation_policy_blocked` préservent la frontière globale ou propre à
l’opération de `MCP_WRITE_MODE`. Les dry-runs peuvent rester disponibles sans
faire croire qu’apply est autorisé. La même frontière `write_policy_blocked`
s’applique aux écritures gouvernées Note, Frontmatter, Canvas et Base.
`operon_duplicate_conflicts` rend les lectures et écritures Operon
indisponibles jusqu’à résolution des identités dupliquées.
`operon_capability_not_advertised` signifie
que le dernier
snapshot de statut n’annonce pas cette opération exacte ; l’étape sûre consiste
à appeler son chemin exact de dry-run/plan afin qu’Operon ne négocie que cette
capacité. Le doctor ne demande pas lui-même le grant. Un mélange d’opérations
annoncées et froides devient `operon_partial_capabilities`, jamais une
autorisation globale d’écriture.

## Profil, runtime et autorisation restent séparés

Le doctor distingue trois causes courantes d’absence :

| Cause                                                                       | `reasonCode`               | Action sûre           |
| --------------------------------------------------------------------------- | -------------------------- | --------------------- |
| Le profil sélectionné masque volontairement la famille                      | `profile_hidden`           | `switch_tool_profile` |
| Le mode runtime ne peut pas héberger la famille                             | `runtime_mode_unavailable` | `use_live_runtime`    |
| Le mode et le profil l’autorisent, mais son runtime ne s’est pas initialisé | `runtime_not_initialized`  | `restart_mcp_runtime` |

Un catalogue de profil statique ne peut donc pas déclarer qu’un outil gouverné
est découvrable lorsque le runtime du Bridge correspondant n’a pas réellement
été monté.

## Probes live bornés

Un appel de statut sonde en parallèle Local REST, Atomic Write, Bases Atomic et
Operon. Chaque probe possède un timeout de requête de 2,5 secondes. Un échec est
projeté vers un état fermé ; les erreurs HTTP brutes, payloads backend et
messages d’exception n’entrent jamais dans le manifeste.

La projection de l’admission HTTP contient uniquement des compteurs agrégés.
`pressured` signifie que le processus courant a observé une mise en file, un
refus, un timeout ou une annulation. Si la requête du doctor ne peut elle-même
être admise, l’erreur publique d’admission fait foi : réessayer après le délai
borné annoncé.

## Frontière de confidentialité

Le doctor ne retourne jamais :

- les chemins du coffre ou des journaux ;
- les URL Local REST ou Bridge ;
- les clés API, headers d’autorisation, binding fingerprints ou hashes de
  configuration ;
- le contenu des notes, Frontmatter, Bases, Canvas, tâches ou erreurs ;
- les diagnostics Bridge bruts ou messages d’exception bruts.

Le contrat est testé par la projection pure, un véritable appel MCP en mémoire,
les routes HTTP immuables par profil et des fixtures de timeout. Exécuter :

```bash
npm run test:capability-doctor
```

Le canary de release reste en lecture seule mais doit viser le coffre jetable
Pilot 2. Il démarre le candidat exact, appelle le doctor via `standard`,
`authoring`, `tasks` et `full`, vérifie les trois Bridges ainsi qu’Operon, écrit
une preuve JSON redacted dans le dossier temporaire de l’OS et consigne
`vaultMutations: 0` :

```bash
CAPABILITY_DOCTOR_CANARY_CONFIRM=I_UNDERSTAND_THIS_IS_A_READ_ONLY_PILOT_2_CANARY \
OBSIDIAN_API_KEY=... \
OBSIDIAN_BASE_URL=http://127.0.0.1:... \
OBSIDIAN_VAULT=/chemin/absolu/vers/pilot-2 \
npm run smoke:capability-doctor-live
```

Autorités liées : [Profils de surface d’outils](tool-surface-profiles.fr.md),
[Matrice des capacités](runtime-capability-matrix.fr.md),
[Récupération du lifecycle](bridge-lifecycle.fr.md) et
[Exploitation](../OPERATIONS.fr.md).
