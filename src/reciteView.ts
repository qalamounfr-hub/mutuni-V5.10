import type {LiveWord} from './liveCursor';

export interface LearningLevel { id: number; icon: string; label: string; }

// Porté depuis l'ancienne interface (mutuni-optimized) — 5 niveaux d'aide
// progressive, du texte entièrement visible à l'écran vide.
export const LEARNING_LEVELS: LearningLevel[] = [
  {id: 1, icon: '👁️', label: 'Lecture'},      // tout visible
  {id: 2, icon: '🌤️', label: 'Assisté'},      // 1 mot sur 3 visible avant récitation
  {id: 3, icon: '🎯', label: 'Standard'},      // rien de pré-révélé (comportement par défaut)
  {id: 4, icon: '🌱', label: 'Amorce'},        // seul le premier mot visible
  {id: 5, icon: '⬛', label: 'Vide'},          // écran vide, distinct visuellement de 'Standard'
];
export const DEFAULT_LEARNING_LEVEL = 3;

/** Quels mots sont pré-révélés avant même d'avoir été récités, selon le niveau. */
export function maskWordsForLevel(wordCount: number, level: number): boolean[] {
  const arr = new Array(wordCount).fill(false);
  if (level === 1) return arr.fill(true);
  if (level === 2) { for (let i = 0; i < wordCount; i++) arr[i] = (i % 3 === 0); return arr; }
  if (level === 4) { if (wordCount > 0) arr[0] = true; return arr; }
  return arr; // niveaux 3 et 5 : rien de pré-révélé
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]!));
const HARAKAT = /[\u064B-\u065F\u0670\u0640]/g;
const AR_DIGITS = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
/** Numérotation arabe-indienne (١٢٣...), comme l'ancienne interface (arNum). */
export function arNum(n: number): string { return String(n).replace(/\d/g, d => AR_DIGITS[Number(d)]); }

/**
 * Rend les mots d'un bayt en cours de récitation, en deux lignes distinctes
 * (sadr / ajuz), comme l'ancienne interface — porté sur demande explicite
 * de l'utilisateur en 5.7.3. `sadrWordCount` (nombre de mots du premier
 * hémistiche) détermine où couper le flux plat de LiveWord en deux <div>.
 * N'affecte QUE le rendu DOM : LiveCursor continue de recevoir/traiter un
 * seul flux plat de mots (bayt.textHaraka), la césure sadr/ajuz n'existe
 * qu'à l'affichage — aucun lien avec la fluidité de la reconnaissance, qui
 * dépend uniquement du fenêtrage audio (voir CHANGELOG 5.7.3).
 *
 * Un mot non révélé (pas encore 'matched'/'skipped', et pas pré-révélé par
 * le niveau d'aide) s'affiche comme une pastille grisée de la largeur du mot
 * (pas le texte en clair) — porté fidèlement du composant Word de l'ancienne
 * interface (pastille 24px de haut, largeur ≈ nb de lettres sans harakat ×
 * 11px, dégradé vert clair quand le mot actif est en cours de prononciation).
 * Niveau 5 : les pastilles restent grisées même après validation ("vide").
 */
export function renderReciteWords(el: HTMLElement, words: LiveWord[], level: number, activeIndex: number, sadrWordCount = words.length) {
  const preRevealed = maskWordsForLevel(words.length, level);
  const renderWord = (w: LiveWord, i: number) => {
    const isRevealed = w.status === 'matched' || w.status === 'skipped' || preRevealed[i];
    const showText = isRevealed && level !== 5;
    if (!showText) {
      const len = Math.max(1, w.expected.replace(HARAKAT, '').length);
      const isActive = i === activeIndex;
      const bg = isActive
        ? 'linear-gradient(180deg,rgba(168,212,182,0.30),rgba(168,212,182,0.12))'
        : 'var(--wrd-bg)';
      const bord = isActive ? '1px solid rgba(168,212,182,0.4)' : '1px solid var(--cbord)';
      return `<span class="recite-word-pill" style="min-width:${Math.max(18, len * 11)}px;background:${bg};border:${bord}"></span>`;
    }
    const isFuzzy = w.status === 'skipped';
    return `<span class="recite-word-text${isFuzzy ? ' recite-word-fuzzy' : ''}">${esc(w.expected)}</span>`;
  };
  const cut = Math.max(0, Math.min(words.length, sadrWordCount));
  const sadr = words.slice(0, cut);
  const ajuz = words.slice(cut);
  const sadrHtml = `<div class="recite-hemistich recite-hemistich-sadr">${sadr.map((w, i) => renderWord(w, i)).join('')}</div>`;
  const ajuzHtml = ajuz.length
    ? `<div class="recite-hemistich recite-hemistich-ajuz">${ajuz.map((w, i) => renderWord(w, cut + i)).join('')}</div>`
    : '';
  el.innerHTML = sadrHtml + ajuzHtml;
}

