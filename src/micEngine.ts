// Encapsule le cycle micro -> AudioWorklet -> worker ONNX -> transcription.
// Logique extraite de main.ts (labo technique), rendue réutilisable pour
// n'importe quel écran de l'app (app.ts) via une API à callbacks, sans
// dépendre du DOM du labo.
import {VAD_SILENCE_MS} from './constants';

export type Provider = 'auto' | 'webgpu' | 'wasm';

export interface MicEngineCallbacks {
  onStatus?(message: string): void;
  onProgress?(percent: number): void;
  onReady?(provider: string): void;
  /** Texte d'UNE fenêtre décodée (pas cumulé — à accumuler côté appelant comme le fait main.ts). */
  onResult?(text: string, meta: {ms: number; rtf: number; provider: string; final: boolean}): void;
  onError?(message: string): void;
  onSessionEnded?(): void;
}

export class MicEngine {
  private worker: Worker;
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private gain: GainNode | null = null;
  private sessionId = 0;
  private stopping = false;
  private flushWaiter: (() => void) | null = null;
  private callbacks: MicEngineCallbacks;
  private ready = false;

  constructor(callbacks: MicEngineCallbacks = {}) {
    this.callbacks = callbacks;
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), {type: 'module'});
    this.worker.onmessage = (e) => this.handleWorkerMessage(e.data);
  }

  private handleWorkerMessage(m: any) {
    switch (m.type) {
      case 'status': this.callbacks.onStatus?.(m.message); break;
      case 'progress': this.callbacks.onProgress?.(m.percent); break;
      case 'ready': this.ready = true; this.callbacks.onReady?.(m.provider); break;
      case 'result': this.callbacks.onResult?.(m.text ?? '', {ms: m.ms, rtf: m.rtf, provider: m.provider, final: !!m.final}); break;
      case 'error': this.callbacks.onError?.(m.message); break;
      case 'flushed': this.flushWaiter?.(); this.flushWaiter = null; this.callbacks.onSessionEnded?.(); break;
      default: break;
    }
  }

  /** À appeler une fois au démarrage de l'app (télécharge/charge le modèle, peut prendre du temps). */
  init(provider: Provider = 'auto') {
    this.worker.postMessage({type: 'provider', provider});
    this.worker.postMessage({type: 'init'});
  }

  isReady() { return this.ready; }

  /** Permet à un écran de rebrancher ses propres callbacks sur le moteur partagé (le worker/modèle chargé reste le même). */
  setCallbacks(callbacks: MicEngineCallbacks) { this.callbacks = callbacks; }

  /**
   * Fenêtre de mots attendus pour le rescoring lexical CTC (5.10.0) — voir
   * EXPECTED_WINDOW_BEFORE/AFTER dans worker.ts pour le raisonnement complet.
   * À appeler à chaque changement de bayt/curseur ET à chaque avancée du
   * curseur pendant la récitation (reciteScreen.ts), pour que la fenêtre
   * glissante suive la position réelle du récitant.
   */
  setExpectedWords(words: string[], cursor: number) {
    this.worker.postMessage({type: 'setExpected', words, cursor});
  }

  private async loadAudioWorklet(ctx: AudioContext) {
    const aw = ctx as AudioContext & {audioWorklet: {addModule(url: string): Promise<void>}};
    try {
      await aw.audioWorklet.addModule('/audio-processor.js');
    } catch {
      const text = await fetch('/audio-processor.js').then(r => {
        if (!r.ok) throw new Error(`AudioWorklet HTTP ${r.status}`);
        return r.text();
      });
      const url = URL.createObjectURL(new Blob([text], {type: 'application/javascript'}));
      try { await aw.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    }
  }

  async start() {
    this.stopping = false;
    this.sessionId++;
    const id = this.sessionId;
    this.worker.postMessage({type: 'start', sessionId: id});
    this.stream = await navigator.mediaDevices.getUserMedia({audio: {channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false}});
    this.audioCtx = new AudioContext();
    await this.loadAudioWorklet(this.audioCtx);
    this.source = this.audioCtx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.audioCtx, 'audio-stream-processor');
    this.node.port.onmessage = (e) => {
      if (e.data?.type === 'sample-rate') return;
      if (e.data?.type === 'flushed') { this.worker.postMessage({type: 'flush', sessionId: id}); return; }
      if (e.data?.type === 'vad') {
        // VAD (5.8.0) : silence continu suffisant après de la parole =
        // fin d'hémistiche/bayt probable -> flush anticipé du buffer en
        // cours, SANS arrêter la session (contrairement à `flushed`
        // ci-dessus, qui vient de la fin explicite de session). Le worklet
        // ne fait que signaler l'état ; toute la décision de seuil est ici,
        // au même endroit que le seuil de silence bloc-à-bloc existant
        // (ligne ~95) pour rester cohérent et facile à ajuster ensemble.
        if (id === this.sessionId && e.data.hasSpeechSinceReset && e.data.silenceMs >= VAD_SILENCE_MS) {
          this.node?.port.postMessage({type: 'vad-ack'});
          this.worker.postMessage({type: 'vad-flush', sessionId: id});
        }
        return;
      }
      if (id !== this.sessionId) return;
      const samples = e.data as Float32Array;
      let sum = 0;
      for (const x of samples) sum += x * x;
      const rms = Math.sqrt(sum / samples.length);
      if (rms < 0.003) return; // silence, ignoré comme dans main.ts
      this.worker.postMessage({type: 'audio', sessionId: id, samples}, [samples.buffer]);
    };
    this.source.connect(this.node);
    this.gain = this.audioCtx.createGain();
    this.gain.gain.value = 0; // jamais de retour audio dans les haut-parleurs
    this.node.connect(this.gain);
    this.gain.connect(this.audioCtx.destination);
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    const id = this.sessionId;
    this.sessionId++;
    if (this.node) {
      this.node.port.postMessage({type: 'flush'});
      await Promise.race([
        new Promise<void>(resolve => { this.flushWaiter = resolve; }),
        new Promise<void>(resolve => setTimeout(resolve, 10000)),
      ]);
      this.flushWaiter = null;
      this.node.port.postMessage({type: 'reset'});
      this.node.disconnect();
    }
    this.gain?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach(t => t.stop());
    await this.audioCtx?.close();
    this.node = null; this.gain = null; this.source = null; this.stream = null; this.audioCtx = null;
    this.worker.postMessage({type: 'reset', sessionId: id});
    this.stopping = false;
  }
}
