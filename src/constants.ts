// Paramètres ajustables du flux audio.
// Restaurés à 3 s / hop 1,5 s (config d'origine, CHANGE-REPORT.md) : la
// version à 1,5 s / 1,0 s réduisait trop le contexte acoustique fourni au
// FastConformer et dégradait nettement la reconnaissance (comparé à Lab v5).
export const AUDIO_WINDOW_SECONDS=3.0;
export const AUDIO_HOP_SECONDS=1.5;
export const AUDIO_WINDOW=Math.round(16000*AUDIO_WINDOW_SECONDS);
export const AUDIO_HOP=Math.round(16000*AUDIO_HOP_SECONDS);
export const AUDIO_MIN_TAIL=8000;
export const CONSTRAINED_DECODING_ENABLED=true;
export const ALIGNMENT_BAND=15;

// VAD (5.8.0) : détection de silence dans audio-processor.js pour déclencher
// un flush anticipé de la fenêtre en cours (fin d'hémistiche/bayt probable),
// au lieu d'attendre la fin de la fenêtre fixe de 3 s. Le VAD ne décide QUE
// du moment où l'audio déjà accumulé est envoyé au modèle — il ne peut pas
// faire apparaître un mot non prononcé (voir CHANGELOG 5.8.0).
//
// Seuil RMS sous lequel un bloc de 0.5 s est considéré silencieux. Aligné
// sur le seuil déjà utilisé côté micEngine.ts (ligne ~91) pour ignorer les
// blocs de silence complet — cohérence entre les deux couches.
export const VAD_SILENCE_RMS=0.003;
// Durée de silence continu requise avant de déclencher un flush anticipé.
// Volontairement plus long qu'une simple micro-pause de tajwid (ghunna,
// madd court) pour éviter de couper une fenêtre en plein milieu d'un mot
// prolongé ; mais assez court pour rester perceptiblement plus réactif que
// d'attendre la fin d'une fenêtre de 3 s.
export const VAD_SILENCE_MS=450;
// Nombre minimal d'échantillons dans le buffer avant qu'un vad-flush soit
// exécuté (sinon ignoré, le buffer continue de s'accumuler normalement).
// Évite de gaspiller une inférence sur un très court bout de parole suivi
// d'un silence (ex. un seul mot bref) où le contexte acoustique serait trop
// pauvre pour une reconnaissance fiable — même logique que AUDIO_MIN_TAIL.
export const VAD_MIN_FLUSH_SAMPLES=8000;
