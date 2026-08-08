# Santé et performance

## Diagnostic

1. Relever `source`, `stale`, âge du snapshot, versions moteur/Bridge, compatibilité et capacités.
2. Appeler `operon_get_diagnostics`, puis `operon_validate`, et distinguer lifecycle, grant, transport, erreurs, avertissements et doublons.
3. Distinguer outil non chargé, capacité absente, grant absent, mode d’écriture insuffisant, Bridge, moteur, index, cache, version ou donnée malformée.
4. Reproduire sur une lecture bornée avant d’accuser le volume global.
5. Mesurer toute affirmation de performance sur la même requête, le même périmètre et le même état de cache.
6. Pour une mutation incertaine, appeler `operon_list_pending_recoveries` avant toute nouvelle écriture et ne récupérer que le même plan en mode `full` après validation humaine.

## Documentation publique utile

- `docs/operon-local-validation.md`
- `docs/operon-mcp-contract.md`
- `docs/kairelys-cutover.fr.md`
- `plugins/obsidian-operon-bridge/README.md`

Les versions réellement chargées viennent du runtime, pas d’une documentation statique.

## Garde-fous

- Runtime stale/non-live : diagnostic seulement.
- Une validation sans violation ne prouve pas la performance.
- Ne pas réindexer, réinstaller ou effectuer un rollback sans sauvegarde et validation explicite.
- Après correction, rejouer le même test et rapporter le delta mesuré.
- L’état du timer est lisible ; son contrôle reste opérateur-only.
- Ne jamais retenter une mutation incertaine avec un nouveau plan.
