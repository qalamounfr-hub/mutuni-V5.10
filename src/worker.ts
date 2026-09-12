import * as ort from 'onnxruntime-web';
import {loadModel} from './modelCache';
import {TextCTCDecoder} from './decoder';
import {AUDIO_WINDOW,AUDIO_HOP,AUDIO_MIN_TAIL,VAD_MIN_FLUSH_SAMPLES} from './constants';
import {rescoreExpectedWindow} from './constrainedDecoder';

type Provider = 'auto' | 'webgpu' | 'wasm';
type Msg =
  | {type:'init'}
  | {type:'provider', provider:Provider}
  | {type:'start', sessionId:number}
  | {type:'audio', sessionId:number, samples:Float32Array}
  | {type:'flush', sessionId:number}
  | {type:'vad-flush', sessionId:number}
  | {type:'setExpected', words:string[], cursor:number}
  | {type:'reset', sessionId?:number};

let session: ort.InferenceSession | null = null;
let decoder: TextCTCDecoder | null = null;
let provider: 'webgpu' | 'wasm' = 'wasm';
let requestedProvider: Provider = 'auto';
let modelBuffer: ArrayBuffer | null = null;

// Fenêtrage : fenêtres de 3 s avec recouvrement de 1.5 s (hop 1.5 s).
const WINDOW = AUDIO_WINDOW, HOP = AUDIO_HOP, MIN_TAIL = AUDIO_MIN_TAIL, MIN_VAD_FLUSH = VAD_MIN_FLUSH_SAMPLES;
const MAX_QUEUE = 16;
const queue: Float32Array[] = [];
const audioBuffer: number[] = [];
let activeSession = 0;
let processing = false;
let flushing = false;
let vadFlushRequested = false;

// Rescoring lexical (5.10.0) : fenêtre glissante de mots attendus autour de
// la position actuelle du curseur, transmise par reciteScreen.ts via
// micEngine.ts à chaque avancée. Fenêtre glissante plutôt que "tout le
// texte restant" : sur un mutn, les mêmes mots reviennent souvent d'un bayt
// à l'autre (formules répétées) — donner tout le texte restant risquerait
// de faire corriger un mot vers une occurrence lointaine de ce même mot
// plutôt que vers celle, correcte, qui se trouve à la position actuelle.
// EXPECTED_WINDOW_BEFORE couvre aussi un peu AVANT le curseur : un mot déjà
// validé peut être répété juste après (ex. dans un même hémistiche), le
// rescoring doit pouvoir encore le reconnaître dans ce cas.
const EXPECTED_WINDOW_BEFORE = 3, EXPECTED_WINDOW_AFTER = 12;
let expectedWords: string[] = [];
let expectedCursor = 0;

let totalInference = 0, runs = 0;

const MODEL_URL = 'https://huggingface.co/acibZ/tilawa-quran-onnx/resolve/main/fastconformer_full_mixed.onnx?download=true';

function post(x: any) { self.postMessage(x); }
function errorMessage(e: unknown) { return e instanceof Error ? e.message : String(e); }

async function releaseSession() { if (session) { await session.release(); session = null; } }

async function create(buffer: ArrayBuffer, ep: 'webgpu' | 'wasm') {
  await releaseSession();
  // Multithreading WASM tenté en 5.6.0 puis annulé en 5.6.1 : en déploiement
  // Vercel réel, la session ONNX Runtime ne se créait plus du tout (blocage
  // silencieux après le téléchargement du modèle, aucune erreur visible).
  // L'hypothèse "sans COOP/COEP, ONNX Runtime retombe sur un seul thread"
  // ne s'est pas vérifiée en pratique — donc retour à numThreads=1 fixe,
  // qui fonctionnait, en attendant d'investiguer plus précisément.
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;
  ort.env.wasm.proxy = false;
  session = await ort.InferenceSession.create(buffer, {executionProviders: [ep]});
  provider = ep;
}

