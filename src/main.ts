import {clearModelCache} from './modelCache';
import {normalizeArabic} from './normalize';
import {LiveCursor} from './liveCursor';
import {renderCursor, renderReport} from './cursorView';
import {VERSION} from './version';
import {alignedMatchCount} from './wordAlign';
import {rescoreExpectedWindow} from './constrainedDecoder';
import {CONSTRAINED_DECODING_ENABLED} from './constants';
import {bootstrapBundledMatns, listMatns, listBabs, listBayts, Matn, Bab, Bayt} from './mutuniDB';
import './style.css';

const app = document.querySelector('#app')!;
app.innerHTML = `<main>
  <h1>MUTUNI × Tilawa Lab <span id="ver">v5</span></h1>
  <p class="sub">Audio 16 kHz → FastConformer CTC → décodage. Fenêtres de 3 s avec recouvrement. Prototype de moteur, pas encore tracker Coran.</p>
  <section>
    <div class="row">
      <button id="load">1. Charger le moteur</button>
      <button id="clear">Vider le cache</button>
      <label>Provider <select id="provider">
        <option value="auto">Auto (sonde WebGPU)</option>
        <option value="webgpu">WebGPU</option>
        <option value="wasm">WASM</option>
      </select></label>
    </div>
    <progress id="prog" max="100" value="0"></progress>
    <div id="status">Prêt.</div>
  </section>
  <section>
    <div class="row">
      <button id="mic" disabled>2. Démarrer le micro</button>
      <button id="inject" disabled>Injecter un audio de test</button>
      <button id="test" disabled>Test 5 secondes</button>
      <button id="stop" disabled>Arrêter</button>
    </div>
    <div id="metrics">Provider: — · Latence: —</div>
  </section>
  <section>
    <label>MutuniDB</label>
    <div class="row">
      <select id="matnSelect"><option value="">— matn —</option></select>
      <select id="babSelect"><option value="">— bab —</option></select>
      <select id="baytSelect"><option value="">— bayt —</option></select>
      <button id="loadBayt" disabled>Charger dans le texte attendu</button>
    </div>
  </section>
  <section>
    <label for="expected">Mutûn attendu</label>
    <textarea id="expected" placeholder="Colle ici le texte arabe que tu récites…"></textarea>
    <div class="row"><button id="applyExpected">Appliquer le texte</button><button id="resetCursor">Réinitialiser le curseur</button></div>
    <div id="cursorWords" dir="rtl"></div><div id="scoreBar" role="progressbar"></div>
    <div id="compare"></div><div id="cursorProgress"></div>
  </section>
  <section>
    <h3>Transcript continu</h3>
    <pre id="result"></pre><pre id="wordReport"></pre>
  </section>
  <section>
    <h3>Journal</h3>
    <pre id="log"></pre>
  </section>
</main>`;

const $ = (id: string) => document.getElementById(id)!;
const log = (s: string) => { ($('log') as HTMLElement).textContent += `[${new Date().toLocaleTimeString()}] ${s}\n`; };

type Provider = 'auto' | 'webgpu' | 'wasm';
const savedProvider = (localStorage.getItem('mutuni-provider') as Provider | null);
const providerSelect = $('provider') as HTMLSelectElement;
providerSelect.value = savedProvider && ['auto', 'webgpu', 'wasm'].includes(savedProvider) ? savedProvider : 'auto';

const worker = new Worker(new URL('./worker.ts', import.meta.url), {type: 'module'});
const cursor = new LiveCursor('');
let heardWords: string[] = [];
function refreshCursor(){ const words=cursor.snapshot(); renderCursor($('cursorWords') as HTMLElement, words); renderReport($('wordReport') as HTMLElement, words); const r=cursor.report(); ($('scoreBar') as HTMLElement).style.setProperty('--score', `${r.score}%`); ($('scoreBar') as HTMLElement).textContent=`${r.score}% · ${r.matched} validés · ${r.uncertain} incertains · ${r.skipped} sautés · ${r.pending} en attente`; }
function applyExpected(){ cursor.setExpected(($('expected') as HTMLTextAreaElement).value); heardWords=[]; refreshCursor(); }
$('applyExpected').addEventListener('click', applyExpected);
$('resetCursor').addEventListener('click', () => { cursor.reset(); heardWords=[]; refreshCursor(); });

let audioCtx: AudioContext | null = null, stream: MediaStream | null = null, node: AudioWorkletNode | null = null,
    source: MediaStreamAudioSourceNode | null = null, gain: GainNode | null = null;
