# Prompt autonome — qualification et promotion M2 → M6 dans Codex

Reprends le dépôt `optimikelabs/optimike-obsidian-mcp` depuis ses sources vivantes. Termine en une session la qualification locale, les corrections nécessaires et la promotion séquentielle du cycle. Ne réécris pas les fonctionnalités déjà présentes et ne te fie pas au souvenir du chat.

## Autorité et autorisation

Lire les AGENTS.md applicables, puis ce dossier, les contrats et les PR. Utiliser Optimike Obsidian — ÉLYSIA Full pour les sources locales si disponible, y compris ses racines externes ; sinon utiliser les fichiers réellement accessibles. Ne pas inventer un accès Desktop. Le mandat autorise branches, corrections, commits, CI, reviews et merges **après** leurs gates. Aucun merge d’une milestone REWORK/NO_GO. Aucune écriture de test dans de vraies notes ÉLYSIA.

`cycle.json` recense les branches, PR et SHA connus. Il s’agit d’un snapshot de préparation : ses NOT_RUN ne sont pas des échecs ni une validation locale. Les refs GitHub actuelles, le code, les CI et les reviews priment. Conserver les résultats exécutés dans les preuves de PR, sans fabriquer un SHA autoréférencé dans un fichier versionné.

La stack attendue est #92 M2 → #94 M3 → #95 M4 → #96 M5 → #97 M6. #93 porte seulement le lock sécurité et est déjà incluse dans la stack. Vérifier cet état, les parents et les diffs ; ne pas supposer que les bases des PR sont encore identiques au snapshot.

## 1. Préflight et préservation de M1

Inspecter les worktrees et modifications locales ; ne jamais écraser un travail non committé. Récupérer les branches distantes et noter les HEAD exacts. Lire les dernières reviews, y compris les commentaires du bot après les soumissions de review ; vérifier quel SHA a été relu. Un workflow réussi sur un ancien commit ne valide pas une nouvelle tête.

Identifier Pilot2, sa racine réelle, son Obsidian Desktop et ses plugins. Vérifier que ce coffre est jetable, séparé d’ÉLYSIA, non aliasé par symlink/junction, et que le raccord de test pointe vers lui. Archiver l’état des fixtures, settings et artefacts installés avant tout changement ; placer les preuves et backups hors du coffre et hors du worktree attesté. Ne jamais publier clés REST, journaux privés, contenu utilisateur ou chemins personnels dans GitHub.

**M1 est déjà corrigée et déployée localement selon le diagnostic opérateur.** Cela ne prouve pas que main ou les candidats contiennent son correctif. Avant de remplacer un raccord, identifier la source exacte backend + proxy installés, le marqueur `mcp_session_invalid` et le mécanisme de reconnexion unique. Conserver le rollback. Si le candidat ne contient pas ce correctif, porter le correctif existant de façon minimale et testée, sans le réimplémenter ni rouvrir l’architecture. Aucun déploiement qui réintroduirait le 404 générique, le replay d’une mutation incertaine ou une confusion avec un NOT_FOUND métier.

Les dépendances MCP de test doivent être isolées de la production. Ne pas exposer un nouveau serveur public, modifier des secrets ou relâcher des permissions pour faire passer un test.

## 2. Preuves repository avant les tests Desktop

Travailler sur le candidat exact dans un worktree propre. Node doit respecter `package.json`. Installer les dépendances racine et celles des trois Bridges. Relancer les gates affectées et inspecter la CI Windows/Linux, les manifests, le catalogue, le package et l’audit production. À la tête M6 complète, les commandes suivantes existent ; sur une milestone antérieure, utiliser seulement ses commandes présentes et ne pas considérer l’absence d’une commande future comme un échec :

