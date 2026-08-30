# ADR — Déplacement gouverné et intégrité des références externes ÉLYSIA

- Statut : accepté ; surfaces diagnostiques stdio local implémentées, mutation différée
- Périmètre : un fichier régulier dans une racine externe locale configurée
- Version anglaise : [ADR-External-Reference-Integrity.md](ADR-External-Reference-Integrity.md)
- Amende : [Racines documentaires externes](ADR-External-Document-Roots.md)
- N’amende pas : [Livraison HTTP gouvernée](ADR-HTTP-External-Artifact-Delivery.md)

## Contexte

Les racines externes exposaient initialement la découverte, les lectures
bornées, le hash et le handoff vérifié. Un harnais local sait déjà déplacer un
fichier, mais cette opération seule peut casser silencieusement les notes
Obsidian qui expliquent son rôle.

La capacité utile n’est donc pas un gestionnaire de fichiers générique. C’est
une future transaction bornée qui inventorie les références ÉLYSIA, planifie un
déplacement dans la même racine, ne répare que les références exactes, prouve le
résultat et sait revenir en arrière.

## Décision

Ajouter un workflow réservé au stdio local :

1. `external_references_scan` inventorie les références vers un fichier externe.
2. `external_move_plan` vérifie source et cible, inventorie le coffre et
   persiste un plan.
3. `external_move_status` retourne un reçu sans chemin physique. Il marque
   durablement un reçu partiel stale uniquement si le binding courant est
   prouvé ; sinon il retourne une projection sans écriture en revue manuelle.
   Les reçus legacy structurellement canoniques restent inspectables en
   status-only ; les chemins, tokens, hashes ou reasons stockés malformés sont
   entièrement redacted et ne peuvent jamais déclencher une lecture ou écriture
   backend.
4. `external_move_apply` est enregistré pour le diagnostic, mais désactivé.
5. `external_move_rollback` est enregistré pour le diagnostic, mais désactivé.

La planification de réparation des références fait volontairement partie de
`external_move_plan` ; `external_move_apply`, aujourd’hui désactivé, reste la
future frontière de continuation du même plan. Il n’existe pas d’outils séparés
`external_links_repair_plan` ou `external_links_repair_apply`, afin qu’une
implémentation auditée ne puisse pas appliquer une surface en laissant l’autre
silencieusement incohérente.

Le scan, le plan et le status sont diagnostiques/read-only. L’apply, le rollback
et toute récupération mutante automatique sont désactivés sur toutes les
plateformes jusqu’à l’existence d’une primitive native handle-relative auditée.
Le runtime retourne la raison stable
`native_handle_relative_mutation_unavailable` ; les gates d’écriture
historiques ci-dessous ne suffisent pas à activer une mutation :

- `MCP_WRITE_MODE=full` ;
- `MCP_EXTERNAL_MOVE_ENABLED=true` ;
- la racine sélectionnée déclare la capacité `move`.

La surface désactivée conserve les reçus sans chemin physique, les snapshots
SQLite privés, les contrôles de binding legacy et de session/binding stale, et
les préconditions CAS exactes comme preuves pour une future primitive auditée.

Cette capacité n’implique jamais upload, create, replace, delete ou sync.

## Identité canonique de référence

Une référence réparable automatiquement est un paragraphe Markdown contenant :

```md
[Ouvrir le brief](file:///B:/Documents/Projet/brief%20final.docx) — `external-ref:project.documents::brief%20final.docx`
```

Le lien `file:///` reste le localisateur cliquable pour l’humain. Le code inline
adjacent porte l’identité machine stable :

```text
external-ref:<rootId>::<chemin-relatif-encode-en-pourcentage>
```

Chaque segment utilise l’encodage canonique `encodeURIComponent`, tandis que
`/` sépare les segments. Les identifiants de racine suivent la grammaire logique
en minuscules de la configuration. Sont refusés : chemins absolus, traversals,
segments vides, séparateurs encodés, hôtes UNC, fragments et query strings.

Le token n’autorise pas l’accès filesystem et n’est pas un protocole URI
personnalisé. La racine configurée reste l’unique frontière d’autorisation.

Le token sérialisé ne contient que l’identité logique stable. Lors du scan et du
plan, l’enregistrement complet porte aussi le SHA-256 source, la classification
de l’occurrence et le chemin de la note source. Le hash et le chemin de note
sont des preuves mutables, pas l’identité durable ; ils ne sont donc pas
intégrés au token.

