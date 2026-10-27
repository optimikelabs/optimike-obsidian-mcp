# Clôture administrative et fence du Bridge au point d'effet

`obsidian_operation_close` clôt en `reviewed_unverified` une écriture gouvernée
restée `outcome_unknown`, ou lève un verrou `date_preparation_unverified`, après
revue par le propriétaire. Il n'écrit jamais de note, n'affirme jamais un succès
et ne rejoue jamais un effet.

## Pourquoi le journal seul ne suffit pas

Une requête déjà envoyée à l'Atomic Write Bridge peut encore modifier la note
après l'expiration du bail MCP et le passage du journal en `outcome_unknown`.
Marquer le journal comme clos n'exclurait donc pas un effet tardif (reproduit par
`scripts/test-effect-fence-closure.mjs`, cas 1). La clôture n'est permise que si
le Bridge lui-même prouve qu'aucune tentative de l'opération ne peut encore
atteindre son point d'effet.

## Le fence

- Le Bridge émet une **époque** à chaque chargement du plugin
  (`status.effectFence`). Un déchargement la ferme ; un redémarrage d'Obsidian
  supprime tous les traitements en cours.
- Avant l'envoi, le journal MCP inscrit de façon durable un **jeton de
  tentative** `{ epoch, attemptId }`, par un compare-and-set qui échoue dès que
  la tentative ne possède plus le plan `applying`. Un exécuteur périmé n'envoie
  donc jamais rien.
- Le Bridge admet le jeton **de façon synchrone au point d'effet** : dans le
  rappel de `vault.process` (CAS de note et de Canvas), juste avant la création
  `O_EXCL`, juste avant `renameFile`, et avant l'onglet temporaire de la
  préparation FDM. Un jeton révoqué, rejoué ou d'une époque dépassée y est
  refusé (`effect_fence_refused`, HTTP 403), sans effet.
- `POST /extensions/obsidian-atomic-write-bridge/effect-fence/resolve`
  (`mode: inspect | revoke`) rend un verdict par jeton. La révocation est
  irréversible et traitée sur le même fil JavaScript que l'admission.

| Verdict | Sens | Clôture |
| --- | --- | --- |
| `revoked_before_effect` | n'a jamais passé son point d'effet et ne le passera jamais | permise, `priorEffect: none` |
| `effect_in_progress` | a passé son point d'effet, pas encore terminé | refusée, réessayer plus tard |
| `effect_settled` | passé et terminé depuis `settledAgoMs` | permise après max(60 s, délai de datation scellé), `priorEffect: may_have_occurred` |
| `epoch_unknown` | le processus qui portait cette époque a disparu | permise, `priorEffect: unknown` |
| `not_reached` | inspection seulement : peut encore arriver | l'essai à blanc répond `would_close` |

## Tentatives envoyées sans jeton

Les plans envoyés par MCP 3.14 ou antérieur, ou à un Bridge sans fence, n'ont
pas de jeton (`effectTracking` absent, `untracked` collant, ou tentative sans
époque). Ils ne se clôturent que si le réglage du Bridge **Exiger un jeton de
fence pour toute écriture** est actif sans interruption depuis au moins
10 minutes et qu'aucune écriture sans jeton admise dans cette session
d'Obsidian n'est encore en cours (`legacy.quiescent`). À partir de là, aucune
requête sans jeton ne peut passer un point d'effet, et les anciennes versions du
Bridge chargées dans la même session ont eu le temps de finir. Le reçu indique
`priorEffect: unknown` et la preuve. Activer ce réglage refuse les écritures des
clients MCP qui n'envoient pas de jeton. L'adaptateur Canvas actuel n'envoie
pas encore de jeton : ses écritures gouvernées sont également refusées tant que
le réglage est actif. Le laisser actif : la garantie
historique tient tant qu'il reste actif, ou dès qu'aucun processus MCP d'une
version antérieure ne tourne plus (seul un tel processus pourrait encore livrer
une requête sans jeton).

## Refus (rien ne change)

`closure_bridge_unavailable`, `closure_fence_capability_missing` (Bridge sans
fence : refus fermé), `closure_binding_mismatch`,
`closure_operation_still_applying`, `closure_effect_in_progress`,
`closure_effect_settling`, `closure_legacy_requires_fence_requirement`,
`closure_legacy_quiescence_pending`, `closure_state_changed`,
`closure_operation_kind_unsupported` (Canvas, formules de Base et import
d'images gardent leurs propres journaux), `closure_not_applicable` (plan non
appliqué ou déjà terminal), `closure_plan_not_found`,
`closure_plan_ref_invalid`, `closure_path_invalid`. Avant le fence, l'outil
lance la réconciliation par status de la famille : un effet exact est rendu
`not_needed` avec `outcome: committed`.