let sessionId = 0;
let testTimer: number | undefined;
let stopping = false;
let fullTranscript: string[] = [];
let flushWaiter: ((v: void) => void) | null = null;

function sendProvider() {
  const provider = providerSelect.value as Provider;
  localStorage.setItem('mutuni-provider', provider);
  worker.postMessage({type: 'provider', provider});
}
providerSelect.addEventListener('change', sendProvider);
sendProvider();

function compare(text: string) {
  const expected = normalizeArabic(($('expected') as HTMLTextAreaElement).value);
  if (!expected || !text) return;
  const expectedWords = expected.split(' ').filter(Boolean);
  const actualWords = normalizeArabic(text).split(' ').filter(Boolean);
  const {matches, total} = alignedMatchCount(expectedWords, actualWords);
  ($('compare') as HTMLElement).textContent = `Correspondance (alignement tolérant): ${matches}/${total} mots (${Math.round(matches / Math.max(1, total) * 100)}%)`;
}

function resetTranscript() {
  fullTranscript = [];
  ($('result') as HTMLElement).textContent = '';
  cursor.reset(); heardWords = []; refreshCursor();
}

// Le worker ne renvoie plus, par fenêtre, que la portion de texte antérieure
// au milieu du recouvrement (voir worker.ts: découpage temporel dans infer()).
// Les fenêtres successives ne se chevauchent donc plus au niveau du texte
// émis : une simple concaténation suffit, sans deviner un chevauchement sur
// des décodages qui peuvent légèrement varier d'une fenêtre à l'autre.
function appendTranscript(text: string) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return;
  fullTranscript.push(...words);
  ($('result') as HTMLElement).textContent = fullTranscript.join(' ');
}

function syntheticAudio() {
  const samples = new Float32Array(16000);
  let state = 0x12345678, sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const noise = state / 4294967295 * 2 - 1;
    samples[i] = noise * 0.07 + Math.sin(i * 2 * Math.PI * 440 / 16000) * 0.04 + Math.sin(i * 2 * Math.PI * 660 / 16000) * 0.02;
    sum += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sum / samples.length);
  const scale = Math.pow(10, -20 / 20) / rms;
  for (let i = 0; i < samples.length; i += 1) samples[i] *= scale;
  return samples;
}