// Bruit blanc + deux sinusoïdes basses fréquences, déterministe (seed fixe) : sert à
// détecter le bug connu de certains backends WebGPU qui renvoient ~100% de frames
// "blank" quel que soit le signal d'entrée (voir CHANGE-REPORT.md).
function deterministicProbe() {
  const out = new Float32Array(16000);
  let state = 0x12345678;
  for (let i = 0; i < out.length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const white = (state / 4294967295) * 2 - 1;
    out[i] = (white * 0.7 + Math.sin(i * 0.037) * 0.2 + Math.sin(i * 0.011) * 0.1) * 0.1;
  }
  return out;
}

function chooseOutput(results: Record<string, ort.Tensor>, names: readonly string[], vocabSize: number) {
  const candidates = names.map(name => ({name, t: results[name]})).filter(x => x.t && x.t.dims.length === 3);
  const chosen = candidates.find(x => x.t.dims.includes(vocabSize));
  if (!chosen) throw new Error(`Aucune sortie CTC [T,${vocabSize}] trouvée. Sorties: ${names.map(n => `${n}=[${results[n]?.dims?.join(',')}]`).join('; ')}`);
  return chosen;
}

function orderOutput(out: ort.Tensor, vocabSize: number) {
  const dims = out.dims as number[];
  const axis = dims[2] === vocabSize ? 2 : (dims[1] === vocabSize ? 1 : -1);
  if (axis < 0) throw new Error(`Sortie sans axe vocabulaire ${vocabSize}: [${dims.join(', ')}]`);
  const steps = axis === 2 ? dims[1] : dims[2];
  const data = out.data as Float32Array | number[];
  const values = data instanceof Float32Array ? data : new Float32Array(data);
  if (values.length !== steps * vocabSize) throw new Error(`Taille sortie incohérente: ${values.length} != ${steps * vocabSize}`);
  if (axis === 2) return {values, steps, size: vocabSize};
  const ordered = new Float32Array(values.length);
  for (let t = 0; t < steps; t++) for (let v = 0; v < vocabSize; v++) ordered[t * vocabSize + v] = values[v * steps + t];
  return {values: ordered, steps, size: vocabSize};
}

function blankPercentOf(values: Float32Array, steps: number, vocabSize: number, blankId: number) {
  let blankFrames = 0;
  for (let t = 0; t < steps; t += 1) {
    let best = 0;
    for (let v = 1; v < vocabSize; v += 1) if (values[t * vocabSize + v] > values[t * vocabSize + best]) best = v;
    if (best === blankId) blankFrames += 1;
  }
  return blankFrames / Math.max(1, steps) * 100;
}

function logTopFrames(values: Float32Array, steps: number, vocabSize: number, label: string) {
  const frames = [0, 10].filter(t => t < steps);
  for (const t of frames) {
    const scored = Array.from({length: vocabSize}, (_, v) => ({index: v, raw: values[t * vocabSize + v]})).sort((a, b) => b.raw - a.raw).slice(0, 5);
    const max = scored[0].raw;
    const denom = Array.from(values.slice(t * vocabSize, (t + 1) * vocabSize), x => Math.exp(x - max)).reduce((a, b) => a + b, 0);
    post({type: 'diagnostic', message: `${label} frame ${t} top-5 logprobs: ${scored.map(v => `(${v.index}, ${v.raw.toFixed(4)}, ${(Math.exp(v.raw - max) / denom).toFixed(6)})`).join(' ')}`});
  }
}

async function runRaw(audio: Float32Array) {
  if (!session || !decoder) throw new Error('Inférence impossible: session ou décodeur non initialisé.');
  const names = session.inputNames;
  const expected = ['audio_signal', 'length'];
  if (names.length !== 2 || !expected.every(n => names.includes(n))) {
    throw new Error(`Noms d’entrées ONNX incompatibles. Attendus: ${expected.join(', ')}; reçus: ${names.join(', ')}`);
  }
  if (audio.length < 1) throw new Error('Fenêtre audio vide');
  const input = new ort.Tensor('float32', audio, [1, audio.length]);
  const length = new ort.Tensor('int64', BigInt64Array.from([BigInt(audio.length)]), [1]);
  const results = await session.run({audio_signal: input, length});
  const selected = chooseOutput(results, session.outputNames, decoder.vocab.size);
  const arranged = orderOutput(selected.t, decoder.vocab.size);
  post({type: 'raw-output', length: arranged.values.length, shape: selected.t.dims, output: selected.name});
  return arranged;
}

