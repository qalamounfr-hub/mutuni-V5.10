import type {NavigateFn, ScreenParams} from './router';
import {listBayts, listBaytsForMatn, listBabs, Bayt, Bab} from './mutuniDB';
import {LiveCursor, LiveWord} from './liveCursor';
import {MicEngine} from './micEngine';
import {renderReciteWords, renderContinuousPage, activeWordIndex, LEARNING_LEVELS, DEFAULT_LEARNING_LEVEL, ContinuousBaytGroup} from './reciteView';
import {getBaytState, putBaytState, applySrsResult} from './srs';
import {tokenizeRaw} from './normalize';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]!));

let sharedMicEngine: MicEngine | null = null;
function getMicEngine(): MicEngine {
  if (!sharedMicEngine) sharedMicEngine = new MicEngine();
  return sharedMicEngine;
}

export function renderReciteScreen(root: HTMLElement, params: ScreenParams, navigate: NavigateFn) {
  const {baytIdx = 0} = params;
  if (!params.matnId) { root.innerHTML = `<div class="app-error">Matn non spécifié.</div>`; return; }
  const matnId: string = params.matnId;
  const babId: string | undefined = params.babId;
  // 'continuous' (5.8.0, refondu en 5.9.0 pour coller à l'ancienne interface
  // React — composant ContinuousFlow) : TOUS les bayts du bab (ou du matn
  // entier, sans babId) sont affichés empilés sur la même page, avec un
  // seul curseur qui avance sur le flux complet — pas un cursor par bayt
  // qu'on change comme dans la première version 5.8.0. Le mode par défaut
  // ('single', bayt-par-bayt) est un chemin totalement séparé ci-dessous,
  // strictement inchangé.
  const continuous = params.mode === 'continuous';
  if (!continuous && !babId) { root.innerHTML = `<div class="app-error">Bayt non spécifié.</div>`; return; }

  return continuous
    ? renderContinuousMode(root, navigate, matnId, babId)
    : renderSingleMode(root, navigate, matnId, babId!, baytIdx);
}

/* ════════════ MODE BAYT PAR BAYT (par défaut, inchangé depuis 5.8.0) ════════════ */

