# MUTUNI — Tilawa Lab

Projet Vite + TypeScript pour suivre localement la récitation arabe de mutûn : microphone, fenêtres audio, FastConformer CTC via ONNX Runtime Web, fallback WASM et progression mot à mot.

## Corrections apportées

- Build Vercel explicite avec `vite build`, `dist` et `vercel.json` minimal.
- Configuration TypeScript séparée pour l’interface et le Web Worker (`tsconfig.json` / `tsconfig.worker.json`), cible ES2022, DOM/WebWorker et `skipLibCheck`.
- Déclaration Vite correcte dans `src/vite-env.d.ts`.
- Suppression de `replaceAll` au profit d’une expression régulière compatible.
- Nouveau curseur monotone dans `src/alignment.ts` : alignement Needleman–Wunsch par programmation dynamique, fenêtre locale bornée, position attendue et position transcript persistantes, couverture et nombre de sauts limités. Une mise à jour ne peut jamais reculer ni valider un grand saut isolé.
- `src/mutuniDB.ts` : bibliothèque de mutûn persistée en IndexedDB, structurée `Matn → Bab → Bayt`. Le texte source garde les harakat ; sélecteurs Bab/Bayt dans l'UI pour charger un bayt dans le texte attendu sans saisie manuelle.

## Installation et développement

```bash
npm install
npm run dev
```

`npm run build` produit `dist/`. `npm run typecheck` contrôle les deux projets TypeScript. Le modèle ONNX est chargé côté navigateur et mis en cache selon les fichiers disponibles dans `public/` / le moteur.

## Déploiement Vercel

Importer le dépôt dans Vercel ou lancer `vercel`. La configuration utilise le framework Vite, `npm run build` et `dist` comme dossier de sortie. Aucun secret n’est requis.

## Tests

```bash
npm run test:align
npm run replay
```

Les tests couvrent les cas exact, omission, répétition et insertion ; le replay vérifie également le déterminisme. L’alignement métier reçoit le transcript cumulé, mais ne cherche qu’à partir de la dernière position monotone et dans une fenêtre de 12 mots attendus.
