// Replay du LiveCursor (liveCursor.ts) v5.5.0 — algorithme adapté de
// hifz-tracker (runs de mots exacts, saut de secours à double preuve,
// anti-ambiguïté sur répétitions). Remplace l'ancienne version à seuil de
// similarité flou (5.4.0), moins robuste sur nos tests réels.
//
// Réimplémentation JS fidèle de src/normalize.ts + src/liveCursor.ts (pas
// d'import direct : ce script tourne en Node sans bundler ; à garder
// synchronisé si liveCursor.ts change).
import fs from 'node:fs';

const DIACRITICS = /[\u064B-\u0652\u0670\u0640]/g;
function normalizeArabicLight(s = '') {
  return String(s).normalize('NFKC').replace(DIACRITICS, '').replace(/[آأإٱ]/g, 'ا').replace(/ى/g, 'ي')
    .replace(/[،؛؟,:.!؟\-–—()[\]{}«»]/g, ' ').replace(/\s+/g, ' ').trim();
}
function normalizeArabic(s = '') {
  return normalizeArabicLight(s).replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/ء/g, '');
}
function normalizeHeard(s = '') {
  return normalizeArabic(s).replace(/(.)\1+/g, '$1');
}

const MIN_RUN = 2, LOOKBEHIND = 12, LOOKAHEAD = 30, INITIAL_ANCHOR_ZONE = 3, FINAL_ANCHOR_ZONE = 3;

