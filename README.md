# LTD Sandy Shores V5 — Multi-PC RP

Version conçue pour être utilisée depuis plusieurs PC/tablettes avec un état commun.

## Inclus
- Supabase comme stockage central partagé
- autosauvegarde admin (~1,4 s après une modification)
- bouton 💾 Sauvegarder en secours
- synchronisation automatique entre appareils
- commandes + statuts + historiques persistants
- entreprises + mots de passe + prix personnalisés persistants
- produits + catégories persistants
- webhook Discord séparé du stockage
- cache local de secours
- export/import JSON
- diagnostic ☁ État
- confirmations rapides sans cooldown
- migration automatique de l'ancien cache local vers Supabase

## Installation
Lis `INSTALLATION-3-ETAPES.txt`.

## Variables Render
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `DISCORD_WEBHOOK`

`SUPABASE_TABLE` est facultatif : la valeur par défaut est `ltd_state`.
