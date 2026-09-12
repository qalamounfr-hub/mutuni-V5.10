import {defineConfig} from 'vite';
import {resolve} from 'node:path';

// Deux points d'entrée : index.html (app produit, app.ts, servi à la racine "/")
// et lab.html (labo technique, main.ts, servi sur "/lab"). L'app produit est
// nommée index.html volontairement : sur Vercel, un fichier statique présent
// dans le dossier de build est servi AVANT que les rewrites de vercel.json
// soient évalués. Avec "/" -> "/app.html" comme rewrite (ancien schéma), la
// requête sur "/" matchait d'abord dist/index.html (le labo) au niveau du
// filesystem, et le rewrite vers app.html n'était jamais atteint — bug
// constaté en déploiement réel sur la 5.7.0, non détectable en sandbox.
// Sans cette config, Vite ne construirait que index.html par défaut.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        lab: resolve(__dirname, 'lab.html'),
      },
    },
  },
});
