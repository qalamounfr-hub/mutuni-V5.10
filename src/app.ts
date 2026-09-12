import {Router} from './router';
import {bootstrapBundledMatns} from './mutuniDB';
import {renderHomeScreen} from './homeScreen';
import {renderChaptersScreen} from './chaptersScreen';
import {renderReciteScreen} from './reciteScreen';
import {renderProgressScreen} from './progressScreen';
import './app.css';

const root = document.querySelector<HTMLElement>('#app')!;
root.innerHTML = '<div class="app-loading">Chargement de Mutuni…</div>';

const router = new Router(root);
router.register('home', renderHomeScreen);
router.register('chapters', renderChaptersScreen);
router.register('recite', renderReciteScreen);
router.register('progress', renderProgressScreen);

void bootstrapBundledMatns()
  .then(() => router.navigate('home'))
  .catch((e) => { root.innerHTML = `<div class="app-error">Erreur au démarrage: ${e instanceof Error ? e.message : String(e)}</div>`; });
