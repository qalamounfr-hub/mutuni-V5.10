// Port fidèle du moteur de reconnaissance de l'app Mutuni en production
// (mutuni-corrige/index.html : norm, levenshtein, PHONETIC_MAP, toPhonetic,
// phoneticScore, alignWords, findBestBaytAlignment, tryAdvance, peekNearMatch).
// Adapté pour être appelé en continu depuis le worker de fenêtres CTC du Lab
// plutôt qu'une seule fois sur un transcript final complet (usage d'origine).
//
// Ce module ne modifie PAS la logique d'origine : seuls les noms de fonctions
// ont été laissés identiques et le code a été typé, pour permettre de
// facilement comparer/rebasculer si besoin (voir décision dans la
// conversation : ce moteur "alignWords/tryAdvance" est repris plutôt que
// recognition-engine.js, qui n'était pas branché dans l'app de production).

export function norm(t: string = ''): string {
  return String(t)
    .normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/[ٱ]/g, 'ا').replace(/[ؤئ]/g, 'ء')
    .replace(/[،؛؟,:.!؟\-–—()[\]{}«»]/g, ' ')
    .replace(/[\u0660-\u0669]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/\s+/g, ' ').trim();
}

export function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}

const PHONETIC_MAP: Record<string, string> = {
  'ا': 'A', 'ب': 'b', 'ت': 't', 'ث': 'th', 'ج': 'j', 'ح': 'H', 'خ': 'kh', 'د': 'd', 'ذ': 'dh',
  'ر': 'r', 'ز': 'z', 'س': 's', 'ش': 'sh', 'ص': 'S', 'ض': 'D', 'ط': 'T', 'ظ': 'Z', 'ع': '3',
  'غ': 'gh', 'ف': 'f', 'ق': 'q', 'ك': 'k', 'ل': 'l', 'م': 'm', 'ن': 'n', 'ه': 'h', 'و': 'w',
  'ي': 'y', 'ء': '', 'ئ': '', 'ؤ': '', 'ى': 'A', 'ة': 'h', 'ٱ': 'A', 'آ': 'AA', 'إ': 'A', 'أ': 'A',
  'َ': 'a', 'ِ': 'i', 'ُ': 'u', 'ْ': '', 'ً': 'an', 'ٍ': 'in', 'ٌ': 'un', 'ّ': 'SH', 'ٰ': 'A',
};

