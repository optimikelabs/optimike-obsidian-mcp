# Bundle des Bridges, mise à niveau et rollback

Optimike MCP `3.5.0` livre un bundle unique pour les trois Bridges Obsidian :

- `optimike-operon-bridge` ;
- `obsidian-atomic-write-bridge` ;
- `obsidian-bases-bridge`.

Ce bundle modifie uniquement la livraison. Il n’ajoute aucun outil MCP,
n’accorde aucune capacité, n’active aucun write gate et ne modifie aucune note.

## Assets de release

Chaque release publie trois assets concordants :

```text
optimike-bridge-bundle-v<version>.zip
optimike-bridge-bundle-v<version>.manifest.json
SHA256SUMS
```

Le manifeste est généré depuis un worktree entièrement propre, sans entrée
source non suivie et non ignorée. Il lie le bundle au commit Git complet de 40 caractères, à la version du MCP, aux
ID/versions des Bridges et au SHA-256 avec la taille de chaque fichier.
L’installateur accepte uniquement `main.js`, `manifest.json` et un éventuel
`styles.css` par Bridge. `data.json`, tout fichier inconnu, lien, jonction ou
hardlink dans le bundle sont refusés avant le staging.

## Mise à niveau sous Windows

1. Télécharger le zip et `SHA256SUMS` depuis la même GitHub Release.
2. Vérifier le checksum du zip, puis l’extraire hors du coffre.
3. Fermer complètement Obsidian.
4. Exécuter le wrapper PowerShell inclus avec le commit affiché par la release :

```powershell
pwsh -NoProfile -File .\install-bridge-bundle.ps1 `
  -Mode install `
  -VaultPath "C:\chemin\du\coffre" `
  -BundlePath "$PWD" `
  -ExpectedCommit "<commit de release sur 40 caractères>" `
  -ConfirmObsidianClosed
```

L’installateur valide le bundle entier avant de prendre son verrou de
transaction dans le coffre. Il stage le candidat sous `.obsidian/plugins`,
écrit un backup privé dans le dossier d’état du système, puis remplace seulement
les trois noms de fichiers de code gérés. Les `data.json`, grants, write gates
et fichiers inconnus existants ne sont ni inclus dans la release ni écrasés.

Après redémarrage d’Obsidian, appeler `obsidian_runtime_status`. Le doctor doit
annoncer les trois Bridges disponibles avec les versions attendues ;
l’autorisation et la capacité d’écriture restent des décisions séparées.

## Rollback

Le reçu d’installation affiche son `backupPath` privé. Fermer à nouveau
Obsidian puis exécuter :

```powershell
pwsh -NoProfile -File .\install-bridge-bundle.ps1 `
  -Mode rollback `
  -VaultPath "C:\chemin\du\coffre" `
  -BackupPath "<backupPath privé du reçu>" `
  -ConfirmObsidianClosed
```

Le rollback est clôturé : il ne s’exécute que si les fichiers gérés installés
correspondent encore au bundle du reçu. Une modification manuelle ou tierce
ultérieure n’est pas écrasée. Les anciens octets et les absences de fichiers
sont restaurés exactement ; `data.json` reste intact.

Si l’installation échoue après un premier remplacement, le même backup sert au
rollback automatique. Un second échec conserve le backup dans l’état
`manual_recovery_required` et affiche son unique chemin de récupération. Ne pas
relancer l’installation avant d’avoir inspecté ce reçu.

Un arrêt brutal de l’installateur laisse un reçu `applying` et son verrou de
transaction. Le rollback associé à ce backup exact ne peut reprendre le verrou
qu’une fois son processus déclaré mort ; le mélange d’octets candidat/antérieur
est alors restauré de façon reprenable. Un rollback lui-même interrompu repart
depuis `rollback_in_progress` sans affaiblir la clôture contre une modification
tierce.

## Gate de release

`npm run package:bridge-bundle` construit les trois Bridges, crée le manifeste
du commit exact et émet les assets sous `out/bridge-release`. La commande refuse
toute modification suivie ou non suivie et non ignorée. La CI exécute les tests transactionnels sous Windows et
Linux. L’admission de release exige aussi un cycle exact-SHA dans Pilot 2 :

```text
attester Pilot 2 fermé → upgrade → redémarrer → doctor
                       → fermer → rollback → vérifier les hashes
                       → réinstaller le candidat → redémarrer → doctor → nettoyer le backup de test
```

Le canary ne modifie aucune note. Son autorité de restauration repose sur les
hashes initiaux des fichiers gérés et sur l’invariance de chaque `data.json`
présent au démarrage. En cas d’échec, il restaure ces octets et laisse Pilot 2
fermé : la politique de grants de l’API développeur Operon n’observe donc jamais
une version de Bridge volontairement rétrogradée.