```powershell
function Invoke-Checked([scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "Échec d'une commande native ($LASTEXITCODE)." }
}
Invoke-Checked { npm ci }
Invoke-Checked { npm --prefix plugins/obsidian-atomic-write-bridge ci }
Invoke-Checked { npm --prefix plugins/obsidian-bases-bridge ci }
Invoke-Checked { npm --prefix plugins/obsidian-operon-bridge ci }
Invoke-Checked { npm run test:cycle }
Invoke-Checked { npm run test:note-links }
Invoke-Checked { npm run test:native-note-move }
Invoke-Checked { node scripts/test-note-create-m4.mjs }
Invoke-Checked { node scripts/test-note-create-review-m4.mjs }
Invoke-Checked { node scripts/test-note-create-surface.mjs }
Invoke-Checked { npm run test:base-rows }
Invoke-Checked { npm run test:operation-runtime }
Invoke-Checked { npm run test:profiles }
Invoke-Checked { npm run test:tool-annotations }
Invoke-Checked { npm run test:docs }
Invoke-Checked { npm run test:bridge-lifecycle }
Invoke-Checked { npm run audit:production }
Invoke-Checked { npm run build:bridges }
Invoke-Checked { npm run test:cycle:package }
```

Le contrôle `test:cycle` vérifie les sources ; sa sortie `releaseAuthorized:false` est intentionnelle. Le manifeste doit conserver exactement les cinq marqueurs finaux obligatoires (qualification locale ordonnée, préservation M1, SHA installé, lecture Secure, alignement main/tag/release) : une clé absente est un échec, jamais un gate implicitement satisfait. Les tests hermétiques et leurs fixtures ne sont jamais des canaries Desktop.

Le build de bundle exige un worktree propre, fichiers non suivis compris. Lire `scripts/build-bridge-bundle.mjs` et l’installateur avant usage. Construire le bundle depuis le SHA exact, fermer l’Obsidian du coffre jetable pour installer, et fournir `-ExpectedCommit` ainsi que `-ConfirmObsidianClosed`. Déterminer `-VaultPath`, `-BundlePath` et `-BackupRoot` depuis les artefacts réels : ne pas reprendre un chemin présumé du chat. Ne pas activer de grant dans la production pour qualifier Pilot2.

## 3. M2 — note links, strictement readonly

Sur #92, retrouver le corpus GQM26 et ses preuves. S’il manque, créer un corpus jetable explicitement identifié comme équivalent, sans prétendre avoir relu l’original. Utiliser des noms déterministes mais isolés par run. L’instrumentation de création/restauration des fixtures est distincte de l’appel readonly à qualifier.

Exercer `obsidian_note_links` sur wikilink, display alias, alias de frontmatter, Markdown relatif, homonymes dans deux dossiers, embed fichier/note, lien YAML, lien interne à la même note, heading valide/invalide, block ID valide/invalide, unresolved et backlinks multiples. Comparer aux résolutions observées dans Desktop, pas à des chaînes reconstruites par un script indépendant.

Tester limite/troncature, tri stable avec accents, absence de cache et fraîcheur inconnue. Ne jamais traduire un cache absent en zéro lien. Confirmer par hashes que les appels qualifiés n’écrivent aucun fichier du coffre. Relire après indexation, sans qualifier un premier état transitoire de vérité définitive.

## 4. M3 — move natif et postflight séparé

Sur #94, lire `docs/native-note-move-m3.md` et les tests. L’opération passe par `FileManager.renameFile`, jamais par une réparation manuelle des wikilinks. Activer seulement le grant de move du Bridge de Pilot2 et la politique requise.

Exercer plan/apply/status : nominal, destination occupée, collision apparue après plan, source modifiée, deux demandes concurrentes, préférence update-links ON puis OFF, préférence modifiée entre plan/apply, homonymes, liens relatifs, unresolved devenant resolved et cache retardé. Vérifier source/destination, liens entrants/sortants observés et les fichiers collatéraux réellement touchés.

Un move `committed` n’est pas un `graphPostflight:verified`. Exiger les barrières/répétitions stables prévues ; un timeout reste pending/indeterminate/failed selon les preuves, jamais « préservé » par défaut. La portée reste le voisinage scellé, pas tout le coffre.

