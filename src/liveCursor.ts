import {tokenizeExpected, tokenizeRaw, normalizeArabic, normalizeHeard} from './normalize';

export type LiveStatus = 'pending' | 'matched' | 'uncertain' | 'skipped';
// NOTE (5.5.0) : 'uncertain' n'est plus jamais assigné par cet algorithme —
// le matching est exact (runs de mots identiques après normalisation), il
// n'y a plus de score de similarité intermédiaire à distinguer. Conservé
// dans le type pour rester compatible avec cursorView.ts (qui sait déjà
// l'afficher) et avec un futur retour à un scoring flou si besoin.
export interface LiveWord { expected: string; heard: string | null; score: number; status: LiveStatus; index: number; }

interface RunMatch { expectedStart: number; heardStart: number; length: number; }
interface GapMatch { expectedStart: number; heardStart: number; expectedEnd: number; heardEnd: number; matchedWordCount: number; }

/**
 * Curseur "karaoké" : le texte attendu est connu à l'avance (bab/bayt choisi
 * dans MutuniDB). Algorithme adapté de hifz-tracker
 * (Sources/HifzCore/TranscriptPositionLocator.swift, moabdelmoez/hifz-tracker) :
 *
 * - Matching EXACT (texte normalisé), pas de score de similarité flou. La
 *   tolérance vient d'exiger un run d'au moins MIN_RUN mots consécutifs
 *   identiques pour valider une position — un mot isolé, même exact, ne
 *   suffit jamais. Ça filtre mieux le bruit qu'un seuil de similarité choisi
 *   à la main (testé empiriquement : cette version fait 95%/90%/90% sur nos
 *   3 captures réelles contre 75%/90%/100% pour une v5.4.0 à seuil flou —
 *   nettement plus robuste sur les cas difficiles, voir CHANGELOG 5.5.0).
 * - Saut de secours à DOUBLE preuve (locateAdvancingAcrossSingleGap) : si le
 *   mot juste après la position courante est introuvable (probable perte
 *   ASR), on cherche un run avant ET un run après ce trou — jamais un seul
 *   mot isolé qui matcherait par hasard.
 * - Garde anti-ambiguïté : un saut vers l'avant qui franchit plus d'un mot
 *   est refusé si la phrase qui le justifie apparaît plusieurs fois dans le
 *   texte attendu (mots très répétés comme "الحمد لله") — évite de sauter
 *   au mauvais endroit sur une répétition.
 *
 * Différent de Cursor/alignMonotone (alignment.ts, DP bandé tolérant), qui
 * reste dans le dépôt pour un futur rapport de fin de session (mode premium
 * rouge/jaune/vert), pas pour le curseur affiché en direct.
 */
export class LiveCursor {
  private static readonly MIN_RUN = 2; // taille minimale d'un run de mots exacts pour valider une position
  private static readonly LOOKBEHIND = 12; // marge arrière dans la zone de recherche (permet de re-matcher un mot déjà proche si l'ASR répète)
  private static readonly LOOKAHEAD = 30; // marge avant, bornée : jamais toute la fin du texte comme dans hifz-tracker (96), nos bayts sont courts
  private static readonly INITIAL_ANCHOR_ZONE = 3; // ancrage initial à 1 mot autorisé seulement parmi les 3 premiers mots attendus
  private static readonly FINAL_ANCHOR_ZONE = 3; // symétrique : ancrage à 1 mot autorisé pour le tout dernier mot attendu, seulement s'il est parmi les 3 derniers

  private expected: string[] = []; // texte normalisé, utilisé UNIQUEMENT en interne pour construire comparisonKeys — jamais affiché directement
  private displayText: string[] = []; // vrai texte source (harakat comprises), affiché à l'utilisateur via LiveWord.expected — voir setExpected
  private comparisonKeys: string[] = []; // même longueur que expected, dédupliqué pour la comparaison uniquement — voir setExpected
  private words: LiveWord[] = [];
  private expectedPositionsByWord: Map<string, number[]> = new Map();
  private acceptedOffset = -1; // dernier index expected confirmé, -1 = rien encore confirmé
  private fullHeard: string[] = []; // texte cumulé complet (clés de comparaison), conservé pour le rapport de fin de session (mode premium)

