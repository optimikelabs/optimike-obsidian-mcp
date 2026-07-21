# Bascule contrôlée d’Operon vers Kairélys

Kairélys utilise un identifiant Obsidian distinct (`kairelys`). Les tâches restent dans le Markdown
et conservent leurs `operonId`; seuls le plugin, ses réglages et son état durable changent de dossier.

## Ce qui est transféré

- `data.json` : réglages, langue, pipelines, statuts, priorités, key mappings et profils d’interface ;
- `data/` : données durables telles que les fichiers de presets Table ;
- `state/` : état durable, rappels et journaux internes nécessaires.

`runtime/` et `cache/` ne sont pas copiés. Kairélys les reconstruit depuis le coffre.

## Dry-run

```powershell
pwsh -File scripts/migrate-operon-to-kairelys.ps1 `
  -VaultPath "F:\OBSIDIAN\ÉLYSIA" `
  -KairelysBuildPath "E:\Mes Vibes Programmes\worktrees\kairelys-public-fork"
```

Le plan affiche le hash SHA-256 de `operon/data.json`. Pour l’application, réutiliser ce hash comme
précondition.

## Application

1. Désactiver Operon et vérifier que Kairélys est également désactivé.
2. Exécuter le script avec `-Apply` et `-ExpectedSourceDataSha256`.
3. Activer Kairélys.
4. Recharger `optimike-operon-bridge`.
5. Vérifier `operon_status`, puis `operon_get_configuration`.
6. Confirmer le même pipeline, les mêmes statuts, priorités, key mappings et nombre de tâches.

Le script sauvegarde tout dossier Kairélys existant dans
`.obsidian/plugins/.optimike-backups/`. Il n’active aucun plugin et refuse d’écrire si Operon ou
Kairélys est encore actif.

## Rollback

1. Désactiver Kairélys.
2. Réactiver Operon.
3. Recharger le Bridge.
4. Vérifier `operon_status` et la configuration.

Les tâches ne nécessitent aucune reconversion : leur format reste celui d’Operon. Si un retour
intervient après des modifications de réglages dans Kairélys, exporter ou recopier explicitement la
configuration voulue avant de reprendre Operon.
