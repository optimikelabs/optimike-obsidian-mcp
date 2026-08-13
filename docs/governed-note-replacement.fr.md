# Remplacement atomique gouverné d’une note

Version anglaise : [governed-note-replacement.md](governed-note-replacement.md)

Le candidat 2.6 expose quatre outils MCP métier pour une note Markdown
existante : `obsidian_note_replace_plan`, `obsidian_note_replace_apply`,
`obsidian_note_replace_status` et `obsidian_note_replace_recover`.

Ils ne sont disponibles qu’avec un service Obsidian REST live et l’Atomic Write
Bridge inclus. Le plan et chaque effet possible restent soumis à la politique
d’écriture MCP courante, aux règles de frontmatter protégé, au binding backend
et au write gate du Bridge.

Le `planRef` est opaque. Apply accepte uniquement le plan scellé et la même clé
d’idempotence. Après une réponse incertaine, le client lit status avant
d’utiliser la récupération du plan exact. Recover réconcilie ou reprend en
sécurité ce même plan ; ce n’est pas un undo et il n’accepte aucun nouveau
payload.

Le journal durable reste l’unique autorité de cette opération. Le contenu
scellé des plans non terminaux reste local à la machine et est expurgé dès qu’un
état terminal stable est enregistré.

La garantie atomique couvre la transition de la note cible imposée par le
compare-and-replace `Vault.process` d’Obsidian. Sync, watchers, plugins,
indexeurs et automatisations externes restent hors de cette frontière de
récupération.

Le test déterministe utilise le serveur MCP compilé et un vrai client stdio, en
ne simulant que la frontière HTTP Obsidian. Un canary opérateur séparé, qui
échoue fermé, valide la même surface sur un coffre Obsidian live jetable avant
merge ou release.

Aucune surface publique générique `operation_*` n’est introduite.
