# Bascule contrôlée d’Operon vers Kairélys

La première version distribuée est Kairélys `2.5.1`, basée sur Operon `2.5.0`. Kairélys `2.5.2` durcit le cycle de vie de l’API publique et les transitions terminales avec timer actif ; `2.5.3` ajoute une protection contre le remplacement concurrent du timer. Ces versions ne changent pas le format des tâches. Leurs numéros distincts évitent toute collision entre les tags et packs de langue du fork et ceux d’upstream.

Kairélys utilise un identifiant Obsidian distinct (`kairelys`). Les tâches restent dans le Markdown
et conservent leurs `operonId`; seuls le plugin, ses réglages et son état durable changent de dossier.

Les automatisations locales Obsidian ne sont pas migrées par le changement de dossier. Un script
QuickAdd, Templater ou CustomJS qui accède directement à `app.plugins.plugins.operon` doit résoudre
`kairelys` en priorité et conserver `operon` comme fallback :

```js
const plugins = app.plugins?.plugins;
const taskEngines = [plugins?.kairelys, plugins?.operon]
  .filter((plugin) => plugin?.api?.version === "1");
if (taskEngines.length !== 1) {
  throw new Error(`Un moteur de tâches V1 doit être actif, trouvé : ${taskEngines.length}.`);
}
const [taskEngine] = taskEngines;
```

Les commandes MCP restent dans le namespace stable `operon_*`. L’automatisation refuse donc le
double chargement, comme le Bridge, au lieu de choisir silencieusement le premier moteur.

## Ce qui est transféré

- `data.json` : réglages, langue, pipelines, statuts, priorités, key mappings et profils d’interface ;
- `data/` : données durables telles que les fichiers de presets Table ;
- `state/` : état durable, rappels et journaux internes nécessaires.

L’index de `runtime/` et `cache/` ne sont pas copiés. Kairélys les reconstruit depuis le coffre. Le script peut toutefois préinstaller le pack de langue généré par le build exact afin que la première ouverture reste localisée avant la publication du tag GitHub.

## Dry-run

```powershell
pwsh -File scripts/migrate-operon-to-kairelys.ps1 `
  -VaultPath "F:\OBSIDIAN\ÉLYSIA" `
  -KairelysBuildPath "E:\Mes Vibes Programmes\worktrees\kairelys-public-fork"
```

Le plan affiche le hash SHA-256 de `operon/data.json`. Pour l’application, réutiliser ce hash comme
précondition. Le dossier de build doit rester extérieur à `.obsidian/plugins/kairelys`, car la cible
existante peut être déplacée vers la sauvegarde pendant l’application.

## Application

1. Désactiver Operon et vérifier que Kairélys est également désactivé.
2. Exécuter le script avec `-Apply` et `-ExpectedSourceDataSha256`.
3. Activer Kairélys.
4. Recharger `optimike-operon-bridge`.
5. Vérifier `operon_status`, puis `operon_get_configuration`.
6. Confirmer le même pipeline, les mêmes statuts, priorités, key mappings et nombre de tâches.
7. Recharger les plugins d’automatisation concernés et tester une capture sans dépendre d’un libellé visible.

Le script sauvegarde tout dossier Kairélys existant dans
`.obsidian/plugins/.optimike-backups/`. Il n’active aucun plugin et refuse d’écrire si Operon ou
Kairélys est encore actif.

## Rollback

Quand Operon officiel expose l’API publique V1 compatible, préparer son build ou son dossier de release,
puis exécuter d’abord le retour en dry-run :

```powershell
pwsh -File scripts/migrate-kairelys-to-operon.ps1 `
  -VaultPath "F:\OBSIDIAN\ÉLYSIA" `
  -OperonBuildPath "C:\chemin\vers\operon-officiel"
```

Le plan retourne le hash SHA-256 de `kairelys/data.json`. Pour appliquer :

Le dossier de build officiel doit rester extérieur à `.obsidian/plugins/operon` ; le dry-run expose
`buildPathSafeForApply` et l’application refuse une source située dans la cible qu’elle remplace.

1. Désactiver Kairélys et vérifier qu’Operon est également désactivé.
2. Relancer le script avec `-Apply` et `-ExpectedSourceDataSha256`.
3. Activer Operon.
4. Recharger le Bridge.
5. Recharger les plugins d’automatisation concernés ; le fallback `operon` doit reprendre sans modifier les scripts.
6. Vérifier `operon_status`, `operon_get_configuration`, `operon_validate`, le nombre de tâches et la signature des réglages.

Le script sauvegarde tout dossier Operon existant dans `.obsidian/plugins/.optimike-backups/`,
transfère les réglages et états durables modifiés sous Kairélys, et laisse `runtime/` ainsi que `cache/`
être reconstruits. Les tâches ne nécessitent aucune reconversion : leur Markdown et leurs `operonId`
restent inchangés.