  constructor(expected: string | string[] = '') { this.setExpected(expected); }

  setExpected(e: string | string[]) {
    // BUG CORRIGÉ (5.6.3) : le texte affiché à l'utilisateur passait par
    // tokenizeExpected/normalizeArabic, qui retire les harakat et substitue
    // des lettres (ة->ه, ى->ي...) — donc "رَحْمَةِ" s'affichait "رحمه" et
    // "عَلَى" s'affichait "علي". Le texte affiché n'était déjà plus le vrai
    // texte source. displayText (tokenizeRaw, aucune substitution) est
    // maintenant la seule source pour LiveWord.expected ; expected/
    // comparisonKeys restent normalisés mais servent uniquement en interne
    // au matching. Les deux tokenisations segmentent le texte de façon
    // identique (mêmes espaces/ponctuation retirés), donc restent alignées
    // index par index — vérifié sur les bayts réels de mutuniDB.
    if (Array.isArray(e)) {
      const raw = e.map(w => String(w).trim());
      const norm = e.map(normalizeArabic);
      this.displayText = []; this.expected = [];
      raw.forEach((r, i) => { if (norm[i]) { this.displayText.push(r); this.expected.push(norm[i]); } });
    } else {
      this.displayText = tokenizeRaw(e);
      this.expected = tokenizeExpected(e);
    }
    // Clé de comparaison : même dédup que le texte ASR (normalizeHeard),
    // appliquée ici aussi côté expected — sinon un mot correctement reconnu
    // par l'ASR (ex. "الله", légitimement doublé) ne matcherait jamais le
    // texte source non dédupliqué. La dédup ne sert donc qu'à la
    // comparaison interne ; displayText (affiché) reste le vrai texte.
    this.comparisonKeys = this.expected.map(w => w.replace(/(.)\1+/g, '$1'));
    this.expectedPositionsByWord = new Map();
    this.comparisonKeys.forEach((w, i) => {
      if (!w) return;
      const list = this.expectedPositionsByWord.get(w) ?? [];
      list.push(i);
      this.expectedPositionsByWord.set(w, list);
    });
    this.reset();
  }

  reset() {
    this.acceptedOffset = -1;
    this.fullHeard = [];
    this.words = this.displayText.map((expected, index) => ({expected, heard: null, score: 0, status: 'pending', index}));
  }

  /**
   * À appeler avec le texte cumulé complet reconnu depuis le début de la
   * session, comme le pipeline existant le fait déjà (main.ts accumule
   * `heardWords`).
   */
  advance(cumulativeWords: string[]) {
    const normalized = cumulativeWords.map(normalizeHeard).filter(Boolean);
    if (normalized.length < this.fullHeard.length) return this.snapshot(); // texte plus court : résultat tardif, ignoré
    this.fullHeard = normalized;
    if (!this.expected.length || !this.fullHeard.length) return this.snapshot();

    // Boucle : on retente avance normale puis gap tant qu'un progrès est
    // possible, plutôt qu'un seul essai par appel. Nécessaire car notre ASR
    // local (petit modèle, fenêtré 3s) perd des mots isolés plus souvent
    // qu'un ASR de référence type Whisper : un seul mot manquant entre deux
    // séquences par ailleurs exactes ne doit pas bloquer indéfiniment tout
    // le reste, même si ce mot n'est pas juste après acceptedOffset (voir
    // CHANGELOG 5.5.1 — test réel où محمد/الحمد/مصليا, tous exacts et bien
    // placés, restaient bloqués en pending à cause d'un seul mot absent
    // juste avant chacun).
    for (let safetyCounter = 0; safetyCounter < this.expected.length; safetyCounter++) {
      const searchRange = this.acceptedOffset < 0
        ? [0, this.expected.length] as const
        : [Math.max(0, this.acceptedOffset - LiveCursor.LOOKBEHIND), Math.min(this.expected.length, this.acceptedOffset + LiveCursor.LOOKAHEAD + 1)] as const;

      const advancing = this.locate(searchRange, this.acceptedOffset);
      if (advancing) {
        const ambiguous = advancing.expectedStart > this.acceptedOffset + 1 && this.isAmbiguous(advancing, searchRange);
        if (!ambiguous) { this.applyMatch(advancing); continue; }
      }

      if (this.acceptedOffset >= 0) {
        const gapped = this.locateAcrossSingleGap(searchRange, this.acceptedOffset);
        if (gapped) { this.applyGapMatch(gapped); continue; }
      }

      break; // plus aucun progrès possible avec les preuves actuelles
    }
    return this.snapshot();
  }

