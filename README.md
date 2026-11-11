# 📻 דבר אלי (Daber Elai)

Application web de talkie-walkie : fréquences de **00:00 à 99:00**, **8 personnes max** par fréquence,
profils modifiables, amis, messages privés et fréquences privées réservées aux amis.

## Lancer l'application

1. Installer Node.js (version 18 ou plus) : https://nodejs.org
2. Dans ce dossier :
   ```bash
   npm install
   npm start
   ```
3. Ouvrir http://localhost:3000

Pour tester à plusieurs sur un seul ordinateur : ouvre une fenêtre normale + une fenêtre de navigation privée
et crée deux comptes.

## Utiliser sur téléphone

Les navigateurs n'autorisent le micro qu'en **HTTPS** (ou sur `localhost`). Pour tester depuis un téléphone :
- en local : `npx localtunnel --port 3000` ou `cloudflared tunnel --url http://localhost:3000` donne une URL https ;
- en ligne : déployer sur Render, Railway, Fly.io… (`npm start`, variable `PORT` prise en charge).

## Fonctionnalités

| Fonction | Comment |
|---|---|
| Fréquences | Flèches ▲▼ sur l'écran, ou ⌨️ pour taper (ex : `42:17`). De 00:00 à 99:00. |
| Parler | Maintenir le gros bouton (ou la touche Espace). Une seule personne parle à la fois (« canal occupé »). |
| 8 max | La 9e personne est refusée (« Fréquence pleine »). |
| Profil | Onglet Profil : nom affiché, bio, couleur d'avatar. Le nom d'utilisateur (@) sert à être ajouté. |
| Amis | Ajouter par nom d'utilisateur, ou bouton « + Ami » sur quelqu'un présent sur ta fréquence. |
| Messages | Onglet Messages, entre amis uniquement, historique sauvegardé. |
| Fréquence privée | Sur une fréquence, bouton 🔓 → 🔒. Seuls tes amis peuvent y entrer. Elle reste à toi (visible dans le Scanner). Retirer un ami l'expulse de tes fréquences privées. |
| Scanner | Liste les fréquences actives et leur nombre de personnes. |

## Structure

```
server/index.js    serveur Express + Socket.IO (fréquences, audio, amis, messages)
server/db.js       stockage dans data/data.json
public/            interface (HTML/CSS/JS sans build)
  audio.js         capture micro (PCM 16 kHz) + lecture avec effet radio et bips
  mic-worklet.js   capture audio en temps réel
```

## Pour aller plus loin

- Base de données réelle (PostgreSQL / SQLite) à la place du fichier JSON.
- Application mobile (React Native / Capacitor) pour parler écran éteint et recevoir des notifications.
- Audio compressé (Opus) pour réduire la consommation de données.