class LiveCursor {
  constructor(expected = []) {
    this.expected = expected.map(normalizeArabic).filter(Boolean);
    this.comparisonKeys = this.expected.map(w => w.replace(/(.)\1+/g, '$1'));
    this.expectedPositionsByWord = new Map();
    this.comparisonKeys.forEach((w, i) => { if (!w) return; const l = this.expectedPositionsByWord.get(w) ?? []; l.push(i); this.expectedPositionsByWord.set(w, l); });
    this.reset();
  }
  reset() { this.acceptedOffset = -1; this.fullHeard = []; this.words = this.expected.map((expected, index) => ({expected, heard: null, score: 0, status: 'pending', index})); }
  advance(cumulativeWords) {
    const normalized = cumulativeWords.map(normalizeHeard).filter(Boolean);
    if (normalized.length < this.fullHeard.length) return this.snapshot();
    this.fullHeard = normalized;
    if (!this.expected.length || !this.fullHeard.length) return this.snapshot();

    for (let safetyCounter = 0; safetyCounter < this.expected.length; safetyCounter++) {
      const searchRange = this.acceptedOffset < 0 ? [0, this.expected.length] : [Math.max(0, this.acceptedOffset - LOOKBEHIND), Math.min(this.expected.length, this.acceptedOffset + LOOKAHEAD + 1)];

      const advancing = this.locate(searchRange, this.acceptedOffset);
      if (advancing) {
        const ambiguous = advancing.expectedStart > this.acceptedOffset + 1 && this.isAmbiguous(advancing, searchRange);
        if (!ambiguous) { this.applyMatch(advancing); continue; }
      }
      if (this.acceptedOffset >= 0) {
        const gapped = this.locateAcrossSingleGap(searchRange, this.acceptedOffset);
        if (gapped) { this.applyGapMatch(gapped); continue; }
      }
      break;
    }
    return this.snapshot();
  }
  locate(searchRange, completingAfter) {
    const isInitialAnchor = completingAfter < 0;
    const isFinalAnchorZone = (start) => start >= this.expected.length - FINAL_ANCHOR_ZONE;
    const minimumWordLength = 4;
    let best = null;
    for (let heardStart = 0; heardStart < this.fullHeard.length; heardStart++) {
      const word = this.fullHeard[heardStart];
      const starts = this.expectedPositionsByWord.get(word);
      if (!starts) continue;
      for (const expectedStart of starts) {
        if (expectedStart < searchRange[0]) continue;
        if (expectedStart >= searchRange[1]) break;
        if (isInitialAnchor && expectedStart >= INITIAL_ANCHOR_ZONE) continue;
        const length = this.runLength(expectedStart, heardStart, searchRange[1]);
        const isLastExpectedWord = expectedStart === this.expected.length - 1;
        const isFinalSingleAnchor = !isInitialAnchor && isLastExpectedWord && isFinalAnchorZone(expectedStart);
        const minimumRun = (isInitialAnchor || isFinalSingleAnchor) ? 1 : MIN_RUN;
        if (length < minimumRun) continue;
        if (length === 1 && word.length < minimumWordLength) continue;
        if (expectedStart + length - 1 <= completingAfter) continue;
        const candidate = {expectedStart, heardStart, length};
        if (this.isBetterRun(candidate, best)) best = candidate;
      }
    }
    return best;
  }
  locateAcrossSingleGap(searchRange, acceptedOffset) {
    let best = null;
    for (let heardStart = 0; heardStart < this.fullHeard.length; heardStart++) {
      const word = this.fullHeard[heardStart];
      const starts = this.expectedPositionsByWord.get(word);
      if (!starts) continue;
      for (const expectedStart of starts) {
        if (expectedStart < searchRange[0]) continue;
        if (expectedStart >= searchRange[1]) break;
        const prefixLength = this.runLength(expectedStart, heardStart, searchRange[1]);
        if (prefixLength < MIN_RUN) continue;
        const expectedGap = expectedStart + prefixLength;
        const heardGap = heardStart + prefixLength;
        if (expectedGap !== acceptedOffset + 1) continue;
        if (expectedGap >= searchRange[1] || heardGap >= this.fullHeard.length) continue;
        const suffixExpectedStart = expectedGap + 1;
        const suffixHeardStart = heardGap + 1;
        if (suffixExpectedStart >= searchRange[1] || suffixHeardStart >= this.fullHeard.length) continue;
        const suffixLength = this.runLength(suffixExpectedStart, suffixHeardStart, searchRange[1]);
        if (suffixLength <= 0) continue;
        const expectedEnd = suffixExpectedStart + suffixLength;
        const candidate = {expectedStart, heardStart, expectedEnd, heardEnd: suffixHeardStart + suffixLength, matchedWordCount: prefixLength + suffixLength};
        if (!best || expectedEnd > best.expectedEnd || (expectedEnd === best.expectedEnd && candidate.matchedWordCount > best.matchedWordCount)) best = candidate;
      }
    }
    return best;
  }
  runLength(expectedStart, heardStart, expectedUpperBound) {
    let length = 0;
    while (expectedStart + length < expectedUpperBound && heardStart + length < this.fullHeard.length && this.comparisonKeys[expectedStart + length] === this.fullHeard[heardStart + length]) length++;
    return length;
  }
  isBetterRun(a, b) {
    if (!b) return true;
    if (a.length !== b.length) return a.length > b.length;
    if (a.expectedStart !== b.expectedStart) return a.expectedStart < b.expectedStart;
    return (a.heardStart + a.length) > (b.heardStart + b.length);
  }
  isAmbiguous(match, searchRange) {
    const phrase = this.comparisonKeys.slice(match.expectedStart, match.expectedStart + match.length);
    const searchable = this.comparisonKeys.slice(searchRange[0], searchRange[1]);
    return this.occurrenceCount(phrase, searchable) > 1;
  }
  occurrenceCount(phrase, within) {
    if (!phrase.length || phrase.length > within.length) return 0;
    let count = 0;
    for (let start = 0; start <= within.length - phrase.length; start++) {
      let matches = true;
      for (let offset = 0; offset < phrase.length; offset++) if (within[start + offset] !== phrase[offset]) { matches = false; break; }
      if (matches && ++count > 1) return count;
    }
    return count;
  }
  applyMatch(match) {
    for (let i = this.acceptedOffset + 1; i < match.expectedStart; i++) {
      if (this.words[i]?.status === 'pending') this.words[i].status = 'skipped';
    }
    for (let i = 0; i < match.length; i++) {
      const w = this.words[match.expectedStart + i];
      if (w.status === 'pending') { w.heard = this.fullHeard[match.heardStart + i]; w.score = 1; w.status = 'matched'; }
    }
    this.acceptedOffset = match.expectedStart + match.length - 1;
  }
  applyGapMatch(match) {
    const gapIndex = match.expectedStart + (this.acceptedOffset + 1 - match.expectedStart);
    for (let i = match.expectedStart; i < gapIndex; i++) {
      const w = this.words[i];
      if (w && w.status === 'pending') { w.heard = this.fullHeard[match.heardStart + (i - match.expectedStart)]; w.score = 1; w.status = 'matched'; }
    }
    if (this.words[gapIndex]?.status === 'pending') this.words[gapIndex].status = 'skipped';
    const suffixExpectedStart = gapIndex + 1;
    const suffixLength = match.expectedEnd - suffixExpectedStart;
    const suffixHeardStart = match.heardEnd - suffixLength;
    for (let i = 0; i < suffixLength; i++) {
      const w = this.words[suffixExpectedStart + i];
      if (w && w.status === 'pending') { w.heard = this.fullHeard[suffixHeardStart + i]; w.score = 1; w.status = 'matched'; }
    }
    this.acceptedOffset = match.expectedEnd - 1;
  }
  snapshot() { return this.words.map(w => ({...w})); }
  report() { const c = {pending: 0, matched: 0, skipped: 0, uncertain: 0}; this.words.forEach(w => c[w.status]++); return {...c, total: this.words.length, position: this.acceptedOffset + 1}; }
}

