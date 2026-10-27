# Supervision du backend

Le backend HTTP partagé (`dist/index.js` avec `MCP_TRANSPORT_TYPE=http`) sert tous les clients d’un poste. Rien dans le dépôt ne le relance, et un backend démarré par le proxy stdio d’un client descend de ce client ou du tunnel qui a lancé le proxy. Sur un runtime de production, le backend était l’enfant du lanceur stdio d’un tunnel, ce tunnel avait demandé à s’arrêter 22 fois en un mois, et aucun composant ne relançait ensuite le backend.

[`scripts/supervise-backend.ps1`](../scripts/supervise-backend.ps1) comble cet écart. C’est un petit script PowerShell (PowerShell 7 ou Windows PowerShell 5.1) qui surveille `GET /healthz` et démarre le backend avec le lanceur que vous lui donnez, hors de tout client ou tunnel. Le dépôt n’installe ni ne planifie rien : c’est à vous de décider où et comment il tourne.

## Ce qu’il fait

- Sonde l’endpoint non authentifié `/healthz`. Après `-FailureThreshold` échecs consécutifs (2 par défaut), il démarre le backend avec `-NodePath` et `-LaunchArguments` depuis `-WorkingDirectory`, puis attend jusqu’à `-StartupGraceSeconds` (90 par défaut) que `/healthz` réponde.
- Un client qui démarre avec le lancement automatique du backend (le proxy stdio) contrôle d’abord `/healthz` et se rattache à un backend sain au lieu d’en lancer un ; une fois le backend détenu par le superviseur, les clients s’y rattachent. Rien ne change dans la configuration des clients.
- Ne touche jamais un processus qui occupe le port alors que `/healthz` échoue : il le journalise et sort avec le code 2. `-ReplaceUnhealthy` autorise son remplacement uniquement sous Windows et uniquement si c’est un processus Node dont la ligne de commande contient `-ExpectedEntryPoint` (`index.js` par défaut).
- Démarre au plus `-MaxRestartsPerHour` fois par heure (6 par défaut), puis cesse de relancer, le journalise et sort avec le code 3 : une boucle de plantage demande une personne.
- Garde un seul superviseur par port avec un verrou exclusif, et supprime les logs de processus vides des anciens lancements.
- Ne lit, n’affiche et n’écrit aucun secret. Le lanceur détient l’environnement : le superviseur exécute seulement la commande donnée.

## Paramètres

| Paramètre | Défaut | Sens |
| --- | --- | --- |
| `-WorkingDirectory` | obligatoire | dossier d’où la commande de lancement s’exécute |
| `-NodePath` | `node` | exécutable qui démarre le backend |
| `-LaunchArguments` | `launch.mjs --backend` | arguments transmis tels quels ; entourer de guillemets tout argument contenant un espace |
| `-HostName`, `-Port` | `MCP_HTTP_HOST` ou `127.0.0.1`, `MCP_HTTP_PORT` ou `3010` | adresse du backend à sonder |
| `-StateDirectory` | `<WorkingDirectory>/backend-supervisor` | `supervisor.log` (tourne à 1 Mio), `state.json`, verrou et logs de processus |
| `-IntervalSeconds` | `30` | pause entre deux sondes en mode boucle |
| `-FailureThreshold` | `2` | échecs consécutifs avant une relance |
| `-StartupGraceSeconds` | `90` | temps laissé à un backend qui démarre |
| `-HealthTimeoutSeconds` | `3` | délai d’une sonde |
| `-MaxRestartsPerHour` | `6` | budget de relances |
| `-KeepProcessLogs` | `10` | logs de processus conservés par flux |
| `-Once` | désactivé | un seul cycle puis sortie avec le code ci-dessous (pour un planificateur externe) |
| `-ReplaceUnhealthy` | désactivé | remplace un backend non sain vérifié |
| `-DryRun` | désactivé | journalise ce qui serait fait et ne démarre rien |

Codes de sortie avec `-Once` : `0` sain, ou démarré puis sain ; `1` le démarrage a échoué ; `2` le port est occupé par un processus non sain ; `3` le budget de relances est épuisé.

## Procédure

1. Essai à blanc, backend arrêté :

   ```powershell
   pwsh -NoProfile -File scripts/supervise-backend.ps1 -WorkingDirectory <racine-runtime> -Port <port> -FailureThreshold 1 -Once -DryRun -Verbose
   ```

   Le journal doit dire `starting backend` puis `dry run: backend not started`.
2. Essai réel, backend toujours arrêté : retirer `-DryRun`. Attendre `backend healthy after start`, puis contrôler `/healthz` et `/readyz` et qu’un client atteint le backend.
3. Enregistrer le superviseur, avec l’utilisateur qui détient l’environnement du lanceur (le lanceur peut lire des variables par utilisateur), une fois l’essai à blanc et l’essai réel conformes :

   ```powershell
   $action = New-ScheduledTaskAction -Execute 'pwsh.exe' -Argument '-NoProfile -WindowStyle Hidden -File "<chemin>\supervise-backend.ps1" -WorkingDirectory "<racine-runtime>" -Port <port>'
   $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
   $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
   Register-ScheduledTask -TaskName 'Backend Supervisor' -Action $action -Trigger $trigger -Settings $settings
   ```

   La tâche exécute le mode boucle : un processus de longue durée qui est aussi le parent du backend qu’il démarre. Laisser inchangée toute tâche de démarrage de tunnel ou de client existante.
4. Vérifier le chemin de relance : arrêter le processus du backend, puis lire `supervisor.log`. En environ `FailureThreshold × IntervalSeconds` plus le temps de démarrage, il montre `healthz failed (1/2)`, `healthz failed (2/2)`, `starting backend`, `backend healthy after start`.

## Exploitation

- Livrer une nouvelle release : basculer la release active, puis arrêter le processus du backend. Le superviseur le relance depuis la nouvelle release via le lanceur. Contrôler l’empreinte runtime avec `obsidian_runtime_status`.
- Arrêter la tâche du superviseur peut aussi arrêter un backend qu’il a démarré (le planificateur peut terminer tout l’arbre de processus). Le proxy stdio d’un client relance alors un backend au prochain besoin.
- Retour arrière : `Unregister-ScheduledTask -TaskName 'Backend Supervisor' -Confirm:$false`, arrêter le processus du superviseur, et supprimer `-StateDirectory` si son journal n’est plus utile.
- Lire d’abord `supervisor.log`. `restart budget exhausted` et `port ... is held by a process that fails /healthz` sont les deux états qui demandent une personne.

## Limites

- `/healthz` prouve que le processus et l’écouteur HTTP répondent. Il ne prouve pas qu’Obsidian, le cache partagé, un Bridge ou un fournisseur sémantique est prêt : utiliser `/readyz` et les outils runtime authentifiés.
- Le superviseur n’est lui-même pas supervisé au-delà des réglages de relance du planificateur.
- Le test de contrat exerce le script contre un faux backend. Il ne prouve pas le comportement d’une configuration donnée du planificateur Windows, du démarrage rapide ou de la veille ; les vérifier sur le poste cible avec l’étape 4.