function renderSingleMode(root: HTMLElement, navigate: NavigateFn, matnId: string, babId: string, baytIdx: number) {
  root.innerHTML = `
    <header class="screen-header">
      <button class="screen-back" id="back">←</button>
      <div class="screen-title" id="screenTitle">Récitation</div>
      <div class="screen-header-spacer"></div>
    </header>
    <div class="recite-levels" id="levels"></div>
    <div class="recite-words" id="words" dir="rtl"></div>
    <div class="recite-progress" id="progressBar"></div>
    <div class="recite-controls">
      <button class="recite-mic" id="micBtn" aria-label="Démarrer la récitation">🎤</button>
      <div class="recite-status" id="micStatus">Appuie pour réciter</div>
    </div>
    <div class="recite-nav">
      <button id="prevBayt">← Précédent</button>
      <button id="resetBayt">↺ Recommencer</button>
      <button id="nextBayt">Suivant →</button>
    </div>
  `;

  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>('#' + id)!;
  let level = DEFAULT_LEARNING_LEVEL;
  let cursor: LiveCursor | null = null;
  let bayts: Bayt[] = [];
  let currentIdx = baytIdx;
  let heardWords: string[] = [];
  let recording = false;
  let cancelled = false;
  let sadrWordCount = 0; // nombre de mots du premier hémistiche du bayt courant, pour l'affichage en 2 lignes (voir renderWords)

  const levelsEl = $('levels');
  levelsEl.innerHTML = LEARNING_LEVELS.map(l =>
    `<button class="level-chip${l.id === level ? ' level-chip-active' : ''}" data-level="${l.id}">${l.icon} ${esc(l.label)}</button>`
  ).join('');
  levelsEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-level]');
    if (!btn) return;
    level = Number(btn.dataset.level);
    levelsEl.querySelectorAll('.level-chip').forEach(c => c.classList.toggle('level-chip-active', c === btn));
    renderWords();
  });

  function renderWords() {
    if (!cursor) return;
    const snap = cursor.snapshot();
    renderReciteWords($('words'), snap, level, activeWordIndex(snap), sadrWordCount);
    const r = cursor.report();
    $('progressBar').textContent = `${r.matched + r.skipped}/${r.total} mots`;
  }

  async function loadBayt(idx: number) {
    bayts = await listBayts(babId);
    if (!bayts.length) { root.innerHTML = `<div class="app-error">Aucun bayt dans ce bab.</div>`; return; }
    currentIdx = Math.max(0, Math.min(bayts.length - 1, idx));
    const bayt = bayts[currentIdx];
    cursor = new LiveCursor(bayt.textHaraka);
    // Même tokenisation (tokenizeRaw) que celle utilisée par LiveCursor pour
    // construire displayText, pour que la césure sadr/ajuz affichée tombe
    // exactement sur le même découpage en mots que le curseur — sinon un
    // décalage d'un mot est possible si sadr/ajuz sont tokenisés autrement.
    sadrWordCount = tokenizeRaw(bayt.textSadr).length;
    heardWords = [];
    $('screenTitle').textContent = `Bayt ${currentIdx + 1} / ${bayts.length}`;
    updateExpectedWindow();
    renderWords();
  }

  // Rescoring lexical (5.10.0) : transmet au worker la fenêtre de mots
  // attendus autour de la position actuelle du curseur. tokenizeRaw (pas
  // tokenizeExpected) pour garder les harakat — cohérent avec displayText
  // dans LiveCursor, et nécessaire pour qu'une correction injecte le vrai
  // mot du texte, pas une version sans diacritiques.
  function updateExpectedWindow() {
    if (!cursor) return;
    const bayt = bayts[currentIdx];
    const words = tokenizeRaw(bayt.textHaraka);
    engine.setExpectedWords(words, cursor.report().position);
  }

  const engine = getMicEngine();
  const micBtn = $('micBtn');
  const micStatus = $('micStatus');

  async function finishAttempt() {
    if (!cursor) return;
    const r = cursor.report();
    const coverage = r.total ? (r.matched + r.skipped) / r.total : 0;
    try {
      const bayt = bayts[currentIdx];
      const state = await getBaytState(matnId, babId, bayt.order - 1);
      await putBaytState(matnId, babId, bayt.order - 1, applySrsResult(state, coverage));
    } catch { /* SRS best-effort : ne bloque jamais la récitation si ça échoue */ }
  }

  micBtn.addEventListener('click', async () => {
    if (recording) {
      recording = false;
      micBtn.textContent = '🎤';
      micStatus.textContent = 'Traitement…';
      await engine.stop();
      return;
    }
    if (!engine.isReady()) { micStatus.textContent = 'Moteur en cours de chargement…'; return; }
    recording = true;
    micBtn.textContent = '⏹';
    micStatus.textContent = 'Écoute…';
    try {
      await engine.start();
    } catch (e) {
      recording = false;
      micBtn.textContent = '🎤';
      micStatus.textContent = 'Micro refusé ou indisponible.';
    }
  });

  const cbResult = (text: string) => {
    if (cancelled || !text.trim()) return;
    heardWords.push(...text.trim().split(/\s+/).filter(Boolean));
    cursor?.advance(heardWords);
    renderWords();
    updateExpectedWindow();
  };
  const cbSessionEnded = () => { if (!cancelled) { micStatus.textContent = 'Appuie pour réciter'; void finishAttempt(); } };
  const cbError = (msg: string) => { if (!cancelled) micStatus.textContent = 'Erreur: ' + msg; };
  const cbReady = () => { if (!cancelled) micStatus.textContent = 'Prêt — appuie pour réciter'; };
  const cbStatus = (msg: string) => { if (!cancelled && !engine.isReady()) micStatus.textContent = msg; };

  engine.setCallbacks({onResult: cbResult, onSessionEnded: cbSessionEnded, onError: cbError, onReady: cbReady, onStatus: cbStatus});
  if (!engine.isReady()) engine.init();

  async function switchBayt(idx: number) {
    if (recording) { recording = false; micBtn.textContent = '🎤'; await engine.stop(); }
    await loadBayt(idx);
  }

  $('prevBayt').addEventListener('click', () => void switchBayt(currentIdx - 1));
  $('nextBayt').addEventListener('click', () => void switchBayt(currentIdx + 1));
  $('resetBayt').addEventListener('click', () => void switchBayt(currentIdx));
  $('back').addEventListener('click', () => navigate('chapters', {matnId}));

  void loadBayt(currentIdx);

  return () => { cancelled = true; if (recording) void engine.stop(); };
}

/* ════════════ MODE PAGE CONTINUE (5.9.0, porté de ContinuousFlow — ancienne interface React) ════════════ */