const expected40 = ['يقول','راجي','رحمه','الغفور','دوما','سليمان','هو','الجمزوري','الحمد','له','مصليا','علي','محمد','واله','ومن','تلا','وبعد','هذا','النظم','لمريد','في','النون','والتنوين','والمدود','سميته','بتحفه','الاطفال','عن','شيخنا','الميهي','ذي','الكمال','ارجو','به','ان','ينفع','الطلابا','والاجر','والقبول','والثوابا'];

const REAL_TESTS = [
  {name: 'lent_5.4', heard: 'يقول راجي رحمتمة غفوري دما. سليمان. هو الجنزور الحمد لله مصليا على محمدٍ وآله ومن تلا وبعد هذا النظم للمريدِ المريد في النون والتنوين والمدودِ سسميته ته بتحفة الأاطفال عن شيخنا من المي الكالي أرجو به أن ينفع الطلَّاب وَالْأَجْرَ والثوابا واب.'},
  {name: 'rapide_5.4', heard: 'يقول راجي رحمة دوما سليمان هو الجمزوري الحمد لله مصليا على محمد محمدٍ وآله ومن تلا و بعد هذا النظم للمريد في النون والتنوين والمدود سسميته بتحفة الأف عن شيخنا الميهيد ذي الكمال أرجو به أن ينفع والأجر القبول وا'},
  {name: 'moyenne_5.5', heard: 'يقول رحمة الغفور دوما هوجَنْزُورْ والجنزور الحمد لله مصليا على محمد وآله ه ومن تلا هذا وبعد هذا النظم للمريد في النون والتنوين والمدودِ سسميته بتحفة أطفالي شيخنا الميهييد ذي الكمال أرجو به أن ينفع ينفع الطلابا والأجر القبول'},
  {name: 'lent_5.5', heard: 'يقول راجي رحمة الغفور سليمان هو الجنزور زوري الحمد ال مصليا صليا على محمدٍ وآله و منبتلا وبعد هذا هذا النظم للمريد في والتنويينِ تنويني والمدودِ ي سميت بتفة الأطفال عن شخنا المييذِ ذي الكالي أَرْجُو بِهِ أن ينفع الطلَّابَ والأ وَالْأَجْرَ وَالْقَبُولَ قبول والثوابا'},
  {name: 'normale_5.6.1', heard: 'يقول رحمة غفور دوما سليمان هو الجَنْزوري الحمد لله لله مصليا على محمد محمدٍ وآله ومن تلا وبعد هذا هذا النظم للمريد في والتنوين ين والمدودِ سسميته بتحفة الأاطفال عن شيخنا الميه ذ به أن ينفع والأجرْرَ وَالْقَبُولَ والثوابا'},
];

const results = {};
for (const t of REAL_TESTS) {
  const heardWords = t.heard.split(/\s+/).filter(Boolean);
  const cursor = new LiveCursor(expected40);
  for (let i = 1; i <= heardWords.length; i++) cursor.advance(heardWords.slice(0, i));
  results[t.name] = cursor.report();
}

const windows = JSON.parse(fs.readFileSync(new URL('./replay-windows.json', import.meta.url), 'utf8'));
const cursor40 = new LiveCursor(expected40);
let cumulative = [];
for (const w of windows) { cumulative = cumulative.concat(w.split(/\s+/).filter(Boolean)); cursor40.advance(cumulative); }
results['capture_61_mots_texte_muqaddima_reel_40_mots'] = cursor40.report();

console.log(JSON.stringify(results, null, 2));

