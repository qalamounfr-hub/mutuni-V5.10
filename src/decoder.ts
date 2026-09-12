import {normalizeArabic, similarity} from './normalize';

const WORD_PREFIX = '▁';
// Rescoring lexical (5.10.0) : un mot décodé par le CTC glouton qui ne
// matche EXACTEMENT aucun mot attendu, mais qui ressemble fortement à l'un
// d'eux (au-dessus de ce seuil), est corrigé vers ce mot attendu. Seuil
// volontairement élevé : à 0.8, un mot de 5 lettres tolère environ 1 lettre
// de différence — assez pour rattraper une confusion phonétique fine
// (émphatiques, gutturales proches) sans jamais transformer un mot
// réellement différent en mot attendu par excès de zèle. Le décodage
// glouton reste TOUJOURS la référence : cette correction n'ajoute ni ne
// supprime de mot, elle ne fait que corriger l'orthographe d'un mot déjà
// détecté, quand un mot attendu très proche existe dans la fenêtre fournie.
const LEXICAL_RESCORE_THRESHOLD = 0.8;

export interface TimedWord {
  text: string;
  // Frame CTC (indice temporel dans la fenêtre courante) à laquelle ce mot
  // a commencé à être décodé. Sert à découper proprement le recouvrement
  // entre deux fenêtres sur l'axe du temps plutôt que sur le texte.
  startFrame: number;
}

export interface DecodeResult {
  tokenIds: number[];
  text: string;
  words: TimedWord[];
}

export class TextCTCDecoder {
  vocab = new Map<number, string>();
  blankId: number;

  constructor(vocab: Record<string, string>, blankId = 1024) {
    for (const [id, t] of Object.entries(vocab)) this.vocab.set(Number(id), t);
    this.blankId = blankId;
  }

  decode(logprobs: Float32Array, timeSteps: number, vocabSize: number, expectedWindow?: string[]): DecodeResult {
    const frames: number[] = [];
    for (let t = 0; t < timeSteps; t++) {
      let best = 0, bestVal = logprobs[t * vocabSize];
      for (let v = 1; v < vocabSize; v++) {
        const x = logprobs[t * vocabSize + v];
        if (x > bestVal) { bestVal = x; best = v; }
      }
      frames.push(best);
    }

    // Collapse CTC standard (dédoublonne les répétitions, retire les blancs)
    // en conservant, pour chaque token gardé, la frame à laquelle il apparaît
    // pour la première fois dans ce run.
    const ids: number[] = [];
    const idFrames: number[] = [];
    let prev = -1;
    for (let t = 0; t < frames.length; t += 1) {
      const id = frames[t];
      if (id !== prev && id !== this.blankId) { ids.push(id); idFrames.push(t); }
      prev = id;
    }

    // Regroupe les tokens en mots : un token commençant par WORD_PREFIX (▁)
    // démarre un nouveau mot ; sa frame de départ devient celle du mot.
    const words: TimedWord[] = [];
    let current = '';
    let currentStartFrame = -1;
    const flush = () => {
      const cleaned = current.trim();
      if (cleaned) words.push({text: cleaned, startFrame: currentStartFrame});
      current = '';
    };
    for (let i = 0; i < ids.length; i += 1) {
      const raw = this.vocab.get(ids[i]) ?? '';
      if (!raw || raw === '<unk>' || raw === '<blank>') continue;
      const startsNewWord = raw.startsWith(WORD_PREFIX) || current === '';
      if (startsNewWord && current !== '') flush();
      if (current === '') currentStartFrame = idFrames[i];
      current += raw.replace(/▁/g, '');
    }
    flush();

    // Rescoring lexical (5.10.0) : voir LEXICAL_RESCORE_THRESHOLD ci-dessus.
    // N'agit qu'après le décodage glouton complet — ne change jamais le
    // nombre de mots ni leur ordre, corrige seulement l'orthographe d'un mot
    // déjà détecté quand un mot attendu très proche existe dans la fenêtre.
    if (expectedWindow && expectedWindow.length) {
      for (const w of words) {
        const normDecoded = normalizeArabic(w.text);
        if (expectedWindow.some(e => normalizeArabic(e) === normDecoded)) continue; // déjà un match exact, rien à corriger
        let bestWord: string | null = null, bestScore = LEXICAL_RESCORE_THRESHOLD;
        for (const candidate of expectedWindow) {
          const s = similarity(candidate, w.text);
          if (s > bestScore) { bestScore = s; bestWord = candidate; }
        }
        if (bestWord) w.text = bestWord;
      }
    }

    const text = normalizeArabic(words.map(w => w.text).join(' ')).trim();
    return {tokenIds: ids, text, words};
  }
}