  private locate(searchRange: readonly [number, number], completingAfter: number): RunMatch | null {
    // Ancrage initial assoupli (5.5.1) : tant qu'aucune position n'est
    // encore acceptée, un run de 1 mot suffit s'il est assez long (≥4
    // caractères normalisés) ET situé parmi les tout premiers mots attendus
    // (INITIAL_ANCHOR_ZONE) — jamais n'importe où dans le texte. Sans cette
    // restriction de zone, un mot court par ailleurs valide (ex. "علي", 3
    // lettres) peut s'ancrer par coïncidence bien plus loin dans le texte et
    // verrouiller le curseur sur une mauvaise position dès le départ (testé
    // et cassé une première fois avant cette restriction, voir CHANGELOG
    // 5.5.1). Sans assouplissement du tout, si le tout premier mot du texte
    // est suivi d'un mot que l'ASR a raté, aucun run de 2 ne peut jamais se
    // former et le curseur ne démarre jamais (voir test "vitesse moyenne").
    //
    // BUG CORRIGÉ (5.7.2) : symétrique côté FIN de bayt, absent jusqu'ici.
    // MIN_RUN=2 exige une preuve par paire de mots consécutifs — mais le
    // tout dernier mot attendu du bayt n'a, par définition, aucun mot après
    // lui pour compléter une paire. Aucun run ≥2 ne pouvait donc jamais se
    // former sur ce mot, quelle que soit la qualité de la reconnaissance :
    // il restait bloqué en 'pending' jusqu'à ce que l'utilisateur le répète
    // (un doublon accidentel formait alors un faux run de 2 identiques).
    // Signalé par l'utilisateur en test réel v5.7.1 ("je dois répéter le
    // dernier mot du bayt"). Même garde-fou que l'ancrage initial (mot ≥4
    // caractères normalisés) et même restriction de zone, en miroir sur les
    // FINAL_ANCHOR_ZONE derniers mots — pour éviter qu'un mot court proche
    // de la fin s'ancre par coïncidence trop tôt.
    const isInitialAnchor = completingAfter < 0;
    const isFinalAnchorZone = (start: number) => start >= this.expected.length - LiveCursor.FINAL_ANCHOR_ZONE;
    const minimumWordLength = 4;
    let best: RunMatch | null = null;
    for (let heardStart = 0; heardStart < this.fullHeard.length; heardStart++) {
      const word = this.fullHeard[heardStart];
      const starts = this.expectedPositionsByWord.get(word);
      if (!starts) continue;
      for (const expectedStart of starts) {
        if (expectedStart < searchRange[0]) continue;
        if (expectedStart >= searchRange[1]) break;
        if (isInitialAnchor && expectedStart >= LiveCursor.INITIAL_ANCHOR_ZONE) continue;
        const length = this.runLength(expectedStart, heardStart, searchRange[1]);
        // Un run de 1 mot est accepté soit en ancrage initial (comme avant),
        // soit quand ce mot est le tout dernier mot attendu du texte (aucune
        // paire possible par construction) et se situe dans la zone finale.
        const isLastExpectedWord = expectedStart === this.expected.length - 1;
        const isFinalSingleAnchor = !isInitialAnchor && isLastExpectedWord && isFinalAnchorZone(expectedStart);
        const minimumRun = (isInitialAnchor || isFinalSingleAnchor) ? 1 : LiveCursor.MIN_RUN;
        if (length < minimumRun) continue;
        if (length === 1 && word.length < minimumWordLength) continue; // run de 1 mot : exige un mot assez long
        if (expectedStart + length - 1 <= completingAfter) continue; // n'apporte aucune nouvelle preuve
        const candidate: RunMatch = {expectedStart, heardStart, length};
        if (this.isBetterRun(candidate, best)) best = candidate;
      }
    }
    return best;
  }