Avec un proxy de test isolé, perdre une réponse avant/après effet et avant/après conflit ; vérifier status, identité de binding après nouvelle génération, non-rejeu et absence de doublon. Qualifier aussi la rétention des acknowledgements après plusieurs opérations. L’expiration d’une preuve backend ne devient pas une preuve d’absence d’effet.

Tester un éditeur ouvert si l’environnement permet un scénario discriminant. Si ce cas n’est pas qualifié, le laisser NOT_EXERCISED avec sa restriction réelle ; ne pas le compter comme PASS ni promouvoir une promesse qui dépend de ce cas.

## 5. M4 — création durable exclusive

Sur #95, lire `docs/durable-note-create-m4.md`. L’effet crée un seul chemin absent, sans overwrite ni suffixe automatique. Vérifier nominal, cible existante, concurrence, même clé/même intention, même clé/autre contenu, politique changée après plan, mauvais coffre/binding et perte de réponse suivie d’un redémarrage. Statut/replay ne doivent pas recréer une note incertaine.

Tester des clés protégées configurées, y compris YAML cité, casse différente et merge YAML. Elles doivent être refusées avant toute création, également si la politique a changé entre plan/apply.

Inclure un champ de date automatique dont le nom est protégé mais absent du YAML soumis : le plan puis l’apply doivent rester autorisés, car le champ qualifié est écrit par le Bridge et non par l’appelant. Le même résultat est attendu si ce champ absent devient protégé entre plan et apply. Vérifier séparément qu’une clé protégée réellement fournie par l’appelant dans le YAML est refusée avant dispatch. Pendant un rolling upgrade, un Bridge 0.8.0 antérieur pouvant encore renvoyer `policyDigest` sur inspect doit rester lisible ; ce champ legacy ne doit influencer ni l'identité ni la réconciliation.

Avec les plugins réellement installés et reconnus, vérifier les champs créés/modifiés, délais, noms personnalisés dont l’ordre alphabétique diffère de l’ordre d’insertion, insertion entre propriétés et CRLF. Un timestamp tardif hors fenêtre ou une modification de corps ne doit pas être absorbé par le settlement. Reprendre après un délai supérieur à cinq minutes : un timestamp légitime initial doit rester vérifiable sans redispatch. L’attribution de l’auteur reste `not_proven` lors d’une simple réconciliation d’état.

Après une création effectivement réussie dont la réponse est perdue, changer/désactiver le plugin de dates ou changer l’offset UTC avant le status. Après la fenêtre de settlement scellée, des octets exactement égaux au contenu planifié doivent réconcilier l’opération sans redispatch ; la politique courante ne doit pas devenir une identité historique de l’effet.

Vérifier séparément l’apparition dans le cache et l’UI Obsidian : l’écriture fsync exclusive ne certifie pas l’indexation. Une divergence de plugin ou d’éditeur non couverte entraîne correction/restriction, pas une tolérance générique sur les octets.

## 6. M5 / P7 — une row existante, pas un nouveau modèle de données

Sur #96, lire `docs/base-row-patch-m5.md`. Créer une Base et une vue de test explicite sur des notes jetables. Appeler `bases_rows_patch_plan/apply/status` avec `baseId`, `view` et le chemin exact de la note.

Vérifier set/delete de propriétés brutes, suppression d’une propriété sans suppression du fichier, préservation du corps et des autres propriétés, clés protégées/computed/file/formula refusées, homonymes, vue ambiguë, sélection tronquée, filtre non pris en charge et warning : refus sans mutation.

Changer la Base, la note ou la sélection après plan ; vérifier le conflit approprié. Exercer réponse perdue, reprise, deux processus et absence de second apply d’un enfant déjà tenté. Vérifier le cockpit et ses prochaines actions : pas de faux recover exposé. Une propriété modifiée peut faire sortir la note de la vue ; status vérifie l’effet sur la note, pas son appartenance ultérieure.

Vérifier aussi la négociation de capacité : un Bases Bridge 1.2.1 ou une version inconnue/prerelease sans preuve équivalente ne doit pas annoncer `governed-base-rows` comme disponible ; le Bridge candidat 1.2.2 doit l’annoncer lorsque ses autres gates sont prêts.

