---
name: elysia-task-gouverneur
description: 'Orchestre les tâches d’un coffre compatible avec le profil public ÉLYSIA Tasks via les 23 outils operon_* gouvernés : opérations ponctuelles, relations, récurrence, récupération, audits, triage, cycle de vie et santé du runtime, avec capacités live, IDs stables, dry-run et validation humaine.'
metadata:
  version: 1.3.0
  skill_structure: graph
  portability_class: profile-bound-portable
  profile_id: elysia.tasks
  profile_schema_version: 1
  mcp_namespace: operon_*
  reference_gate: true
---

# Skill — ÉLYSIA Task Gouverneur

Utilise le profil public `elysia.tasks` et la configuration live du moteur pour gérer des tâches sans écrire directement dans le Markdown.

## Quand l’utiliser

- Créer, modifier, terminer, convertir ou déplacer une tâche ; adopter seulement si le runtime annonce la capacité.
- Lire ou modifier des relations et récurrences, ou récupérer exactement une mutation incertaine.
- Auditer ou trier un backlog compatible avec le profil ÉLYSIA Tasks.
- Contrôler les filtres canoniques et le respect du propriétaire unique.
- Diagnostiquer un runtime Kairélys/Operon stale, incompatible ou incohérent.

## Invariants

- `operon_*` est le namespace MCP stable, que le moteur soit Kairélys ou Operon officiel.
- Lire `operon_get_configuration` et `operon_status` avant toute décision dépendant des pipelines, statuts, priorités, chemins ou capacités.
- Utiliser les IDs stables ; les libellés français ou anglais ne sont pas des identités.
- Ne jamais muter une tâche par regex, patch Markdown, édition YAML brute ou déplacement de fichier.
- Toute mutation d’une tâche existante passe par `expectedRevision`, `idempotencyKey`, dry-run, validation humaine, apply, relecture et `operon_validate`.
- Runtime stale/non-live, capacité absente ou référence critique inaccessible : lecture seulement.
- L’enregistrement d’un outil ne prouve ni sa capacité, ni son grant, ni un mode d’écriture suffisant.
- Suppression, rappels, pin, contrôle de timer et passthrough CLI générique restent opérateur-only.
- Une tâche appartient à un seul moteur. Ne jamais écrire en miroir dans Operon, Tasks et TaskNotes.
- Toute création ou adoption passe par [admission-p90-j.md](references/admission-p90-j.md). Un plan ou une liste n’autorise pas automatiquement la création de tâches.

## Reference Gate Map

| Intention | `module_route` | Modules obligatoires |
|---|---|---|
| Créer ou adopter | `operation-ponctuelle` | [admission-p90-j.md](references/admission-p90-j.md) + [operations-ponctuelles.md](references/operations-ponctuelles.md) + [runtime-et-mutations.md](references/runtime-et-mutations.md) |
| Modifier, terminer, lier, gérer une récurrence, convertir ou déplacer | `operation-ponctuelle` | [operations-ponctuelles.md](references/operations-ponctuelles.md) + [runtime-et-mutations.md](references/runtime-et-mutations.md) |
| Résultat incertain ou récupération | `sante-performance` | [sante-et-performance.md](references/sante-et-performance.md) + [runtime-et-mutations.md](references/runtime-et-mutations.md) |
| Audit, triage, conformité ou saved filters | `audit-triage` | [audits-et-triage.md](references/audits-et-triage.md) + [runtime-et-mutations.md](references/runtime-et-mutations.md) |
| Changement de phase d’un projet ou nettoyage de backlog | `cycle-vie-projet` | [cycle-de-vie-projet.md](references/cycle-de-vie-projet.md) + [runtime-et-mutations.md](references/runtime-et-mutations.md) |
| Cache stale, incident, incompatibilité ou lenteur | `sante-performance` | [sante-et-performance.md](references/sante-et-performance.md) + [runtime-et-mutations.md](references/runtime-et-mutations.md) |

## Routage rapide

Choisir une seule ligne de la `Reference Gate Map`, ouvrir tous ses modules, puis élargir seulement si la situation change de route.

## Profile Gate

La distribution complète contient le contrat machine-readable dans `profiles/elysia-tasks/v1/profile.json` ; depuis le dossier de cette skill, le chemin relatif est `../../v1/profile.json`.

- Pour auditer ou installer le profil, ouvrir ce fichier et comparer ses IDs à `operon_get_configuration`.
- Pour une opération ponctuelle sur un coffre déjà configuré, la configuration live et les IDs de la tâche peuvent suffire.
- Si ni le profil ni une configuration live compatible ne sont accessibles, ne pas appliquer de mutation.

## Preuve d’ouverture

Toute décision sensible renseigne `references_ouvertes` :

```yaml
- path: chemin ou ressource exacte
  type: skill_reference | public_profile | local_policy | runtime
  raison: pourquoi cette source est requise
  impact_sur_decision: ce qu'elle autorise, interdit ou précise
```

Lire seulement `SKILL.md` ne compte pas comme usage complet de la skill. Une référence obligatoire manquante impose `sortie_finale_autorisee: non` pour toute mutation.

## Workflow universel

1. Qualifier l’intention et choisir `module_route`.
2. Ouvrir les modules requis et, si pertinent, le profil public ou la politique locale du coffre.
3. Lire la configuration live, l’état du runtime et les capacités.
4. Lire la tâche ou le périmètre avec les outils `operon_*`.
5. Produire un diagnostic et, si utile, un dry-run précis.
6. Appliquer seulement après validation humaine explicite.
7. Relire, exécuter `operon_validate` et rapporter le résultat prouvé.

## Sortie

Appliquer [contrat-de-sortie.md](references/contrat-de-sortie.md) et renseigner `module_route`, `etape_pipeline_en_cours`, `references_ouvertes` et `sortie_finale_autorisee`. Une passe analytique peut conclure `apply_propose: aucun`.

## Navigation

- Runtime et mutations : [runtime-et-mutations.md](references/runtime-et-mutations.md)
- Admission P90-J : [admission-p90-j.md](references/admission-p90-j.md)
- Opérations ponctuelles : [operations-ponctuelles.md](references/operations-ponctuelles.md)
- Audits et triage : [audits-et-triage.md](references/audits-et-triage.md)
- Cycle de vie projet : [cycle-de-vie-projet.md](references/cycle-de-vie-projet.md)
- Santé et performance : [sante-et-performance.md](references/sante-et-performance.md)
- Contrat de sortie : [contrat-de-sortie.md](references/contrat-de-sortie.md)