async function probeInference(audio: Float32Array, label: string) {
  const arranged = await runRaw(audio);
  logTopFrames(arranged.values, arranged.steps, arranged.size, label);
  const blankPercent = blankPercentOf(arranged.values, arranged.steps, arranged.size, decoder!.blankId);
  post({type: 'diagnostic', message: `${label} blank-frame percentage: ${blankPercent.toFixed(2)}%`});
  return {blankPercent};
}

async function init() {
  try {
    post({type: 'status', message: 'Chargement du vocabulaire…'});
    const vr = await fetch('/vocab.json');
    if (!vr.ok) throw new Error(`Vocabulaire HTTP ${vr.status}`);
    const vocab = await vr.json();
    const mr = await fetch('/export_metadata.json');
    if (!mr.ok) throw new Error(`Métadonnées HTTP ${mr.status}`);
    const meta = await mr.json();
    const blankId = Number(meta.blank_id);
    if (!Number.isInteger(blankId) || blankId < 0) throw new Error(`blank_id invalide: ${meta.blank_id}`);
    decoder = new TextCTCDecoder(vocab, blankId);
    if (decoder.vocab.size !== Number(meta.vocab_tokens)) throw new Error(`Vocabulaire incomplet: ${decoder.vocab.size}/${meta.vocab_tokens}`);

    post({type: 'status', message: 'Téléchargement / cache du modèle (88 Mo)…'});
    modelBuffer = await loadModel(MODEL_URL, (loaded, total) => post({type: 'progress', percent: total ? Math.round(loaded / total * 100) : 0, loaded, total}));

    const target = requestedProvider === 'auto' ? 'webgpu' : requestedProvider;
    try {
      post({type: 'status', message: `Création de la session ${target.toUpperCase()}…`});
      await create(modelBuffer, target);
      if (requestedProvider === 'auto') {
        post({type: 'status', message: 'Validation WebGPU: sonde déterministe…'});
        const probe = await probeInference(deterministicProbe(), 'Sonde WebGPU');
        if (probe.blankPercent > 99) {
          post({type: 'status', message: `Sonde WebGPU: ${probe.blankPercent.toFixed(2)}% de frames blank (>99%), bascule WASM.`});
          await create(modelBuffer, 'wasm');
        } else {
          post({type: 'status', message: `Sonde WebGPU valide: ${probe.blankPercent.toFixed(2)}% blank.`});
        }
      }
    } catch (e) {
      if (target === 'webgpu' && requestedProvider !== 'webgpu') {
        post({type: 'status', message: `WebGPU indisponible (${errorMessage(e)}), fallback WASM…`});
        await create(modelBuffer, 'wasm');
      } else {
        throw e;
      }
    }

    post({
      type: 'diagnostics',
      inputNames: session!.inputNames,
      outputNames: session!.outputNames,
      vocabSize: decoder.vocab.size,
      blankId,
      provider,
    });
    post({type: 'ready', provider});
  } catch (e) {
    post({type: 'error', message: errorMessage(e)});
  }
}

