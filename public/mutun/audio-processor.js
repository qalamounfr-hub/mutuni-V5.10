/** Mono -> 16 kHz resampler avec filtre passe-bas anti-repliement.
 *  Émet des blocs bornés et transférables de 0.5 s ; supporte un flush explicite
 *  pour récupérer la fin de la récitation à l'arrêt du micro.
 *
 *  VAD (5.8.0) : calcule le RMS de chaque bloc de 0.5 s émis et suit la durée
 *  de silence continu écoulée. Poste un message {type:'vad', silenceMs,
 *  hasSpeechSinceReset} séparé du bloc audio lui-même — le worklet ne décide
 *  jamais d'un flush, il se contente de signaler l'état ; c'est micEngine.ts
 *  qui décide d'agir dessus (garde le worklet simple et testable, et évite de
 *  dupliquer la logique de seuil à deux endroits). */
class AudioStreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pending = [];
    this.phase = 0;
    this.resampled = [];
    this.filterState = 0;
    this.reportedRate = false;
    this.alpha = this.ratio > 1 ? 1 - Math.exp(-2 * Math.PI * 0.45 / this.ratio) : 1;
    this.block = 8000; // 0.5 s à 16 kHz
    this.silenceRms = 0.003; // garder en phase avec VAD_SILENCE_RMS (src/constants.ts) — ce fichier est du JS statique pur, pas d'import TS possible ici (voir README)
    this.silenceMs = 0;
    this.hasSpeechSinceReset = false;
    this.port.onmessage = (event) => {
      if (event.data?.type === 'reset') {
        this.pending = [];
        this.resampled = [];
        this.phase = 0;
        this.filterState = 0;
        this.reportedRate = false;
        this.silenceMs = 0;
        this.hasSpeechSinceReset = false;
      }
      if (event.data?.type === 'flush') {
        this.emit(true);
        this.port.postMessage({type: 'flushed'});
      }
      if (event.data?.type === 'vad-ack') {
        // micEngine.ts confirme avoir traité le silence signalé (déclenché
        // un vad-flush) : on repart de zéro pour détecter le PROCHAIN
        // silence, sans quoi ce même silence continu redéclencherait un
        // vad-flush à chaque bloc de 0.5 s suivant tant qu'il dure.
        this.silenceMs = 0;
        this.hasSpeechSinceReset = false;
      }
    };
  }
  emit(force = false) {
    while (this.resampled.length >= this.block || (force && this.resampled.length)) {
      const n = Math.min(this.block, this.resampled.length);
      const out = new Float32Array(n);
      let sumSquares = 0;
      for (let i = 0; i < n; i++) { out[i] = this.resampled[i]; sumSquares += out[i] * out[i]; }
      const rms = Math.sqrt(sumSquares / n);
      this.resampled.splice(0, n);
      const blockMs = n / 16000 * 1000;
      if (rms < this.silenceRms) {
        this.silenceMs += blockMs;
      } else {
        this.silenceMs = 0;
        this.hasSpeechSinceReset = true;
      }
      this.port.postMessage(out, [out.buffer]);
      this.port.postMessage({type: 'vad', rms, silenceMs: this.silenceMs, hasSpeechSinceReset: this.hasSpeechSinceReset});
    }
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    if (!this.reportedRate) {
      this.port.postMessage({type: 'sample-rate', sampleRate});
      this.reportedRate = true;
    }
    for (let i = 0; i < input.length; i += 1) {
      this.filterState += this.alpha * (input[i] - this.filterState);
      this.pending.push(this.filterState);
    }
    const available = Math.max(0, Math.floor((this.pending.length - 1 - this.phase) / this.ratio) + 1);
    for (let i = 0; i < available; i += 1) {
      const position = this.phase + i * this.ratio;
      const left = Math.floor(position);
      const fraction = position - left;
      const a = this.pending[left] ?? 0;
      const b = this.pending[left + 1] ?? a;
      this.resampled.push(a + (b - a) * fraction);
    }
    this.phase += available * this.ratio;
    const consumed = Math.floor(this.phase);
    this.pending = this.pending.slice(consumed);
    this.phase -= consumed;
    this.emit();
    return true;
  }
}
registerProcessor('audio-stream-processor', AudioStreamProcessor);
