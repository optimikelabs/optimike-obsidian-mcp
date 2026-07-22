# Santé et performance

## Diagnostic

1. Relever `source`, `stale`, âge du snapshot, versions moteur/Bridge, compatibilité et capacités.
2. Appeler `operon_validate` et distinguer erreurs, avertissements et doublons.
3. Vérifier si l’incident concerne le Bridge, le moteur, l’index, le cache, une capacité, une version ou une donnée malformée.
4. Reproduire sur une lecture bornée avant d’accuser le volume global.
5. Mesurer toute affirmation de performance sur la même requête, le même périmètre et le même état de cache.

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