/** Premier mot pas encore résolu (pending) — le mot "actif" que le récitant doit dire. */
export function activeWordIndex(words: LiveWord[]): number {
  return words.findIndex(w => w.status === 'pending');
}

export interface ContinuousBaytGroup {
  babId: string;
  babTitle: string;    // titre du bab, utilisé pour le séparateur de chapitre en mode "tout le matn"
  order: number;       // numéro d'affichage du bayt DANS SON BAB (1-indexé), comme l'ancienne interface (arNum(bIdx+1))
  sadrWordCount: number;
  words: LiveWord[];   // sous-tranche de LiveWord appartenant à ce bayt, dans l'ordre
}

/**
 * Rend la "page continue" (5.9.0, porté fidèlement de ContinuousFlow dans
 * l'ancienne interface React) : TOUS les bayts d'un bab (ou d'un matn entier)
 * empilés dans le même DOM, chacun avec son numéro et ses deux hémistiches,
 * séparés par un titre de chapitre quand celui-ci change (mode "tout le
 * matn" uniquement — showChapterTitles). Contrairement au mode bayt-par-bayt
 * (renderReciteWords), qui ne rend qu'UN SEUL bayt à la fois, ici un seul
 * appel construit toute la page ; c'est activeBaytIdx qui détermine quel
 * groupe reçoit le style "actif" (fond/bordure vert clair, comme
 * ContinuousFlow) — le scroll vers ce groupe est géré par l'appelant
 * (reciteScreen.ts), pas ici, car scrollIntoView doit s'exécuter après
 * l'insertion DOM réelle.
 */
export function renderContinuousPage(
  el: HTMLElement,
  groups: ContinuousBaytGroup[],
  level: number,
  activeBaytIdx: number,
  showChapterTitles: boolean,
): void {
  const renderWordAt = (w: LiveWord, preRevealed: boolean, isActiveWord: boolean) => {
    const isRevealed = w.status === 'matched' || w.status === 'skipped' || preRevealed;
    const showText = isRevealed && level !== 5;
    if (!showText) {
      const len = Math.max(1, w.expected.replace(HARAKAT, '').length);
      const bg = isActiveWord
        ? 'linear-gradient(180deg,rgba(168,212,182,0.30),rgba(168,212,182,0.12))'
        : 'var(--wrd-bg)';
      const bord = isActiveWord ? '1px solid rgba(168,212,182,0.4)' : '1px solid var(--cbord)';
      return `<span class="recite-word-pill" style="min-width:${Math.max(18, len * 11)}px;background:${bg};border:${bord}"></span>`;
    }
    const isFuzzy = w.status === 'skipped';
    return `<span class="recite-word-text${isFuzzy ? ' recite-word-fuzzy' : ''}">${esc(w.expected)}</span>`;
  };

  let prevBabTitle: string | null = null;
  const parts: string[] = [];
  groups.forEach((g, gIdx) => {
    if (showChapterTitles && g.babTitle !== prevBabTitle) {
      parts.push(`<div class="continuous-chapter-divider"><span class="continuous-chapter-divider-line"></span><span class="continuous-chapter-divider-title">${esc(g.babTitle)}</span><span class="continuous-chapter-divider-line"></span></div>`);
      prevBabTitle = g.babTitle;
    }
    const isActive = gIdx === activeBaytIdx;
    const isDone = gIdx < activeBaytIdx;
    const preRevealed = maskWordsForLevel(g.words.length, level);
    const activeWordInGroup = isActive ? activeWordIndex(g.words) : -1;
    const cut = Math.max(0, Math.min(g.words.length, g.sadrWordCount));
    const sadr = g.words.slice(0, cut);
    const ajuz = g.words.slice(cut);
    const renderHemistich = (ws: LiveWord[], offset: number, cls: string) =>
      `<div class="recite-hemistich ${cls}">${ws.map((w, i) => renderWordAt(w, preRevealed[offset + i], offset + i === activeWordInGroup)).join('')}</div>`;
    parts.push(`
      <div class="continuous-bayt-group${isActive ? ' continuous-bayt-active' : ''}${isDone ? ' continuous-bayt-done' : ''}" data-continuous-bayt-index="${gIdx}" style="content-visibility:${isActive ? 'visible' : 'auto'};contain-intrinsic-size:0 110px">
        <div class="continuous-bayt-number">${esc(arNum(g.order))}</div>
        ${renderHemistich(sadr, 0, 'recite-hemistich-sadr')}
        ${ajuz.length ? renderHemistich(ajuz, cut, 'recite-hemistich-ajuz') : ''}
      </div>
    `);
  });
  el.innerHTML = parts.join('');
}