async function infer(audio: Float32Array, sessionId: number, final = false) {
  if (!session || !decoder) return;
  const start = performance.now();
  post({type: 'inference-start', samples: audio.length, sessionId});
  try {
    const arranged = await runRaw(audio);
    const windowStart = Math.max(0, expectedCursor - EXPECTED_WINDOW_BEFORE);
    const windowEnd = Math.min(expectedWords.length, expectedCursor + EXPECTED_WINDOW_AFTER);
    const expectedWindow = expectedWords.slice(windowStart, windowEnd);
    const decoded = decoder.decode(arranged.values, arranged.steps, arranged.size, expectedWindow);
    const ms = performance.now() - start;
    runs++;
    totalInference += ms;

    // Découpage temporel du recouvrement : pour une fenêtre non-finale, seuls
    // les mots dont la frame de départ tombe avant le milieu de la zone de
    // recouvrement sont émis. Le reste de l'audio (la moitié finale de la
    // fenêtre) sera redécodé, en entier cette fois, au début de la fenêtre
    // suivante — donc pas de perte, seulement pas de double émission. Ça
    // remplace la déduplication texte-à-texte (peu fiable car le decoder
    // CTC segmente parfois différemment le même son d'une fenêtre à l'autre)
    // par un critère sans ambiguïté : la position dans le temps.
    //
    // BUG CORRIGÉ (5.7.3) : `edge` (marge de sécurité à gauche, pour ne pas
    // ré-émettre un mot déjà émis en fin de fenêtre précédente) s'appliquait
    // aussi à la fenêtre FINALE (flush de fin de bayt) — alors qu'une
    // fenêtre finale n'a par définition aucune fenêtre suivante avec
    // laquelle elle pourrait chevaucher. Toute fenêtre finale étant courte
    // (c'est la "queue" restante après le dernier hop plein, souvent
    // seulement 1-2 mots), le dernier mot du bayt tombait très
    // fréquemment dans les 3 premières frames et était purement supprimé —
    // jamais émis à `LiveCursor`, donc jamais matchable quelle que soit la
    // qualité de la reconnaissance ou la robustesse de l'algorithme de
    // matching (voir aussi le correctif distinct 5.7.2 sur `liveCursor.ts`,
    // nécessaire mais pas suffisant : il ne pouvait rien faire d'un mot qui
    // n'arrivait jamais dans `heardWords`). Signalé par l'utilisateur en
    // test réel après déploiement de 5.7.2 : le blocage persistait.
    const midFrame = final ? Infinity : Math.floor(arranged.steps * (HOP / WINDOW));
    const edge = final ? 0 : 3;
    const emittedWords = decoded.words.filter(w => w.startFrame >= edge && w.startFrame < midFrame);
    const heldBackWords = decoded.words.filter(w => w.startFrame >= midFrame);
    const text = emittedWords.map(w => w.text).join(' ').trim();

    post({
      type: 'diagnostic',
      message: `Découpage fenêtre: ${arranged.steps} frames, coupure à ${final ? 'fin (fenêtre finale)' : midFrame} · émis [${emittedWords.map(w => w.text).join(', ')}] · retenu pour fenêtre suivante [${heldBackWords.map(w => w.text).join(', ')}]`,
    });
    post({type: 'decoded', text, sessionId});
    post({type: 'inference-end', ms, sessionId});
    post({
      type: 'result',
      text,
      tokenIds: decoded.tokenIds,
      ms,
      audioSec: audio.length / 16000,
      rtf: ms / (audio.length / 16000 * 1000),
      avgMs: totalInference / runs,
      provider,
      sessionId,
      final,
    });
  } catch (e) {
    post({type: 'error', message: errorMessage(e), sessionId});
  }
}

function enqueue(samples: Float32Array) {
  if (!samples.length) return;
  if (queue.length >= MAX_QUEUE) {
    queue.shift();
    post({type: 'status', message: `File audio pleine (${MAX_QUEUE} blocs): bloc le plus ancien abandonné.`});
  }
  queue.push(samples);
}