  private locateAcrossSingleGap(searchRange: readonly [number, number], acceptedOffset: number): GapMatch | null {
    let best: GapMatch | null = null;
    for (let heardStart = 0; heardStart < this.fullHeard.length; heardStart++) {
      const word = this.fullHeard[heardStart];
      const starts = this.expectedPositionsByWord.get(word);
      if (!starts) continue;
      for (const expectedStart of starts) {
        if (expectedStart < searchRange[0]) continue;
        if (expectedStart >= searchRange[1]) break;
        const prefixLength = this.runLength(expectedStart, heardStart, searchRange[1]);
        if (prefixLength < LiveCursor.MIN_RUN) continue;

        const expectedGap = expectedStart + prefixLength;
        const heardGap = heardStart + prefixLength;
        if (expectedGap !== acceptedOffset + 1) continue; // le trou doit être immédiatement après la position acceptée
        if (expectedGap >= searchRange[1] || heardGap >= this.fullHeard.length) continue;

        const suffixExpectedStart = expectedGap + 1;
        const suffixHeardStart = heardGap + 1;
        if (suffixExpectedStart >= searchRange[1] || suffixHeardStart >= this.fullHeard.length) continue;

        const suffixLength = this.runLength(suffixExpectedStart, suffixHeardStart, searchRange[1]);
        if (suffixLength <= 0) continue;

        const expectedEnd = suffixExpectedStart + suffixLength;
        const candidate: GapMatch = {
          expectedStart, heardStart, expectedEnd,
          heardEnd: suffixHeardStart + suffixLength,
          matchedWordCount: prefixLength + suffixLength,
        };
        if (!best || expectedEnd > best.expectedEnd || (expectedEnd === best.expectedEnd && candidate.matchedWordCount > best.matchedWordCount)) best = candidate;
      }
    }
    return best;
  }

  private runLength(expectedStart: number, heardStart: number, expectedUpperBound: number): number {
    let length = 0;
    while (expectedStart + length < expectedUpperBound && heardStart + length < this.fullHeard.length
      && this.comparisonKeys[expectedStart + length] === this.fullHeard[heardStart + length]) {
      length++;
    }
    return length;
  }

  private isBetterRun(a: RunMatch, b: RunMatch | null): boolean {
    if (!b) return true;
    if (a.length !== b.length) return a.length > b.length;
    if (a.expectedStart !== b.expectedStart) return a.expectedStart < b.expectedStart;
    return (a.heardStart + a.length) > (b.heardStart + b.length);
  }

  /** Un saut multi-mots est ambigu si la phrase qui le justifie apparaît plus d'une fois dans la zone de recherche (ex. répétitions comme "الحمد لله"). */
  private isAmbiguous(match: RunMatch, searchRange: readonly [number, number]): boolean {
    const phrase = this.comparisonKeys.slice(match.expectedStart, match.expectedStart + match.length);
    const searchable = this.comparisonKeys.slice(searchRange[0], searchRange[1]);
    return this.occurrenceCount(phrase, searchable) > 1;
  }

