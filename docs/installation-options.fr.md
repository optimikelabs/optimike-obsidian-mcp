# Configuration selon votre installation

Le profil `operational` privilégie les écritures gouvernées ; `full` conserve les outils de compatibilité. Choisissez le profil selon vos clients et vos workflows. Les permissions restent contrôlées indépendamment du catalogue.

Si plusieurs clients partagent un backend HTTP et la même identité authentifiée, ils partagent aussi le quota. En cas de refus `429`, vérifiez les compteurs et `Retry-After` avant de modifier les limites. `MCP_HTTP_IDENTITY_RATE_LIMIT_MAX` permet de définir un plafond adapté ; par exemple `1000` requêtes par fenêtre de 15 minutes peut convenir à une installation locale sollicitée. Ce n'est ni une valeur imposée ni une séparation des clients. Conservez une limite finie et les protections HTTP ; choisissez la valeur selon l'exposition et l'usage. Voir [les protections HTTP](http-multiclient-security.fr.md).

Local REST API `5.4.0` a été exercée sur les parcours de lecture et d'écriture gouvernée décrits dans [le suivi de performance](governed-performance.md). Cela ne certifie pas tous les outils ou plugins. Sans signal de fin FDM compatible, la certification conserve son attente prudente. L'intégration [FDM facultative](fdm-completion.md) concerne un add-on précisément qualifié, pas le plugin FDM officiel inchangé. Chaque installateur choisit ses plugins et réglages.