async function pump() {
  if (processing) return;
  processing = true;
  try {
    while (queue.length) {
      const part = queue.shift()!;
      for (let i = 0; i < part.length; i += 1) audioBuffer.push(part[i]);
      while (audioBuffer.length >= WINDOW) {
        const win = new Float32Array(audioBuffer.slice(0, WINDOW));
        audioBuffer.splice(0, HOP);
        await infer(win, activeSession);
      }
    }
    // Flush VAD (5.8.0) : silence détecté par audio-processor.js après une
    // durée suffisante de parole — probable fin d'hémistiche/bayt. Contrairement
    // au flush de fin de session (`flushing`), celui-ci NE termine PAS la
    // session : il vide juste le buffer courant en avance, comme une fenêtre
    // finale-locale (final=true -> edge=0, voir CHANGELOG 5.7.3, même
    // raisonnement : ce petit bout de buffer n'a par construction aucune
    // fenêtre suivante avec laquelle chevaucher puisqu'on le vide maintenant).
    // La session continue ensuite d'accumuler normalement pour la suite du
    // bayt. Ignoré si le buffer est trop court (MIN_VAD_FLUSH) pour éviter de
    // gaspiller une inférence sur une respiration ou un silence isolé sans
    // parole avant — dans ce cas on laisse simplement le buffer s'accumuler
    // jusqu'au prochain hop normal ou au prochain flush VAD utile.
    if (vadFlushRequested) {
      vadFlushRequested = false;
      if (audioBuffer.length >= MIN_VAD_FLUSH) {
        const win = new Float32Array(audioBuffer.splice(0));
        await infer(win, activeSession, true);
      }
    }
    if (flushing && audioBuffer.length >= MIN_TAIL) {
      const tail = new Float32Array(audioBuffer.splice(0));
      await infer(tail, activeSession, true);
    } else if (flushing && audioBuffer.length) {
      post({type: 'flush-skipped', samples: audioBuffer.length, sessionId: activeSession});
      audioBuffer.length = 0;
    }
  } finally {
    processing = false;
    if (flushing && !queue.length) {
      audioBuffer.length = 0;
      flushing = false;
      post({type: 'flushed', sessionId: activeSession});
    } else if (queue.length || vadFlushRequested) {
      void pump();
    }
  }
}

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  if (m.type === 'init') {
    void init();
  } else if (m.type === 'provider') {
    requestedProvider = m.provider;
    post({type: 'status', message: `Provider sélectionné: ${m.provider}.`});
  } else if (m.type === 'start') {
    activeSession = m.sessionId;
    queue.length = 0;
    audioBuffer.length = 0;
    flushing = false;
    vadFlushRequested = false;
    post({type: 'session-started', sessionId: activeSession});
  } else if (m.type === 'audio' && m.sessionId === activeSession) {
    enqueue(m.samples);
    void pump();
  } else if (m.type === 'flush' && m.sessionId === activeSession) {
    flushing = true;
    void pump();
  } else if (m.type === 'vad-flush' && m.sessionId === activeSession) {
    // Ignoré si une fin de session est déjà en cours (`flushing`) : le flush
    // final va de toute façon vider tout le buffer restant, un vad-flush
    // concurrent n'apporterait rien et compliquerait l'ordonnancement.
    if (!flushing) { vadFlushRequested = true; void pump(); }
  } else if (m.type === 'setExpected') {
    // Fenêtre glissante pour le rescoring lexical (5.10.0) : reciteScreen.ts
    // envoie ce message à chaque changement de bayt/curseur ET à chaque
    // avancée du curseur pendant la récitation, pour que la fenêtre suive la
    // position réelle. Pas de filtre par sessionId ici (contrairement aux
    // messages audio) : ce message peut légitimement arriver juste avant un
    // 'start' (ex. chargement initial du bayt avant que le micro démarre).
    expectedWords = m.words;
    expectedCursor = m.cursor;
  } else if (m.type === 'reset') {
    queue.length = 0;
    audioBuffer.length = 0;
    flushing = false;
    vadFlushRequested = false;
    expectedWords = [];
    expectedCursor = 0;
    runs = 0;
    totalInference = 0;
    activeSession = m.sessionId ?? activeSession;
    post({type: 'reset-done', sessionId: activeSession});
  }
};
