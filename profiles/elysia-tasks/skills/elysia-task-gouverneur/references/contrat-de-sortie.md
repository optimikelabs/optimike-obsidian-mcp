# Contrat de sortie

```yaml
module_route: operation-ponctuelle | audit-triage | cycle-vie-projet | sante-performance
etape_pipeline_en_cours: routage | lecture | dry-run | attente_apply | application | verification | termine
runtime_preflight:
  source: operon-live | operon-cache | indisponible
  stale: true | false | inconnu
  configuration_lue: true | false
  capacite_requise: nom | aucune
  capacite_disponible: true | false | non_applicable
references_ouvertes:
  - path: ressource exacte
    type: skill_reference | public_profile | local_policy | runtime
    raison: pourquoi elle était requise
    impact_sur_decision: ce qu'elle a changé ou confirmé
diagnostic:
  - constat factuel
plan_action:
  - étape classée par impact
apply_propose: aucun | liste de mutations dry-run
kpi_avant_apres: non_applicable | mesures réellement observées
next_step: action immédiate ou aucun
sortie_finale_autorisee: oui | non
```

`sortie_finale_autorisee: oui` signifie que les preuves suffisent pour la conclusion. Cela ne vaut jamais autorisation d’appliquer une mutation.

Une référence critique manquante, un runtime stale/non-live ou une capacité absente impose `sortie_finale_autorisee: non` pour toute mutation.

Après application, ajouter :

```yaml
preuve_application:
  operation_id: identifiant retourné
  relecture_effectuee: true | false
  resultat_attendu_obtenu: true | false | incertain
  operon_validate: résultat réel
  divergence: aucune | description
```

Si l’état final ne peut pas être relu, le résultat reste `incertain` et ne doit pas être retenté aveuglément.
