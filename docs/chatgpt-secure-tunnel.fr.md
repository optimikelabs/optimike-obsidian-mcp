# ChatGPT via OpenAI Secure MCP Tunnel

English version: [chatgpt-secure-tunnel.md](chatgpt-secure-tunnel.md)

Optimike peut se connecter directement à ChatGPT via OpenAI Secure MCP Tunnel. Chat On Steroids n’est pas une dépendance runtime de cette voie.

```text
ChatGPT
  -> endpoint de tunnel hébergé par OpenAI
  -> tunnel-client officiel sur votre machine
  -> proxy stdio Optimike (profil d’outils choisi)
  -> Obsidian / racines externes configurées
```

Secure MCP Tunnel est un transport sortant pour un serveur MCP privé. Il ne publie pas Optimike comme plugin ChatGPT public. Chaque opérateur doit disposer d’un espace ChatGPT éligible, d’une association au tunnel Platform, d’un `tunnel_id` et d’une clé runtime avec **Tunnels Read + Use**.

## Installer le client de tunnel officiel

Utiliser le téléchargement des réglages Platform ou la dernière release publique de [openai/tunnel-client](https://github.com/openai/tunnel-client/releases/latest). Ne pas recopier le binaire depuis une autre application desktop.

Sous Windows, ce dépôt fournit un installateur qui vérifie le checksum :

```powershell
pwsh -NoProfile -File scripts/install-openai-tunnel-client.ps1
```

Épingler une version revue lorsque la reproductibilité compte :

```powershell
pwsh -NoProfile -File scripts/install-openai-tunnel-client.ps1 -Version 0.0.14
```

Le script télécharge l’archive Windows officielle et `SHA256SUMS.txt`, refuse un digest incorrect, contrôle la version annoncée par le binaire et installe dans `%LOCALAPPDATA%\Optimike\tunnel-client\vX.Y.Z\windows-<arch>`. Il crée aussi le lanceur stable `%LOCALAPPDATA%\Optimike\tunnel-client\tunnel-client.cmd` ; une nouvelle exécution retélécharge les entrées officielles et refuse un exécutable existant qui a dérivé. Aucun secret n’est écrit dans le dépôt.

## Connecter Optimike

Construire Optimike. Le profil explicite `full` expose toute la surface live ; choisir un profil plus petit lorsqu’il suffit.

```powershell
npm install
npm run build
```

Utiliser le workflow de profils du client officiel. Conserver la clé API dans l’environnement protégé d’un processus ou d’un service, jamais dans Git, une note du coffre, une transcription de commande ou la commande MCP.

```powershell
$tunnelClient = Join-Path $env:LOCALAPPDATA "Optimike\tunnel-client\tunnel-client.cmd"

& $tunnelClient init `
  --sample sample_mcp_stdio_local `
  --profile optimike-full `
  --tunnel-id tunnel_0123456789abcdef0123456789abcdef `
  --mcp-command "node C:/chemin/vers/optimike-obsidian-mcp/dist/stdio-proxy.js --tool-profile full"

& $tunnelClient doctor --profile optimike-full --explain
& $tunnelClient run --profile optimike-full
```

Créer ensuite une application en mode développeur dans ChatGPT, choisir **Tunnel** comme type de connexion et sélectionner le tunnel associé. Vérifier que le client local est live et ready avant de tester l’application.

## Charger une configuration locale et des racines externes

Le processus lancé par `tunnel-client` doit recevoir la même configuration qu’un client stdio local. Les secrets Obsidian et les chemins privés restent hors Git. Pour injecter proprement le profil d’outils et le fichier de racines, créer un lanceur PowerShell local, par exemple `C:\Users\vous\.config\optimike\start-chatgpt-mcp.ps1` :

```powershell
$ErrorActionPreference = "Stop"
$repository = "C:\chemin\vers\optimike-obsidian-mcp"
$externalRoots = "C:\Users\vous\.config\optimike\external-roots.json"

$env:MCP_TOOL_PROFILE = "full"
$env:MCP_EXTERNAL_ROOTS_FILE = $externalRoots

Set-Location -LiteralPath $repository
& node (Join-Path $repository "dist\stdio-proxy.js")
exit $LASTEXITCODE
```

Le processus `tunnel-client` hérite de son environnement. Les clés nécessaires peuvent donc être fournies par le gestionnaire de secrets ou le service qui lance le tunnel, sans les écrire dans le script. Référencer ensuite ce lanceur dans le profil :

```powershell
& $tunnelClient init `
  --sample sample_mcp_stdio_local `
  --profile optimike-full `
  --tunnel-id tunnel_0123456789abcdef0123456789abcdef `
  --mcp-command 'pwsh -NoProfile -File "C:/Users/vous/.config/optimike/start-chatgpt-mcp.ps1"'
```

Pour ajouter un dossier, copier d’abord [`external-roots.example.json`](external-roots.example.json) hors du dépôt, puis ajouter une entrée à `roots`. Exemple strictement lecture seule :

```json
{
  "id": "mes-documents",
  "path": "D:\\Documents\\Références",
  "capabilities": ["visible", "readable"],
  "include": ["**/*.md", "**/*.txt", "**/*.json"],
  "exclude": ["**/.git/**", "**/node_modules/**", "**/*.zip"],
  "limits": {
    "maxDepth": 8,
    "maxFileBytes": 1048576,
    "maxListEntries": 500,
    "maxTextChars": 200000
  }
}
```

Ne pas remplacer les entrées existantes : ajouter la nouvelle racine dans le même tableau `roots`. Employer `visible` + `readable` tant qu’un déplacement externe n’est pas explicitement nécessaire. Le schéma, les plafonds et les règles de confinement sont détaillés dans [Configuration External Roots](external-roots-setup.fr.md).

La configuration des racines est chargée au démarrage du processus MCP. Après une modification du JSON, arrêter le `tunnel-client` de ce profil, puis relancer :

```powershell
$healthFile = Join-Path $env:TEMP "optimike-tunnel-health.url"

& $tunnelClient doctor --profile optimike-full --explain
& $tunnelClient run `
  --profile optimike-full `
  --health.listen-addr 127.0.0.1:0 `
  --health.url-file $healthFile
```

En exécution au premier plan, `Ctrl+C` arrête proprement ce client avant la relance. Avec un service ou un superviseur, redémarrer uniquement l’instance liée au profil Optimike ; ne pas tuer tous les processus `tunnel-client` de la machine. Lire ensuite l’URL dans `$healthFile`, contrôler `/healthz` et `/readyz`, puis appeler `external_roots_list`, `external_list` et `external_read` sur un petit fichier témoin.

Ajouter une racine externe ne nécessite pas de redémarrer Obsidian ni ses Bridges. Les Bridges concernent les opérations natives dans le coffre. Après une mise à niveau d’un Bridge, suivre [Bundle des Bridges et rollback](bridge-packaging.fr.md), recharger Obsidian, puis vérifier `obsidian_runtime_status`. Un simple reload de Local REST API est récupéré automatiquement par le [superviseur de lifecycle](bridge-lifecycle.fr.md).

## Actualiser après une mise à niveau d’Optimike

Le runtime serveur et une conversation ChatGPT n’ont pas le même cycle de vie.

1. Redémarrer le backend Optimike et l’instance `tunnel-client` du profil concerné.
2. Contrôler les endpoints `/healthz` et `/readyz` du client de tunnel.
3. Dans ChatGPT, ouvrir **Paramètres -> Plugins -> application Optimike -> Actualiser**.
4. Démarrer une nouvelle conversation et vérifier quelques noms d’outils du profil choisi.

Pour une simple modification du fichier de racines, le redémarrage du `tunnel-client` suffit : il recrée le proxy stdio avec la nouvelle configuration. Pour un nouveau build de `dist`, redémarrer aussi le backend Optimike. Pour de nouveaux noms d’outils, l’actualisation de l’application ChatGPT et une nouvelle conversation sont obligatoires ; une conversation déjà ouverte conserve ses bindings initiaux.

Pendant le pilote Optimike 3.9.1, l’actualisation de l’application a découvert immédiatement les nouveaux outils, tandis que les conversations créées avant l’actualisation ont conservé leurs 77 bindings initiaux. Une nouvelle conversation a reçu les 87 outils du profil `full`. La surface réellement injectée dans la conversation courante fait foi côté client ; `obsidian_runtime_status` décrit les capacités du backend et ne peut pas modifier rétroactivement les bindings d’une conversation.

## Frontière d’exploitation

- `tunnel-client` assure uniquement le transport. Optimike possède l’enregistrement des outils, les policies, journaux, schémas et comportements backend.
- L’extension navigateur utilisée par Chat On Steroids n’est pas nécessaire à Optimike via Secure MCP Tunnel.
- Le poste local, le backend Optimike, Obsidian Desktop pour les capacités live et `tunnel-client` doivent rester disponibles.
- Après une réponse de mutation perdue, utiliser `status` ou le cockpit des opérations. Ne jamais rejouer une mutation seulement parce que le tunnel ou la conversation a perdu la réponse.
- Appliquer le [guide de sécurité](../SECURITY.fr.md), les [profils d’outils](tool-surface-profiles.fr.md) et le [guide d’exploitation](../OPERATIONS.fr.md).

Documentation OpenAI actuelle du transport : [Secure MCP Tunnel](https://developers.openai.com/fr-FR/api/docs/guides/secure-mcp-tunnels).