## Reçu et conservation

La ligne close garde `administrativeClosure` : motif, version, identité et époque
du Bridge, verdict par tentative, preuve historique, `priorEffect`,
`guarantee: no_further_effect` et l'empreinte actuelle de la note (`before`,
`after` ou `neither`, jamais le contenu). Le `nextContent` scellé est effacé.
`reviewed_unverified` est terminal, sort du cockpit et n'est pas purgé par la
rétention des états terminaux stables. Un nouvel appel rend `already_closed`
avec les mêmes preuves, sans rien envoyer au Bridge.

## Verrou de préparation FDM

`date_preparation_unverified` bloque les plans sur une note après une
préparation FDM incertaine. Le verrou porte désormais le jeton de la
préparation. `datePreparationPaths` le lève selon les mêmes verdicts et conserve
la revue dans `obsidian_date_preparation_fence_reviews`.

Le verrou ne reste désormais que si la préparation a pu agir :

- Tout échec de la requête de préparation est vérifié auprès du fence. Seul le
  verdict `revoked_before_effect` prouve que cette tentative n'a jamais atteint
  son point d'effet et ne l'atteindra jamais : le verrou est levé
  aussitôt et le plan échoue avec une raison réessayable —
  `date_preparation_not_started` (note modifiée entre-temps, requête non
  arrivée), `date_preparation_fdm_pending` (voir plus bas) ou le refus d'origine
  `atomic_write_creation_property_missing`.
- Un verrou laissé parce que le Bridge ne répondait pas est levé au plan suivant
  sur la note, dès que le Bridge prouve que la tentative n'a pas démarré (elle
  est révoquée ; une préparation concurrente de la même note échoue alors avant
  tout effet et doit être replanifiée).
- Une tentative démarrée ou terminée, un verrou sans jeton ou un Bridge sans
  fence gardent `date_preparation_unverified` : revue et `datePreparationPaths`
  nécessaires.

Le travail propre de FDM n'est plus pris de vitesse. FDM 1.6.0 ouvre une fenêtre
(`delayForNewFiles`, 20 s dans ÉLYSIA) pour chaque nouveau fichier et rejoue
ensuite une passe pour toute modification faite pendant la fenêtre ; les passes
différées, de reprise et manuelles sont aussi mises en file par chemin. Avant
son point d'effet, le Bridge attend désormais que FDM n'ait plus rien en attente
pour la note (`recentlyCreated`, `newFileTimers`, `newFileModified`,
`modifyTimers`, `manualPending`, `processingFiles`, `bulkRunning`), puis relit la
note : si FDM l'a modifiée entre-temps, la préparation est refusée avant tout
effet. Si l'attente ne tient pas dans le budget de la requête (55 s), refus
`date_preparation_fdm_pending`. Les versions de FDM qui n'exposent pas ces files
gardent le comportement précédent.

Procédure manuelle si l'outil est inutilisable (Bridge sans fence, Bridge
durablement injoignable) :

1. Quitter complètement Obsidian (aucune fenêtre) et arrêter le backend MCP et
   tous les clients MCP. Cela met fin à tout traitement du Bridge et à tout
   exécuteur.
2. Lire la note sur disque et décider si son frontmatter actuel est acceptable ;
   le corriger ensuite dans Obsidian si besoin.
3. Les deux toujours arrêtés, lancer
   `node scripts/release-date-preparation-lock.mjs --journal <journal.sqlite> --list`,
   puis la même commande avec `--release <targetDigest> --confirm`. Le script
   refuse tant que le port Local REST ou celui du backend répond, et inscrit la
   revue manuelle avant de supprimer le verrou, dans une seule transaction.
4. Relancer Obsidian, puis le backend ; replanifier.

## Clôture en lot des opérations historiques

`scripts/close-pending-operations.mjs` parcourt
`obsidian_list_pending_operations` (`status: outcome_unknown`,
`closeAllowed: true`) et appelle `obsidian_operation_close` par lots de 20,
d'abord à blanc, puis réellement avec `--apply`. Il écrit chaque reçu dans un
fichier JSON et ne relance jamais automatiquement un refus.
