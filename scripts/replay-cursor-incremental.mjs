// NOTE (5.6.0) : ce script utilise encore l'ancienne normalizeArabic avec
// dédup de lettres répétées appliquée uniformément (bug corrigé dans le
// vrai normalize.ts — voir CHANGELOG). Non mis à jour ici car Cursor/
// alignMonotone ne sont plus utilisés par main.ts depuis 5.4.0 (voir
// cursor.ts) ; les scores de ce script ne reflètent donc plus le
// comportement réel de l'app, seulement une référence historique.
//
// Replay incrémental fidèle au vrai pipeline : appelle Cursor.advance() une
// fois par fenêtre ASR cumulée, exactement comme main.ts le fait en pratique
// (this.heard accumule tout le transcript depuis le début de la session).
//
// Contrairement à l'ancien replay-cursor.mjs (DP global en un seul passage
// sur tout le texte, jamais incrémental), ce script est un vrai test de
// non-régression pour le bug de désynchronisation position/heardPosition
// découvert sur le test "muqaddima entière" (5.3.0) : au-delà d'un certain
// point de dérive ASR, alignMonotone pouvait faire avancer `position` plus
// vite que `heardPosition` ne le justifiait (skip pas cher, evidence faible),
// désynchronisant les deux compteurs pour le reste de la session.
//
// Réimplémentation JS fidèle de src/normalize.ts + src/alignment.ts +
// src/cursor.ts (pas d'import direct car ce script tourne en Node sans
// bundler ; à garder synchronisé si ces fichiers changent).
import fs from 'node:fs';

const DIACRITICS = /[\u064B-\u0652\u0670\u0640]/g;
function normalizeArabicLight(s = '') {
  return String(s).normalize('NFKC').replace(DIACRITICS, '').replace(/[آأإٱ]/g, 'ا').replace(/ى/g, 'ي')
    .replace(/[،؛؟,:.!؟\-–—()[\]{}«»]/g, ' ').replace(/\s+/g, ' ').trim();
}
function normalizeArabic(s = '') {
  return normalizeArabicLight(s).replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/ء/g, '');
}
function boundedLevenshtein(a, b) {
  let p = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const c = [i];
    for (let j = 1; j <= b.length; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    p = c;
  }
  return p[b.length];
}
function similarity(a, b) {
  const x = normalizeArabic(a), y = normalizeArabic(b), m = Math.max(x.length, y.length);
  return m ? Math.max(0, 1 - boundedLevenshtein(x, y) / m) : 1;
}

const INF = 1e9;
function alignMonotone(expectedRaw, heardRaw, previousExpected = 0, previousHeard = 0, options = {}) {
  const expected = expectedRaw.map(normalizeArabic).filter(Boolean);
  const heard = heardRaw.map(normalizeArabic).filter(Boolean);
  const window = options.window ?? 12;
  const maxSkip = options.maxSkip ?? 1; // voir CHANGELOG 5.3.1 : réduit de 3 à 1
  const e0 = Math.max(0, Math.min(previousExpected, expected.length));
  const h0 = Math.max(0, Math.min(previousHeard, heard.length));
  const e = expected.slice(e0, Math.min(expected.length, e0 + window));
  const h = heard.slice(h0);
  const n = e.length, m = h.length;
  if (!n || !m) return {steps: [], nextExpected: e0, nextHeard: h0, coverage: 0};
  const dp = Array.from({length: n + 1}, () => Array(m + 1).fill(INF));
  const back = Array.from({length: n + 1}, () => Array(m + 1).fill(null));
  dp[0][0] = 0;
  for (let i = 0; i <= n; i++) for (let j = 0; j <= m; j++) {
    if (i === 0 && j === 0) continue;
    if (i > 0 && dp[i - 1][j] + 0.78 < dp[i][j]) { dp[i][j] = dp[i - 1][j] + 0.78; back[i][j] = [i - 1, j, 'skip']; }
    if (j > 0 && dp[i][j - 1] + 0.42 < dp[i][j]) { dp[i][j] = dp[i][j - 1] + 0.42; back[i][j] = [i, j - 1, 'insert']; }
    if (i > 0 && j > 0) {
      const s = similarity(e[i - 1], h[j - 1]);
      if (dp[i - 1][j - 1] + (1 - s) < dp[i][j]) { dp[i][j] = dp[i - 1][j - 1] + (1 - s); back[i][j] = [i - 1, j - 1, s >= 0.72 ? 'match' : 'uncertain']; }
    }
  }
  const reverse = [];
  let i = n, j = m;
  while (i || j) {
    const b = back[i][j];
    if (!b) break;
    const [pi, pj, decision] = b;
    if (decision !== 'insert') reverse.push({expectedIndex: e0 + i - 1, heardIndex: h0 + j - 1, score: decision === 'skip' ? 0 : similarity(e[i - 1], h[j - 1]), decision});
    i = pi; j = pj;
  }
  const steps = reverse.reverse();
  let advance = e0, nextHeard = h0;
  let evidence = 0, matched = 0, skipped = 0;
  for (const step of steps) {
    if (step.expectedIndex !== advance) continue;
    if (step.decision === 'match' || (step.decision === 'uncertain' && step.score >= 0.55)) { advance++; matched++; nextHeard = Math.max(nextHeard, (step.heardIndex ?? h0) + 1); }
    else if (step.decision === 'skip' && skipped < maxSkip && matched >= 2) { advance++; skipped++; }
    else break;
    evidence++;
  }
  return {steps, nextExpected: advance, nextHeard, coverage: evidence / Math.max(1, matched + skipped)};
}