La sélection gouvernée doit passer par la route qualifiée `/extensions/obsidian-bases-bridge/bases/:id/query`, pas par l'alias legacy `/bases/:id/query`. Vérifier qu'un handler legacy concurrent/shadow ne peut pas fournir la réponse attestée par la capability du Bridge qualifié.

La sélection est un snapshot du sous-ensemble de filtres du Bridge, fraîcheur inconnue ; comparer à la vue réelle. Le guard Base et le CAS note ne sont pas une transaction. Les tests insert/delete-note/batch/partials multi-cibles sont NOT_APPLICABLE à cette V1, pas des PASS.

## 7. Gates et promotion séquentielle

Pour chaque scénario, conserver : SHA source, versions/identité du coffre de test, préconditions et hashes, demande/receipt expurgés, effet observé, postflight, restauration, verdict PASS/FAIL/NOT_EXERCISED et preuve précise. Distinguer un résultat de test d’une analyse. Ne pas supprimer une fixture modifiée par un autre acteur sous prétexte de rollback ; isoler et signaler le drift.

Avant chaque merge : CI exacte Windows/Linux verte, findings matériels corrigés, review du SHA candidat et gate local conforme à la portée. #93 peut être admise d’abord si ses propres gates restent verts ; préserver l’intégration déjà présente pour éviter les doubles changements de lock.

Puis M2 → merge ; réaligner/rebaser M3 sur le main admis → gates → merge ; idem M4 puis M5 ; enfin M6. Une seule session Codex, pas une seule fusion globale. Après tout rebase/cherry-pick/correction, revalider le nouveau SHA. Les résultats d’un ancien candidat ne certifient pas automatiquement une nouvelle combinaison. Ne jamais forcer un push qui détruirait un changement concurrent ; utiliser des refs exactes et vérifier le distant après chaque écriture.

En cas d’échec : sauvegarder la correction sur la branche de la milestone concernée, la répercuter proprement vers l’aval, relancer les preuves affectées et la review. Ne pas contourner une gate en abaissant son attente pour correspondre au résultat.

## 8. M6 final, version et installation

Relire les PR encore ouvertes et la roadmap. Ne pas fermer de branches ou de travaux sans rapport. Retirer toutes les probes/recettes temporaires du diff final. Mettre à jour les dispositions delivered/deferred-trigger/abandoned selon la réalité admise ; les snapshots de préparation restent historiques.

Choisir la version de publication selon le repo après admission des nouvelles capacités. Mettre à jour package/lock/manifest nécessaires **avant** de figer le SHA final, puis relancer CI, audit, build, packaging et canary exact-SHA. Ne pas republier la version 3.8.2 existante avec d’autres octets. Ne pas inclure le SHA du commit dans un fichier qui ferait lui-même changer ce SHA.

Vérifier ensuite main/tag/release et les hashes du package et des trois Bridges contre le même source commit. Une release draft n’est pas une publication. Ne finaliser la publication que lorsque tous les gates sont prouvés. Les seules preuves d’installation viennent de l’environnement local, pas des numéros de version dans le dépôt.

Préserver M1 lors de l’installation contrôlée. Sur Secure, vérifier `obsidian_runtime_status`, lecture d’une note témoin, racines externes/skills locales disponibles et `obsidian_note_links`. Redémarrer le backend de test en conservant proxy/tunnel ; une lecture doit reconnecter une fois, une vraie note absente ne doit pas reconnecter, et une mutation d’issue inconnue ne doit pas être rejouée.

## Livrable final

Un compte rendu durable par PR puis une synthèse unique : refs/SHA admis, CI/reviews, scénarios locaux réellement exécutés, limites non qualifiées, hashes et emplacement des artefacts installés sans secrets, état main/tag/release, rollback conservé et éléments différés. Aucune estimation de pourcentage, aucun « tout est bon » sans preuves et aucun reste caché derrière un NOT_RUN.
