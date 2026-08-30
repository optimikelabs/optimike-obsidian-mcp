# Récupération du cycle de vie des Bridges

English version: [bridge-lifecycle.md](bridge-lifecycle.md)

Optimike MCP `3.3.0` fournit un superviseur commun aux Bridges Operon, Atomic
Write et Bases. Il supprime l’ancienne fenêtre d’enregistrement limitée à
30 secondes : un Bridge peut démarrer avant Local REST API, et un client MCP
déjà connecté peut traverser un rechargement d’Obsidian ou de Local REST API
sans redémarrer.

## Contrat

- Chaque Bridge attend que l’interface Obsidian soit prête, puis sonde Local
  REST API sans date d’expiration.
- Un provider absent ou en échec est retenté avec un backoff exponentiel borné
  de 250 ms à 5 secondes. Un provider prêt est contrôlé chaque seconde.
- Chaque lifecycle possède exactement un timer récursif et une génération
  montée. Le même provider n’est jamais enregistré deux fois.
- Si le provider disparaît ou change d’identité objet, l’ancienne extension est
  désenregistrée avant de monter la nouvelle.
- Les échecs de montage ou de nettoyage sont contenus. Ils n’activent aucune
  écriture et ne modifient aucun grant Operon.
- L’arrêt ou la désactivation d’un Bridge annule son timer et désenregistre son
  extension courante.

Le Bridge Bases applique séparément ce contrat aux routes Local REST et à la
vue Bases headless optionnelle. Désactiver le moteur Bases arrête uniquement ce
lifecycle headless.

## Sémantique du statut

Les statuts des Bridges peuvent inclure :

```json
{
  "lifecycle": {
    "state": "ready",
    "running": true,
    "mountGeneration": 2,
    "unloadGeneration": 1,
    "consecutiveFailures": 0,
    "nextProbeDelayMs": 1000
  }
}
```

`state: ready` signifie uniquement que la route du Bridge est montée sur le
provider Local REST courant. Cela ne prouve ni que l’index Operon est prêt, ni
qu’un grant est approuvé, ni que les écritures sont actives. `operon_status`
conserve donc la projection du lifecycle même pendant l’initialisation
d’Operon ; les lectures et mutations gardent leurs gates de disponibilité plus
strictes.

Le champ est additif et optionnel afin qu’un MCP récent puisse encore
diagnostiquer un ancien Bridge installé. Les réglages d’écriture existants
restent les seules autorités :

- Bridge Operon : son réglage de mutation plus
  `OPERON_MUTATIONS_ENABLED=true` ;
- Bridge Atomic Write : ses réglages Note/Frontmatter et Canvas ;
- Bridge Bases : ses réglages d’écriture atomique Base et de configuration
  legacy.

## Acceptation live

La gate sur SHA exact utilise le coffre jetable Pilot 2. Elle démarre un seul
client MCP stdio, relève les trois statuts, désactive Local REST API dans le
même processus Obsidian, prouve que la connexion MCP reste vivante, réactive
Local REST API puis attend le retour des trois routes. Elle ne passe que si les
générations de montage et de nettoyage avancent, si l’index Operon redevient
live et si chaque projection d’autorisation d’écriture reste strictement
identique à son état initial. Le MCP de la canary fonctionne lui-même en
lecture seule et n’envoie aucune mutation.

```powershell
$env:OBSIDIAN_VAULT = '<chemin exact de Pilot 2>'
$env:OBSIDIAN_BASE_URL = 'http://127.0.0.1:27233'
$env:OBSIDIAN_API_KEY = '<clé Local REST API>'
$env:BRIDGE_LIFECYCLE_CANARY_CONFIRM = 'I_CONFIRM_PILOT_2_LOCAL_REST_RELOAD'
npm run smoke:bridge-lifecycle-live
```

Le script exige un worktree propre et vérifie que les bundles et manifests des
trois Bridges installés sont identiques au candidat local exact. Il écrit un
reçu JSON expurgé dans le dossier temporaire du système et affiche son chemin
exact. Après une interruption nécessitant une restauration, réactiver Local
REST API dans les Community Plugins de Pilot 2 avant tout autre test.