  private occurrenceCount(phrase: string[], within: string[]): number {
    if (!phrase.length || phrase.length > within.length) return 0;
    let count = 0;
    for (let start = 0; start <= within.length - phrase.length; start++) {
      let matches = true;
      for (let offset = 0; offset < phrase.length; offset++) if (within[start + offset] !== phrase[offset]) { matches = false; break; }
      if (matches && ++count > 1) return count;
    }
    return count;
  }

  private applyMatch(match: RunMatch) {
    // Si ce run démarre après acceptedOffset+1, les mots entre les deux ont
    // été sautés sans preuve directe (locate() peut trouver le meilleur run
    // n'importe où dans searchRange, pas seulement juste après
    // acceptedOffset — contrairement à locateAcrossSingleGap qui, lui, ne
    // s'applique qu'à un unique mot manquant juste après). Sans ce
    // marquage, ces mots restaient en 'pending' indéfiniment alors que le
    // curseur (position/acceptedOffset) les avait déjà dépassés — bug
    // trouvé sur test réel 5.6.1 : راجي/رحمه/الغفور restaient 'pending'
    // alors que "Progression (curseur)" affichait 40/40 (100%). Marqués
    // 'skipped' (pas 'matched') pour rester visibles dans le rapport.
    for (let i = this.acceptedOffset + 1; i < match.expectedStart; i++) {
      if (this.words[i]?.status === 'pending') this.words[i].status = 'skipped';
    }
    for (let i = 0; i < match.length; i++) {
      const w = this.words[match.expectedStart + i];
      if (w.status === 'pending') { w.heard = this.fullHeard[match.heardStart + i]; w.score = 1; w.status = 'matched'; }
    }
    this.acceptedOffset = match.expectedStart + match.length - 1;
  }

  private applyGapMatch(match: GapMatch) {
    // Préfixe : de match.expectedStart jusqu'au trou (exclu).
    const gapIndex = match.expectedStart + (this.acceptedOffset + 1 - match.expectedStart);
    for (let i = match.expectedStart; i < gapIndex; i++) {
      const w = this.words[i];
      if (w && w.status === 'pending') { w.heard = this.fullHeard[match.heardStart + (i - match.expectedStart)]; w.score = 1; w.status = 'matched'; }
    }
    // Le mot au niveau du trou reste sans preuve directe : probable perte
    // ASR plutôt qu'un vrai saut du récitateur (voir test "rapide" 5.3.1 :
    // الغفور absent du transcript, دوما parfait juste après). Marqué
    // 'skipped', pas 'matched' — reste visible pour le rapport.
    if (this.words[gapIndex]?.status === 'pending') this.words[gapIndex].status = 'skipped';

    // Suffixe : de juste après le trou jusqu'à expectedEnd.
    const suffixExpectedStart = gapIndex + 1;
    const suffixLength = match.expectedEnd - suffixExpectedStart;
    const suffixHeardStart = match.heardEnd - suffixLength;
    for (let i = 0; i < suffixLength; i++) {
      const w = this.words[suffixExpectedStart + i];
      if (w && w.status === 'pending') { w.heard = this.fullHeard[suffixHeardStart + i]; w.score = 1; w.status = 'matched'; }
    }
    this.acceptedOffset = match.expectedEnd - 1;
  }

  snapshot(): LiveWord[] { return this.words.map(w => ({...w})); }

  report() {
    const c = {pending: 0, matched: 0, skipped: 0, uncertain: 0};
    this.words.forEach(w => c[w.status]++);
    const score = this.words.length ? Math.round((c.matched + c.uncertain * 0.5) / this.words.length * 100) : 0;
    return {...c, total: this.words.length, position: this.acceptedOffset + 1, score};
  }

  /** Texte brut cumulé, utile pour le rapport tolérant de fin de session. */
  getFullHeard(): string[] { return [...this.fullHeard]; }
}