async function loadAudioWorklet(ctx: AudioContext) {
  const aw = ctx as AudioContext & {audioWorklet: {addModule(url: string): Promise<void>}};
  try {
    await aw.audioWorklet.addModule('/audio-processor.js');
    log('AudioWorklet chargé depuis /audio-processor.js.');
  } catch {
    log('AudioWorklet direct indisponible; essai Blob fallback.');
    const text = await fetch('/audio-processor.js').then(r => {
      if (!r.ok) throw new Error(`AudioWorklet HTTP ${r.status}`);
      return r.text();
    });
    const url = URL.createObjectURL(new Blob([text], {type: 'application/javascript'}));
    try { await aw.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
  }
}

async function startAudio(test = false) {
  try {
    stopping = false;
    resetTranscript();
    sessionId++;
    const id = sessionId;
    worker.postMessage({type: 'start', sessionId: id});
    stream = await navigator.mediaDevices.getUserMedia({audio: {channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false}});
    audioCtx = new AudioContext();
    log(`AudioContext ouvert · sampleRate=${audioCtx.sampleRate} Hz`);
    await loadAudioWorklet(audioCtx);
    source = audioCtx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(audioCtx, 'audio-stream-processor');
    node.port.onmessage = (e) => {
      if (e.data?.type === 'sample-rate') { log(`Taux d’échantillonnage réel en entrée: ${e.data.sampleRate} Hz`); return; }
      if (e.data?.type === 'flushed') { worker.postMessage({type: 'flush', sessionId: id}); return; }
      if (id !== sessionId) return;
      const samples = e.data as Float32Array;
      let sum = 0, peak = 0;
      for (const x of samples) { sum += x * x; peak = Math.max(peak, Math.abs(x)); }
      const rms = Math.sqrt(sum / samples.length);
      const dbfs = 20 * Math.log10(Math.max(rms, 1e-8));
      if (rms < 0.003) { log(`Silence ignorée: ${samples.length} échantillons, RMS ${rms.toFixed(5)}.`); return; }
      log(`Audio: ${samples.length} échantillons · RMS ${rms.toFixed(4)} · peak ${peak.toFixed(4)} · dBFS ${dbfs.toFixed(1)}`);
      worker.postMessage({type: 'audio', sessionId: id, samples}, [samples.buffer]);
    };
    source.connect(node);
    gain = audioCtx.createGain();
    gain.gain.value = 0;
    node.connect(gain);
    gain.connect(audioCtx.destination);
    $('mic').setAttribute('disabled', 'true');
    $('test').setAttribute('disabled', 'true');
    $('inject').setAttribute('disabled', 'true');
    $('stop').removeAttribute('disabled');
    log(`Session ${id} active${test ? ' · test 5 secondes' : ''}.`);
    if (testTimer !== undefined) window.clearTimeout(testTimer);
    if (test) testTimer = window.setTimeout(() => void stopAudio('Test terminé automatiquement.'), 5000);
  } catch (e) {
    log('Micro: ' + (e instanceof Error ? e.message : String(e)));
    void stopAudio('Échec du démarrage.');
  }
}

function injectTest() {
  sessionId++;
  const id = sessionId;
  resetTranscript();
  worker.postMessage({type: 'start', sessionId: id});
  const samples = syntheticAudio();
  log(`Audio synthétique injecté directement: ${samples.length} échantillons à 16 kHz · niveau nominal -20 dBFS.`);
  worker.postMessage({type: 'audio', sessionId: id, samples}, [samples.buffer]);
  worker.postMessage({type: 'flush', sessionId: id});
}

async function stopAudio(message = 'Micro arrêté.') {
  if (stopping) return;
  stopping = true;
  const id = sessionId;
  sessionId++;
  if (testTimer !== undefined) { window.clearTimeout(testTimer); testTimer = undefined; }
  if (node) {
    node.port.postMessage({type: 'flush'});
    await Promise.race([
      new Promise<void>(resolve => { flushWaiter = resolve; }),
      new Promise<void>(resolve => setTimeout(resolve, 10000)),
    ]);
    flushWaiter = null;
    node.port.postMessage({type: 'reset'});
    node.disconnect();
  }
  gain?.disconnect();
  source?.disconnect();
  stream?.getTracks().forEach(t => t.stop());
  await audioCtx?.close();
  node = null; gain = null; source = null; stream = null; audioCtx = null;
  worker.postMessage({type: 'reset', sessionId});
  $('mic').removeAttribute('disabled');
  $('test').removeAttribute('disabled');
  $('inject').removeAttribute('disabled');
  $('stop').setAttribute('disabled', 'true');
  log(message);
  stopping = false;
}

worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'status') {
    ($('status') as HTMLElement).textContent = m.message;
    log(m.message);
  } else if (m.type === 'progress') {
    ($('prog') as HTMLProgressElement).value = m.percent;
  } else if (m.type === 'ready') {
    ($('status') as HTMLElement).textContent = `Modèle prêt ✓ (${m.provider})`;
    $('mic').removeAttribute('disabled');
    $('test').removeAttribute('disabled');
    $('inject').removeAttribute('disabled');
    log(`Session prête avec ${m.provider}`);
  } else if (m.type === 'diagnostics') {
    log(`ONNX: entrées [${m.inputNames.join(', ')}] · sorties [${m.outputNames.join(', ')}] · vocab ${m.vocabSize} · blank ${m.blankId} · ${m.provider}`);
  } else if (m.type === 'result') {
    if (m.sessionId !== sessionId) return;
    appendTranscript(m.text);
    const transcript = fullTranscript.join(' ');
    ($('metrics') as HTMLElement).textContent = `Provider: ${m.provider} · inférence: ${m.ms.toFixed(0)} ms · audio: ${m.audioSec.toFixed(2)} s · RTF: ${m.rtf.toFixed(2)}`;
    compare(transcript);
    log(`Résultat fenêtre: ${m.text || '(vide)'} · transcript: ${transcript || '(vide)'} · tokens [${m.tokenIds.join(', ')}] · inférence ${m.ms.toFixed(0)} ms · RTF ${m.rtf.toFixed(2)} · provider ${m.provider}`);
  } else if (m.type === 'flush-skipped') {
    log(`Fin trop courte ignorée: ${m.samples} échantillons.`);
  } else if (m.type === 'flushed') {
    flushWaiter?.();
    flushWaiter = null;
    log('Fin audio traitée.');
  } else if (m.type === 'raw-output') {
    log(`Sortie CTC: ${m.output} [${m.shape.join(', ')}] · ${m.length} valeurs`);
  } else if (m.type === 'inference-start') {
    log(`Début inférence: ${m.samples} échantillons`);
  } else if (m.type === 'inference-end') {
    log(`Fin inférence: ${m.ms.toFixed(1)} ms`);
  } else if (m.type === 'decoded') {
    const words = normalizeArabic(m.text || '').split(/\s+/).filter(Boolean);
    if (words.length) {
      // Le rescoring reste léger et désactivable; il prépare le branchement des log-probs CTC.
      if (CONSTRAINED_DECODING_ENABLED) rescoreExpectedWindow(words, ($('expected') as HTMLTextAreaElement).value.split(/\s+/), cursor.report().position); heardWords.push(...words); cursor.advance(heardWords); refreshCursor(); const r=cursor.report(); ($('cursorProgress') as HTMLElement).textContent=`Progression (curseur): ${r.position}/${r.total} mots (${Math.round(r.position/Math.max(1,r.total)*100)}%)`; }
    log(`Texte décodé (fenêtre): ${m.text || '(vide)'}`);
  } else if (m.type === 'diagnostic') {
    log(m.message);
  } else if (m.type === 'error') {
    log('ERREUR: ' + m.message);
    ($('status') as HTMLElement).textContent = 'Erreur — voir le journal.';
  }
};

