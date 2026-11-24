# Okkazeo × BGG

Extension Chrome / Firefox qui affiche la note **BoardGameGeek** des jeux vendus sur [Okkazeo](https://www.okkazeo.com).

- **Dans les listes** (dernières annonces, recherches, annonces d'un vendeur…) : un badge `★ 7,8 12k` à côté de chaque jeu. Sa couleur suit l'échelle de BGG. Un clic ouvre la fiche BGG.
- **Sur une annonce ou une fiche jeu** : un encadré sous le titre avec la note, le nombre de votes, le rang, la complexité, le nombre de joueurs et la durée.
- `≈` + bordure en pointillés = correspondance approximative (le titre Okkazeo ne correspond pas exactement à un nom BGG).
- `✎` (au survol du badge) ou « Pas le bon jeu ? Corriger » : colle le lien BGG du bon jeu, ou `0` si le jeu n'est pas sur BGG. La correction est mémorisée.

## 1. Obtenir un jeton BGG

Depuis 2025, l'API de BGG demande un jeton :

1. Connecte-toi sur boardgamegeek.com.
2. Va sur <https://boardgamegeek.com/applications> et enregistre une application (usage personnel / non commercial). BGG valide les demandes manuellement, ça peut prendre quelques jours.
3. Une fois l'application validée, crée un jeton.

## 2. Installer l'extension

### Chrome / Edge / Brave

1. Ouvre `chrome://extensions` (ou `edge://extensions`).
2. Active le **Mode développeur** (en haut à droite).
3. Clique sur **Charger l'extension non empaquetée** et choisis le dossier `okkazeo-bgg`, celui qui contient `manifest.json`.

### Firefox (version 121 ou plus)

- **Pour essayer** : ouvre `about:debugging#/runtime/this-firefox`, clique sur **Charger un module complémentaire temporaire…** et choisis `manifest.json`. L'extension disparaît au redémarrage de Firefox.
- **Pour une installation permanente** : Firefox n'accepte que les extensions signées. Crée un compte développeur sur addons.mozilla.org et signe l'extension en distribution « non listée » (privée). Le plus simple est l'outil `web-ext` :
  ```bash
  npx web-ext sign --channel=unlisted --api-key=... --api-secret=...
  ```
  Tu obtiens un `.xpi` à installer dans Firefox.

## 3. Configurer

La page de réglages s'ouvre à l'installation (sinon : clic sur l'icône de l'extension).

1. Colle le jeton → **Enregistrer** → **Tester**.
2. Si « Accès non autorisé » s'affiche, clique sur **Autoriser l'accès**.
3. Recharge Okkazeo.

## Fonctionnement

- L'extension repère les liens vers les annonces (`/annonces/<n°>/…`) et les fiches jeu (`/jeux/<n°>/…`) et lit le nom du jeu dans le texte du lien.
- Elle cherche d'abord le nom exact sur BGG, noms alternatifs compris (les titres français y sont souvent), puis fait une recherche plus large. Si rien ne correspond, elle réessaie sans le sous-titre (« Abyss - Boîte bleue » → « Abyss »). Quand plusieurs jeux portent le même nom, elle prend le plus populaire.
- Seuls les jeux visibles à l'écran sont recherchés. Les appels à BGG sont espacés de 2 secondes : la première visite d'une longue liste prend donc un peu de temps, les suivantes sont instantanées grâce au cache (14 jours, 3 jours pour les jeux introuvables).
- Rien n'est envoyé ailleurs qu'à boardgamegeek.com. Le jeton reste dans le stockage local du navigateur.

## Fichiers

| Fichier | Rôle |
|---|---|
| `manifest.json` | Manifest V3 commun à Chrome et Firefox |
| `background.js` | Appels à l'API BGG (file d'attente, cache, choix du jeu) |
| `content.js` / `content.css` | Badges et encadré sur les pages Okkazeo |
| `options.html` / `options.js` | Réglages (jeton, autorisation, cache) |

## Licence

MIT, voir [LICENSE](LICENSE).