Seule une paire exacte token/lien dans un paragraphe Markdown actif est éligible
à une future réparation automatique. Chemins nus, tokens orphelins, paires
incohérentes, liens candidats multiples, syntaxes non supportées et références
sous des headings d’historique, archive, exemple, release notes ou changelog
exigent une revue manuelle. Toute occurrence en revue manuelle bloque toute
mutation future.

Le scanner utilise un AST Markdown. Les blocs de code fenced ne sont pas
parcourus et le frontmatter YAML est exclu. Un chemin libre, une propriété YAML
ou un chemin simplement placé sous une rubrique d’artefacts n’est pas promu en
référence canonique. Les chemins physiques pertinents et les autres formes non
supportées sont signalés pour revue manuelle et ne sont jamais réécrits par
supposition.

## Exigences d’une future transaction filesystem

Tout futur contrat de move audité doit rester volontairement étroit :

- un seul fichier régulier ;
- source et cible dans la même racine logique et sur le même volume ;
- dossier parent cible déjà existant et réel ;
- cible absente ;
- politique include/exclude valide sur les deux chemins ;
- aucun suivi de lien ou junction ;
- taille, date de modification et SHA-256 source inchangés depuis le plan au
  moment de l’exécution.

L’ancienne séquence hard-link/unlink est retirée et n’est plus exécutable. Une
future primitive native handle-relative devra prouver l’absence d’écrasement et
échouer fermée lorsque cette preuve est impossible.

## Réparation du coffre et concurrence

Chaque réparation planifiée conserve le contenu exact avant/après et le SHA-256
attendu de la note comme preuve future. Une implémentation auditée devra relire
toutes les notes avant tout move et réserver toute écriture avec précondition de
hash exact à `headless-filesystem` sur une copie ou un coffre dédié. Local REST
API 4.1.7 expose un ETag mais n’impose pas `If-Match` lors d’un remplacement de
note complète ; elle ne peut pas servir à une mutation externe live.

L’ancienne compensation du coordinateur est une preuve historique, pas une
capacité actuelle. Une future primitive devra définir et faire auditer sa
compensation et sa récupération après interruption avant toute activation.

## Journal et récupération

Les plans et transitions d’état vivent dans un journal SQLite local à la
machine, avec WAL et `synchronous=FULL`. Sous Windows, le défaut vit sous
`LOCALAPPDATA` ; l’opérateur devrait définir un
`MCP_EXTERNAL_MOVE_JOURNAL_PATH` absolu et privé, notamment sur les autres
plateformes.

Le journal contient les préimages de notes nécessaires à la compensation. Il
appartient donc à la même frontière locale de confiance que le coffre et ne doit
jamais être committé, partagé ou joint à un diagnostic public. Les résultats
publics exposent identifiants logiques, chemins relatifs, hashes, chemins de
notes et états, jamais les chemins physiques des racines.

La clé d’idempotence est liée à une seule requête source/cible. Rejouer
plan/status retourne le reçu enregistré ; réutiliser la clé pour un autre move
est refusé. Les routes apply et rollback désactivées ne poursuivent jamais un
plan stocké.

## Frontière de transport

Le proxy stdio possède la configuration des racines et le journal. Il n’effectue
aucun move physique. Le backend ne fournit que recherche/lecture du coffre pour
les surfaces diagnostiques.

Le HTTP direct enregistre les noms d’outils pour leur découvrabilité, mais
refuse scan, plan, status, apply et rollback. Les tickets HTTP restent des
téléchargements en lecture seule et n’autorisent jamais une mutation. Une
mutation externe distante ou multi-tenant exigerait un contrat distinct pour
l’identité, l’isolation tenant et les stockages réseau.

## Explicitement hors périmètre

- create ou replace de fichiers externes ;
- upload, y compris par ticket HTTP ;
- déplacement de dossier ou move entre racines/volumes ;
- overwrite ;
- delete, y compris une sémantique de corbeille ;
- synchronisation ;
- mutation générique cloud, lecteur mappé ou stockage réseau ;
- réparation automatique des références ambiguës ou legacy.

Ces capacités exigent une valeur ÉLYSIA démontrée et une décision séparée.

## Vérification

La régression couvre parsing canonique, références exclues ou ambiguës, collision
cible, source modifiée, note modifiée, projections de reçus stale/legacy, refus
HTTP, apply/rollback/recovery désactivés sur toutes plateformes et
non-divulgation des chemins, sous Windows et Linux lorsque pertinent. Une future
proposition de mutation devra ajouter des tests déterministes de non-écrasement,
compensation et interruption propres à sa primitive.