$('load').addEventListener('click', () => {
  ($('load') as HTMLButtonElement).disabled = true;
  sendProvider();
  worker.postMessage({type: 'init'});
});
$('clear').addEventListener('click', async () => {
  await clearModelCache();
  ($('status') as HTMLElement).textContent = 'Cache modèle supprimé ✓';
  log('Cache IndexedDB supprimé.');
});
$('mic').addEventListener('click', () => void startAudio(false));
$('test').addEventListener('click', () => void startAudio(true));
$('inject').addEventListener('click', injectTest);
$('stop').addEventListener('click', () => void stopAudio());
refreshCursor();
log(`Lab v${VERSION} initialisé.`);

// MutuniDB : remplit les listes Matn -> Bab -> Bayt et charge le texte
// choisi dans le textarea existant (le textarea reste éditable, la DB
// n'impose rien).
let currentBabs: Bab[] = [];
let currentBayts: Bayt[] = [];

async function initMutuniDB() {
  try {
    await bootstrapBundledMatns();
    const matns: Matn[] = await listMatns();
    const matnSelect = $('matnSelect') as HTMLSelectElement;
    for (const m of matns) {
      const opt = document.createElement('option');
      opt.value = m.id; opt.textContent = m.title;
      matnSelect.appendChild(opt);
    }
    log(`MutuniDB chargée: ${matns.length} matn.`);
    if (matns.length) { matnSelect.value = matns[0].id; await onMatnChange(); }
  } catch (e) {
    log('MutuniDB: ' + (e instanceof Error ? e.message : String(e)));
  }
}

async function onMatnChange() {
  const matnId = ($('matnSelect') as HTMLSelectElement).value;
  const babSelect = $('babSelect') as HTMLSelectElement;
  babSelect.innerHTML = '<option value="">— bab —</option>';
  currentBabs = [];
  await onBabChange();
  if (!matnId) return;
  currentBabs = await listBabs(matnId);
  currentBabs.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.id; opt.textContent = b.title;
    babSelect.appendChild(opt);
  });
  if (currentBabs.length) { babSelect.value = currentBabs[0].id; await onBabChange(); }
}

async function onBabChange() {
  const babId = ($('babSelect') as HTMLSelectElement).value;
  const baytSelect = $('baytSelect') as HTMLSelectElement;
  baytSelect.innerHTML = '<option value="">— bayt —</option>';
  ($('loadBayt') as HTMLButtonElement).disabled = true;
  currentBayts = [];
  if (!babId) return;
  currentBayts = await listBayts(babId);
  currentBayts.forEach((v, i) => {
    const opt = document.createElement('option');
    opt.value = v.id; opt.textContent = `Bayt ${i + 1}`;
    baytSelect.appendChild(opt);
  });
}

$('matnSelect').addEventListener('change', () => void onMatnChange());
$('babSelect').addEventListener('change', () => void onBabChange());
$('baytSelect').addEventListener('change', () => {
  ($('loadBayt') as HTMLButtonElement).disabled = !($('baytSelect') as HTMLSelectElement).value;
});
$('loadBayt').addEventListener('click', () => {
  const id = ($('baytSelect') as HTMLSelectElement).value;
  const bayt = currentBayts.find(v => v.id === id);
  if (!bayt) return;
  ($('expected') as HTMLTextAreaElement).value = bayt.textHaraka;
  applyExpected();
  log(`Bayt chargé depuis MutuniDB: ${bayt.id}`);
});
void initMutuniDB();