function renderContinuousMode(root: HTMLElement, navigate: NavigateFn, matnId: string, babId: string | undefined) {
  const isAll = !babId; // "Réciter tout le matn" (sans babId) vs "En continu" sur un seul bab
  root.innerHTML = `
    <header class="screen-header">
      <button class="screen-back" id="back">←</button>
      <div class="screen-title" id="screenTitle">${isAll ? 'Récitation continue — tout le matn' : 'Récitation continue'}</div>
      <div class="screen-header-spacer"></div>
    </header>
    <div class="recite-levels" id="levels"></div>
    <div class="continuous-progress-wrap">
      <div class="continuous-progress-bar"><div class="continuous-progress-fill" id="progressFill"></div></div>
      <div class="continuous-progress-label" id="progressLabel"></div>
    </div>
    <div class="continuous-page" id="page" dir="rtl"></div>
    <div class="continuous-donebox" id="doneBox" hidden>
      <div class="continuous-donebox-icon">✓</div>
      <div class="continuous-donebox-title">${isAll ? 'Matn terminé' : 'Chapitre terminé'}</div>
      <div class="continuous-donebox-sub">بارك الله فيك</div>
    </div>
    <div class="continuous-controls">
      <button id="backBtn2" class="continuous-ctrl-btn" title="Retour">←</button>
      <button id="resetBtn" class="continuous-ctrl-btn" title="Recommencer">↺</button>
      <button class="recite-mic" id="micBtn" aria-label="Démarrer la récitation">🎤</button>
    </div>
  `;

  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>('#' + id)!;
  let level = DEFAULT_LEARNING_LEVEL;
  let cursor: LiveCursor | null = null;
  // groupBounds[i] = bornes [start, end) dans le flux plat de mots du
  // cursor, pour le groupe (bayt) i — permet de dériver le bayt actif à
  // partir de la position du curseur, comme flat[i].bIdx dans l'ancienne
  // interface (ContinuousFlow.activeBIdx).
  let groupBounds: {bab: Bab; bayt: Bayt; start: number; end: number; order: number}[] = [];
  let flatExpectedWords: string[] = []; // mots avec harakat, flux complet — pour le rescoring lexical (5.10.0)
  let heardWords: string[] = [];
  let recording = false;
  let cancelled = false;
  let srsMarked = new Set<number>(); // indices de groupBounds déjà enregistrés dans le SRS cette session

  const levelsEl = $('levels');
  levelsEl.innerHTML = LEARNING_LEVELS.map(l =>
    `<button class="level-chip${l.id === level ? ' level-chip-active' : ''}" data-level="${l.id}">${l.icon} ${esc(l.label)}</button>`
  ).join('');
  levelsEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-level]');
    if (!btn) return;
    level = Number(btn.dataset.level);
    levelsEl.querySelectorAll('.level-chip').forEach(c => c.classList.toggle('level-chip-active', c === btn));
    renderPage();
  });

  function activeGroupIndex(words: LiveWord[]): number {
    const pos = words.findIndex(w => w.status === 'pending');
    const flatPos = pos === -1 ? words.length : pos;
    for (let i = 0; i < groupBounds.length; i++) {
      if (flatPos < groupBounds[i].end) return i;
    }
    return Math.max(0, groupBounds.length - 1);
  }

  function renderPage() {
    if (!cursor || !groupBounds.length) return;
    const snap = cursor.snapshot();
    const activeIdx = activeGroupIndex(snap);
    const groups: ContinuousBaytGroup[] = groupBounds.map(g => ({
      babId: g.bab.id,
      babTitle: g.bab.title,
      order: g.order,
      sadrWordCount: tokenizeRaw(g.bayt.textSadr).length,
      words: snap.slice(g.start, g.end),
    }));
    renderContinuousPage($('page'), groups, level, activeIdx, isAll);

    const r = cursor.report();
    const revealedWords = r.matched + r.skipped;
    ($('progressFill') as HTMLElement).style.width = `${r.total ? (revealedWords / r.total * 100) : 0}%`;
    $('progressLabel').textContent = `${revealedWords} / ${r.total} mots · ${Math.min(activeIdx + 1, groupBounds.length)} / ${groupBounds.length} bayts`;

    const fullyDone = r.total > 0 && r.position >= r.total;
    ($('doneBox') as HTMLElement).hidden = !fullyDone;
    ($('micBtn') as HTMLButtonElement).disabled = fullyDone;

    // Enregistrement SRS au fil de l'eau (ancienne interface : markBaytDone
    // dès qu'un bayt devient complet, pas seulement à la fin de la session
    // entière) — un bayt est "fait" dès que activeIdx l'a dépassé.
    groupBounds.forEach((g, i) => {
      if (i < activeIdx && !srsMarked.has(i)) {
        srsMarked.add(i);
        const slice = snap.slice(g.start, g.end);
        const matched = slice.filter(w => w.status === 'matched' || w.status === 'skipped').length;
        const coverage = slice.length ? matched / slice.length : 0;
        void (async () => {
          try {
            const state = await getBaytState(matnId, g.bab.id, g.bayt.order - 1);
            await putBaytState(matnId, g.bab.id, g.bayt.order - 1, applySrsResult(state, coverage));
          } catch { /* SRS best-effort */ }
        })();
      }
    });

    // Scroll automatique vers le groupe actif (ContinuousFlow: useEffect sur
    // activeBIdx -> scrollIntoView) — exécuté ici, après l'insertion DOM
    // réelle par renderContinuousPage ci-dessus.
    if (!fullyDone) {
      const activeEl = $('page').querySelector<HTMLElement>(`[data-continuous-bayt-index="${activeIdx}"]`);
      activeEl?.scrollIntoView({behavior: 'smooth', block: 'center'});
    }

    // Rescoring lexical (5.10.0) : fenêtre glissante autour de la position
    // GLOBALE du curseur dans le flux plat entier (pas seulement le bayt
    // actif) — flatExpectedWords/r.position sont déjà à l'échelle du flux
    // complet, donc pas de recalcul de bornes ici, juste une transmission.
    engine.setExpectedWords(flatExpectedWords, r.position);
  }

  async function loadInitial() {
    const bayts = babId ? await listBayts(babId) : await listBaytsForMatn(matnId);
    if (!bayts.length) { root.innerHTML = `<div class="app-error">Aucun bayt à réciter.</div>`; return; }
    const babsList = await listBabs(matnId);
    const babById = new Map(babsList.map(b => [b.id, b]));
    // Numéro d'affichage de chaque bayt DANS SON BAB (comme arNum(bIdx+1)
    // dans l'ancienne interface — pas un numéro global sur tout le matn).
    let orderInBab = 0, lastBabId: string | null = null;
    const flatWords: string[] = [];
    groupBounds = [];
    bayts.forEach(bayt => {
      if (bayt.babId !== lastBabId) { orderInBab = 0; lastBabId = bayt.babId; }
      orderInBab += 1;
      const bab = babById.get(bayt.babId);
      if (!bab) return; // ne devrait pas arriver (intégrité DB) — garde défensive
      const words = tokenizeRaw(bayt.textHaraka);
      const start = flatWords.length;
      flatWords.push(...words);
      groupBounds.push({bab, bayt, start, end: flatWords.length, order: orderInBab});
    });
    flatExpectedWords = flatWords;
    cursor = new LiveCursor(flatWords);
    heardWords = [];
    srsMarked = new Set();
    renderPage();
  }

  const engine = getMicEngine();
  const micBtn = $('micBtn') as HTMLButtonElement;

  micBtn.addEventListener('click', async () => {
    if (recording) {
      recording = false;
      micBtn.textContent = '🎤';
      await engine.stop();
      return;
    }
    if (!engine.isReady()) return;
    recording = true;
    micBtn.textContent = '⏹';
    try {
      await engine.start();
    } catch (e) {
      recording = false;
      micBtn.textContent = '🎤';
    }
  });

  const cbResult = (text: string) => {
    if (cancelled || !text.trim() || !cursor) return;
    heardWords.push(...text.trim().split(/\s+/).filter(Boolean));
    cursor.advance(heardWords);
    renderPage();
  };
  const cbSessionEnded = () => { if (!cancelled) { recording = false; micBtn.textContent = '🎤'; } };
  const cbError = () => { /* pas de zone d'erreur texte en mode continu, comme l'ancienne interface */ };
  const cbReady = () => {};
  const cbStatus = () => {};

  engine.setCallbacks({onResult: cbResult, onSessionEnded: cbSessionEnded, onError: cbError, onReady: cbReady, onStatus: cbStatus});
  if (!engine.isReady()) engine.init();

  $('resetBtn').addEventListener('click', async () => {
    if (recording) { recording = false; micBtn.textContent = '🎤'; await engine.stop(); }
    heardWords = [];
    srsMarked = new Set();
    cursor?.reset();
    renderPage();
  });
  $('back').addEventListener('click', () => navigate('chapters', {matnId}));
  $('backBtn2').addEventListener('click', () => navigate('chapters', {matnId}));

  void loadInitial();

  return () => { cancelled = true; if (recording) void engine.stop(); };
}
