# Admission P90-J d’une tâche

## But

Décider si un item mérite un cycle de vie de tâche avant toute création ou adoption. Le profil est portable : la politique locale du coffre fournit les projets pivots, obligations et budgets précis.

## Trois portes

1. **Stratégique** — projet pivot, création autorisée, obligation externe, maintenance admise ou mission agentique bornée.
2. **Exécutable** — verbe et objet observables, contexte explicite, définition de fini et preuve compréhensibles.
3. **Capacité** — pas de doublon, horizon explicite et WIP local respecté ou dépassement documenté.

## Verdict

- `CREATE_INLINE`
- `CREATE_FILE`
- `ADOPT`
- `KEEP_AS_BULLET`
- `KEEP_AS_CHECKLIST`
- `KEEP_AS_NOTE`
- `REJECT_DUPLICATE`
- `DEFER_CAPACITY`

## Sortie minimale

```yaml
admission:
  verdict: ...
  justification_strategique: ...
  definition_de_fini: ...
  contexte_cible: ...
  wip_avant: ...
  wip_apres: ...
  depassement_justifie: false | raison
  preuve_attendue: ...
```

Ne jamais créer une tâche par outcome, idée, étape de SOP ou ligne de checklist. Une échéance ne sert jamais à forcer la visibilité.