class Cursor {
  constructor(expected = []) { this.expected = expected.map(normalizeArabic).filter(Boolean); this.reset(); }
  reset() { this.heard = []; this.position = 0; this.heardPosition = 0; this.words = this.expected.map((expected, index) => ({expected, heard: null, score: 0, status: 'pending', index, heardIndex: null})); }
  advance(words) {
    const normalized = words.map(normalizeArabic).filter(Boolean);
    if (normalized.length < this.heard.length) return this.snapshot();
    this.heard = normalized;
    const result = alignMonotone(this.expected, this.heard, this.position, this.heardPosition, {window: 12, maxSkip: 1});
    // voir CHANGELOG 5.3.2 : ne marquer que le préfixe réellement validé
    for (const step of result.steps) {
      if (step.expectedIndex >= result.nextExpected) continue;
      const w = this.words[step.expectedIndex];
      if (!w || w.status !== 'pending') continue;
      if (step.decision === 'match' || step.decision === 'uncertain') {
        w.heard = this.heard[step.heardIndex ?? 0] ?? null; w.score = step.score; w.heardIndex = step.heardIndex;
        w.status = step.decision === 'match' ? 'matched' : 'uncertain';
      }
    }
    this.position = Math.max(this.position, result.nextExpected);
    this.heardPosition = Math.max(this.heardPosition, result.nextHeard);
    return this.snapshot();
  }
  snapshot() { return this.words.map(w => ({...w})); }
  report() { const c = {pending: 0, matched: 0, skipped: 0, uncertain: 0}; this.words.forEach(w => c[w.status]++); return {...c, total: this.words.length, position: this.position}; }
}

const windows = JSON.parse(fs.readFileSync(new URL('./replay-windows.json', import.meta.url), 'utf8'));
const expected = ['بدات','بسم','اله','في','النظم','اولا','تبارك','رحمانا','رحيما','ومويلا','وثنيت','صلي','اله','ربي','علي','الرضا','محمد','المهدي','الي','الناس','مرسلا','يقول','راجي','رحمه','الغفور','دوما','سليمان','هو','الجمزوري','الحمد','له','مصليا','علي','محمد','واله','ومن','تلا','وبعد','هذا','النظم','لمريد','في','النون','والتنوين','والمدود','سميته','بتحفه','الاطفال','عن','شيخنا','الميهي','ذي','الكمال','ارجو','به','ان','ينفع','الطلابا','والاجر','والقبول','والثوابا'];

function run() {
  const cursor = new Cursor(expected);
  let cumulative = [];
  for (const w of windows) {
    cumulative = cumulative.concat(w.split(/\s+/).filter(Boolean));
    cursor.advance(cumulative);
  }
  return cursor.report();
}

const a = run();
console.log(JSON.stringify({run1: a, run2: run(), deterministic: JSON.stringify(a) === JSON.stringify(run())}, null, 2));