// Règles tajwid simplifiées (ordre important) : shamsiya/qamariya, ghunna,
// ikhfa, iqlab, izhaar, madd, qalqala — reprises telles quelles de la
// version en production.
//
// BUG CORRIGÉ (5.6.0) : ces règles sont écrites pour du texte LATIN
// translittéré (elles cherchent des motifs comme "Al" ou "n" suivi de
// consonnes latines), mais elles étaient appliquées avant PHONETIC_MAP, donc
// sur du texte encore en arabe — aucune ne matchait jamais, c'était du code
// mort qui laissait croire que le tajwid était pris en compte alors qu'il ne
// l'était pas. Corrigé : PHONETIC_MAP s'applique d'abord (arabe -> latin),
// puis les règles tajwid opèrent sur le résultat latin, comme prévu à l'origine.
export function toPhonetic(text: string): string {
  const normalized = norm(text);

  let r = '';
  for (const c of normalized) r += (PHONETIC_MAP[c] || c);

  let n = r;
  n = n.replace(/\bAl(?=[tTdDszZsrln])/g, 'aL');
  n = n.replace(/\bAl(?=[bghHj3fqkmyhw])/g, 'al');
  n = n.replace(/n(?=[yrlmnw])/g, 'N');
  n = n.replace(/n(?=[sSdDtTzZcfkqjg])/g, 'n~');
  n = n.replace(/nb/g, 'mb');
  n = n.replace(/n(?=[h3Hghkh])/g, 'n!');
  n = n.replace(/aA/g, 'aa');
  n = n.replace(/uw/g, 'uu');
  n = n.replace(/iy/g, 'ii');
  n = n.replace(/([qtdbj])\b/g, '$1q');
  n = n.replace(/^A/, '');

  return n.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function phoneticScore(a: string, b: string): number {
  const p1 = toPhonetic(a), p2 = toPhonetic(b);
  const dist = levenshtein(p1, p2);
  const maxLen = Math.max(p1.length, p2.length);
  return maxLen === 0 ? 1.0 : Math.max(0, 1.0 - (dist / maxLen));
}

export interface WordMatch {
  expected: string;
  recognized: string | null;
  score: number;
  matched: boolean;
  index: number;
}

export function alignWords(expectedArr: string[], recognizedText: string, tolerance: string): WordMatch[] {
  const rec = norm(recognizedText).split(/\s+/).filter(w => w.length > 0);
  const thr = ({strict: 0.72, normal: 0.56, loose: 0.42} as Record<string, number>)[tolerance] || 0.56;

  const matches: WordMatch[] = [];
  let recIdx = 0;

  for (let expIdx = 0; expIdx < expectedArr.length; expIdx++) {
    const expWord = expectedArr[expIdx];
    let best = {score: 0, recIdx: -1, recWord: null as string | null};

    const winStart = Math.max(0, recIdx - 2);
    const winEnd = Math.min(rec.length, recIdx + 5);

    for (let i = winStart; i < winEnd; i++) {
      const score = phoneticScore(expWord, rec[i]);
      if (score > best.score) best = {score, recIdx: i, recWord: rec[i]};
    }

    matches.push({
      expected: expWord,
      recognized: best.recWord,
      score: best.score,
      matched: best.score >= thr,
      index: best.recIdx,
    });

    if (best.score >= thr && best.recIdx >= recIdx) recIdx = best.recIdx + 1;
  }
  return matches;
}

export interface BaytAlignment {
  coverage: number;
  lastMatch: number;
  matches: WordMatch[];
  totalWords: number;
  matchedWords: number;
  isComplete: boolean;
}

export function findBestBaytAlignment(baytText: string, recognizedText: string, tolerance: string): BaytAlignment {
  const words = baytText.split(/\s+/).filter(w => w.length > 0);
  const matches = alignWords(words, recognizedText, tolerance);
  const matched = matches.filter(m => m.matched).length;
  const coverage = words.length > 0 ? matched / words.length : 0;

  let lastMatch = -1;
  for (let i = matches.length - 1; i >= 0; i--) if (matches[i].matched) { lastMatch = i; break; }

  return {coverage, lastMatch, matches, totalWords: words.length, matchedWords: matched, isComplete: coverage >= 0.80};
}

export const MATCH_TOLERANCE = 0.34;
export const TOLERANCE_PRESETS: Record<string, number> = {strict: 0.20, normal: 0.34, loose: 0.48};

// Avance le curseur `ptr` dans le bayt attendu (wsNorm: mots déjà normalisés)
// en fonction du texte reconnu le plus récent. Deux passes : d'abord un
// alignement caractère brut tolérant (rapide, capte la majorité des cas),
// puis, si aucune avancée n'est trouvée, un repli sur l'alignement
// phonétique (findBestBaytAlignment) qui absorbe les confusions du type
// "مغرام" vs "إدغام" observées sur le CTC.
export function tryAdvance(ptr: number, wsNorm: string[], recognizedText: string, factor?: number): number {
  const tol = factor || MATCH_TOLERANCE;
  const rFlat = norm(recognizedText).replace(/\s+/g, '');
  if (!rFlat) return ptr;

  let bestPtr = ptr;
  const maxOffset = Math.min(6, rFlat.length - 1);

  for (let off = 0; off <= maxOffset; off++) {
    const rSub = rFlat.slice(off);
    if (!rSub) break;

    let acc = '';
    const maxLook = Math.min(wsNorm.length, ptr + 14);

    for (let i = ptr; i < maxLook; i++) {
      acc += wsNorm[i];
      if (acc.length > rSub.length + 8) break;
      if (rSub.length < acc.length) break;

      const candidate = rSub.slice(0, acc.length);
      const dist = levenshtein(acc, candidate);
      const threshold = Math.max(1, Math.ceil(acc.length * tol));

      if (dist <= threshold && i + 1 > bestPtr) bestPtr = i + 1;
    }
  }

  if (bestPtr <= ptr && recognizedText.length > 10) {
    let modeName = 'normal';
    for (const k in TOLERANCE_PRESETS) { if (TOLERANCE_PRESETS[k] === tol) { modeName = k; break; } }
    const covThreshold = ({strict: 0.75, normal: 0.62, loose: 0.52} as Record<string, number>)[modeName] || 0.62;
    const remainingWords = wsNorm.slice(ptr);
    const remainingText = remainingWords.join(' ');
    const phonAlign = findBestBaytAlignment(remainingText, recognizedText, modeName);
    if (phonAlign.coverage >= covThreshold) {
      let advanceBy = 0;
      for (let i = 0; i < phonAlign.matches.length; i++) {
        if (phonAlign.matches[i].matched) advanceBy = i + 1;
      }
      // Un grand saut d'un coup (>3 mots) doit être particulièrement sûr,
      // pour éviter qu'une transcription bruitée ne "termine" plusieurs mots
      // à la fois.
      if (advanceBy > 3 && phonAlign.coverage < covThreshold + 0.15) advanceBy = 0;
      if (advanceBy > 0) bestPtr = ptr + advanceBy;
    }
  }

  return bestPtr;
}

// Regarde, SANS avancer le pointeur, si le tout prochain mot attendu (ptr) a
// déjà un écho partiel dans ce qui vient d'être entendu — même sous le seuil
// de validation. Sert uniquement à donner un retour visuel "ça arrive"
// pendant la récitation (surbrillance douce), jamais à valider un mot :
// c'est le rôle de tryAdvance.
export function peekNearMatch(ptr: number, wsNorm: string[], recognizedText: string, factor?: number): boolean {
  if (ptr >= wsNorm.length || !recognizedText) return false;
  const tol = factor || MATCH_TOLERANCE;
  const rFlat = norm(recognizedText).replace(/\s+/g, '');
  if (!rFlat) return false;
  const target = wsNorm[ptr];
  if (!target) return false;
  const nearThreshold = Math.max(2, Math.ceil(target.length * tol * 1.8));
  const maxOffset = Math.min(6, Math.max(0, rFlat.length - 1));
  for (let off = 0; off <= maxOffset; off++) {
    const rSub = rFlat.slice(off, off + target.length + 3);
    if (!rSub) continue;
    const candidate = rSub.slice(0, Math.min(target.length, rSub.length));
    if (!candidate) continue;
    const dist = levenshtein(candidate, target.slice(0, candidate.length));
    if (dist <= nearThreshold) return true;
  }
  return false;
}
