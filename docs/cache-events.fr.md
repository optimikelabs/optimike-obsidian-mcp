# Cache du coffre assisté par événements — option explicite

Le candidat ajoute `OBSIDIAN_CACHE_EVENTS_ENABLED=true` pour les runtimes live et
hybrid disposant du service REST. L’option est désactivée par défaut ; aucun
plugin installé n’est mis à niveau. Local REST 5.3.1 est la cible étudiée, pas une
certification du runtime réel. Un hôte ancien conserve le cache périodique avec
le diagnostic événementiel `unsupported`. Aucun abonnement en mode headless.

Une instance de cache partage quatre abonnements authentifiés : création,
modification, suppression et renommage. Les sessions MCP n’en créent pas chacune
une copie. Le client REST existant est utilisé, sans deuxième MCP ni obligation
d’activer les URL signées. L’origine et le chemin de l’URL reçue sont vérifiés ;
les paramètres signés sont retirés et les redirections refusées.

## Contrat

Les événements sont des indications de relecture, pas du contenu de référence ni
une preuve de mutation. Corps, frontmatter, liens et identifiants bruts sont
éliminés avant la file de chemins. Le compteur amont est global et attribué avant
filtrage : ses sauts ne déclenchent pas de scan, et aucun replay Last-Event-ID
n’est supposé.

Connexion initiale, reconnexion, nouvel epoch, changement de dossier, saturation
ou traitement échoué demandent une réconciliation regroupée. Celle-ci relit les
fichiers Markdown sélectionnés même si leur taille et leur mtime sont identiques.
L’inventaire périodique de dix minutes est conservé ; ses passes ordinaires
restent fondées sur mtime/taille. Aucun instantané globalement atomique n’est
promis.

Scans et écritures du cache sont sérialisés ; les événements reçus pendant un
scan restent à traiter. Un inventaire incomplet n’autorise pas à purger un
sous-dossier du cache comme s’il était vide. REST et filesystem appliquent les
mêmes exclusions. En mode auto, les mises à jour ponctuelles choisissent la même
source que l’inventaire. Les liens filesystem statiques hors coffre sont refusés.

Avec une source filesystem, le endpoint REST doit observer le coffre voulu pour
fournir des indications utiles. L’API ne prouve pas cette identité ; un changement
non encore observé par Obsidian dépend toujours de la réconciliation. Aucun
payload événementiel n’est écrit directement comme contenu de note.

## Bornes et observation

Quatre streams, 512 chemins en attente au maximum, 32 mises à jour par passage ;
la file de sérialisation du cache est bornée à 1024 travaux. La saturation marque
l’incertitude et demande une réconciliation. Handshake : cinq secondes ; absence
de données : 45 secondes ; reconnexions : attente exponentielle de une à
60 secondes ; réconciliations espacées d’au moins cinq secondes. L’arrêt ferme
les streams et termine les travaux possédés avant de fermer SQLite.

Le parseur `eventsource-parser` 4.1.1 est figé avec une limite de 262144 caractères.
Les erreurs de forme ou de taille sont explicites. Le statut runtime ne publie
que des états et compteurs autorisés : aucun chemin de note, contenu ou URL signée.

`reconciledAndConnected` signifie : dernière réconciliation demandée réussie,
quatre streams connectés et file connue vide. Ce n’est pas une preuve d’absence
de perte amont. `freshness: observed` décrit une observation, pas une fraîcheur
continue. Les p50/p95 portent sur au plus 128 mesures réception→cache vérifié,
pas sur le délai édition humaine→réponse du modèle. L’index sémantique et les
reçus de mutations gouvernées restent indépendants.

## Tests et retour arrière

    npm ci
    npm run test:cache-events
    npm run test:log-privacy
    npm run test:profiles
    npm run test:runtime

La CI dédiée couvre Windows/Linux et Node 22/24. Les fixtures utilisent de vrais
sockets HTTP, l’adaptateur de production et SQLite, pas Obsidian Desktop. Une
fixture de préparation a observé 57 ms en p50 et 61 ms en p95 sur cinq mises à
jour ; ce n’est ni un SLO ni une mesure de production.

Les essais Desktop 5.3.1, fenêtre masquée, coffre représentatif, identité des
sources et transports clients réels restent des gates distincts. Pour revenir
au comportement périodique, désactiver l’option puis redémarrer le candidat :
aucune migration de notes, suppression d’index ou modification de grants/reçus.
