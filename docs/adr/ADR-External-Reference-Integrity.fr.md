# ADR — Déplacement gouverné et intégrité des références externes ÉLYSIA

- Statut : accepté et implémenté pour un pilote stdio local
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
une transaction bornée qui inventorie les références ÉLYSIA, planifie un
déplacement dans la même racine, ne répare que les références exactes, prouve le
résultat et sait revenir en arrière.

## Décision

Ajouter un workflow réservé au stdio local :

1. `external_references_scan` inventorie les références vers un fichier externe.
2. `external_move_plan` vérifie source et cible, inventorie le coffre et
   persiste un plan.
3. `external_move_status` retourne le reçu durable sans chemin physique.
4. `external_move_apply` déplace le fichier et répare conditionnellement les
   notes exactes.
5. `external_move_rollback` restaure les deux surfaces si toutes les
   préconditions tiennent encore.

Le scan et le plan sont en lecture seule. L’apply et le rollback exigent les
trois autorisations positives :

- `MCP_WRITE_MODE=full` ;
- `MCP_EXTERNAL_MOVE_ENABLED=true` ;
- la racine sélectionnée déclare la capacité `move`.

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

Seule une paire exacte token/lien dans un paragraphe Markdown actif est
réparable automatiquement. Chemins nus, tokens orphelins, paires incohérentes,
liens candidats multiples, syntaxes non supportées et références sous des
headings d’historique, archive, exemple, release notes ou changelog exigent une
revue manuelle. Toute occurrence en revue manuelle bloque l’apply.

## Transaction filesystem

Le contrat V1 est volontairement étroit :

- un seul fichier régulier ;
- source et cible dans la même racine logique et sur le même volume ;
- dossier parent cible déjà existant et réel ;
- cible absente ;
- politique include/exclude valide sur les deux chemins ;
- aucun suivi de lien ou junction ;
- taille, date de modification et SHA-256 source inchangés depuis le plan.

L’apply emploie une séquence hard-link/unlink sans écrasement : il crée le lien
cible, prouve que source et cible désignent le même objet filesystem, puis
retire la source. Un filesystem incapable de fournir ces garanties échoue fermé.

## Réparation du coffre et concurrence

Chaque réparation planifiée conserve le contenu exact avant/après et le SHA-256
attendu de la note. L’apply relit toutes les notes avant de déplacer le fichier.
L’apply et le rollback sont limités à `headless-filesystem` sur une copie ou un
coffre dédié, où la précondition de hash exacte est imposée. Local REST API
4.1.7 expose un ETag mais n’impose pas `If-Match` lors d’un remplacement de note
complète ; l’apply live échoue donc fermé avant le déplacement du fichier
externe.

Si une réparation échoue après le move, le coordinateur compense les notes déjà
modifiées et replace le fichier quand son état vérifié le permet encore.

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

La clé d’idempotence est liée à une seule requête source/cible. Rejouer un apply
ou rollback terminé retourne l’état enregistré ; réutiliser la clé pour un
autre move est refusé.

## Frontière de transport

Le proxy stdio possède la configuration des racines, le move physique et le
journal. Le backend ne fournit que recherche/lecture du coffre et remplacement
conditionnel des notes.

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

La régression doit couvrir parsing canonique, références exclues ou ambiguës,
collision cible, source modifiée, note modifiée, move sans écrasement,
compensation, rollback, journal résilient au redémarrage, refus HTTP et
non-divulgation des chemins, sous Windows et Linux lorsque pertinent.
