// SRS (répétition espacée) et journal de sessions — porté depuis l'ancienne
// interface React de l'utilisateur (mutuni-optimized), logique métier
// inchangée, stockage adapté en IndexedDB (cohérent avec mutuniDB.ts) au
// lieu de localStorage.
import {CACHE_NAMESPACE} from './version';

export type BaytStatus = 'new' | 'learning' | 'review' | 'mastered';

export interface BaytSrsState {
  status: BaytStatus;
  srsLevel: number;
  lastReviewedAt: number | null;
  nextDueAt: number; // dû tout de suite tant que jamais révisé
  reviewCount: number;
  lapseCount: number;
  errorWords: Record<number, number>; // { [wordIndex]: failCount }
}

export interface Session {
  id: string;
  startedAt: number;
  endedAt: number | null;
  matnId: string | null;
  babId: string;
  baytsReviewed: number;
  mode: string;
}

export interface DueBayt { matnId: string; babId: string; baytIdx: number; overdueDays: number; state: BaytSrsState; }

// Échelle SRS en jours. index 0 = "nouveau" (dû immédiatement).
export const SRS_INTERVALS_DAYS = [0, 1, 3, 7, 15, 30, 60, 90];
export const SRS_MAX_LEVEL = SRS_INTERVALS_DAYS.length - 1;

const nowMs = () => Date.now();
const daysToMs = (d: number) => d * 24 * 60 * 60 * 1000;

export function defaultBaytState(): BaytSrsState {
  return {status: 'new', srsLevel: 0, lastReviewedAt: null, nextDueAt: nowMs(), reviewCount: 0, lapseCount: 0, errorWords: {}};
}

/**
 * Calcule le nouvel état d'un bayt après une récitation, à partir d'un score
 * de couverture 0..1 (proportion de mots validés — voir LiveCursor.report().
 * score / total). Ne fait aucune écriture, retourne le nouvel état.
 */
export function applySrsResult(prevState: BaytSrsState, coverage: number): BaytSrsState {
  const s: BaytSrsState = {...prevState, errorWords: {...prevState.errorWords}};
  const t = nowMs();
  s.lastReviewedAt = t;

  if (coverage >= 0.90) {
    s.reviewCount += 1;
    s.srsLevel = Math.min(SRS_MAX_LEVEL, s.srsLevel + 1);
    s.status = s.srsLevel >= 4 ? 'mastered' : (s.srsLevel >= 1 ? 'review' : 'learning');
  } else if (coverage >= 0.70) {
    s.status = s.status === 'new' ? 'learning' : s.status;
    s.nextDueAt = t + daysToMs(1);
    return s;
  } else {
    s.lapseCount += 1;
    s.srsLevel = Math.max(0, s.srsLevel - 2);
    s.status = 'learning';
  }
  s.nextDueAt = t + daysToMs(SRS_INTERVALS_DAYS[s.srsLevel]);
  return s;
}

export type ManualNote = 'forgotten' | 'difficult' | 'correct' | 'easy';

/** Ajustement manuel (mode dictée/examen, sans score de couverture automatique). */
export function applyManualSrs(prevState: BaytSrsState, note: ManualNote): BaytSrsState {
  const s: BaytSrsState = {...prevState, errorWords: {...prevState.errorWords}};
  const table: Record<ManualNote, {level: number; days: number}> = {
    forgotten: {level: 0, days: 0},
    difficult: {level: Math.max(0, s.srsLevel - 1), days: 1},
    correct: {level: Math.min(SRS_MAX_LEVEL, s.srsLevel + 1), days: SRS_INTERVALS_DAYS[Math.min(SRS_MAX_LEVEL, s.srsLevel + 1)]},
    easy: {level: Math.min(SRS_MAX_LEVEL, s.srsLevel + 2), days: SRS_INTERVALS_DAYS[Math.min(SRS_MAX_LEVEL, s.srsLevel + 2)]},
  };
  const x = table[note] ?? table.correct;
  const t = nowMs();
  s.lastReviewedAt = t;
  s.reviewCount += 1;
  s.srsLevel = x.level;
  s.nextDueAt = t + daysToMs(x.days);
  s.status = x.level >= 4 ? 'mastered' : x.level >= 1 ? 'review' : 'learning';
  return s;
}

/** Enregistre les mots ratés d'une tentative, pour l'analyse d'erreurs. */
export function recordErrorWords(prevState: BaytSrsState, matches: {matched: boolean}[]): BaytSrsState {
  const errorWords = {...prevState.errorWords};
  matches.forEach((m, i) => { if (!m.matched) errorWords[i] = (errorWords[i] ?? 0) + 1; });
  return {...prevState, errorWords};
}

// ---------------------------------------------------------------------------
// Stockage IndexedDB : une entrée par (matnId, babId, baytIdx).
// ---------------------------------------------------------------------------
const DB = CACHE_NAMESPACE + '-srs';
const STORE_SRS = 'srs';
const STORE_SESSIONS = 'sessions';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE_SRS)) db.createObjectStore(STORE_SRS, {keyPath: 'key'});
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) db.createObjectStore(STORE_SESSIONS, {keyPath: 'id'});
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

const srsKey = (matnId: string, babId: string, baytIdx: number) => `${matnId}:${babId}:${baytIdx}`;

export async function getBaytState(matnId: string, babId: string, baytIdx: number): Promise<BaytSrsState> {
  const db = await openDB();
  const row = await tx<{key: string; state: BaytSrsState} | undefined>(db, STORE_SRS, 'readonly', s => s.get(srsKey(matnId, babId, baytIdx)));
  return row?.state ?? defaultBaytState();
}

export async function putBaytState(matnId: string, babId: string, baytIdx: number, state: BaytSrsState): Promise<void> {
  const db = await openDB();
  await tx(db, STORE_SRS, 'readwrite', s => s.put({key: srsKey(matnId, babId, baytIdx), matnId, babId, baytIdx, state}));
}

export async function listAllSrsStates(): Promise<Array<{matnId: string; babId: string; baytIdx: number; state: BaytSrsState}>> {
  const db = await openDB();
  return tx(db, STORE_SRS, 'readonly', s => s.getAll());
}

/**
 * Bayts dus (nextDueAt dépassé), tous matns/babs confondus, triés du plus en
 * retard au moins en retard. N'inclut jamais les bayts "new" jamais
 * travaillés (reviewCount===0) : ce ne sont pas des bayts "à réviser" mais
 * "à découvrir", hors périmètre de cette fonction.
 */
export async function getDueBayts(limit?: number): Promise<DueBayt[]> {
  const all = await listAllSrsStates();
  const t = nowMs();
  const due = all
    .filter(row => row.state.reviewCount > 0 && row.state.nextDueAt <= t)
    .map(row => ({matnId: row.matnId, babId: row.babId, baytIdx: row.baytIdx, overdueDays: (t - row.state.nextDueAt) / 86400000, state: row.state}));
  due.sort((a, b) => b.overdueDays - a.overdueDays);
  return limit ? due.slice(0, limit) : due;
}

// ---------------------------------------------------------------------------
// Sessions (journal d'activité : streaks, temps pratiqué)
// ---------------------------------------------------------------------------
export function startSession(matnId: string | null, babId: string, mode: string): Session {
  return {id: `${nowMs()}-${Math.random().toString(36).slice(2, 8)}`, startedAt: nowMs(), endedAt: null, matnId, babId, baytsReviewed: 0, mode};
}

export function endSession(session: Session, baytsReviewed: number): Session {
  return {...session, endedAt: nowMs(), baytsReviewed};
}

export async function logSession(session: Session): Promise<void> {
  const db = await openDB();
  await tx(db, STORE_SESSIONS, 'readwrite', s => s.put(session));
  // Purge les sessions de plus d'un an, comme l'ancienne version (évite une
  // croissance illimitée du stockage local).
  const cutoff = nowMs() - daysToMs(365);
  const all = await listSessions();
  for (const old of all) if (old.startedAt < cutoff) await tx(db, STORE_SESSIONS, 'readwrite', s => s.delete(old.id));
}

export async function listSessions(): Promise<Session[]> {
  const db = await openDB();
  return tx(db, STORE_SESSIONS, 'readonly', s => s.getAll());
}

/** Série de jours consécutifs avec au moins une session, en remontant depuis aujourd'hui (heure locale). */
export function computeStreak(sessions: Session[]): number {
  if (!sessions.length) return 0;
  const days = new Set(sessions.map(s => { const d = new Date(s.startedAt); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }));
  let streak = 0;
  const cursor = new Date();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const key = `${cursor.getFullYear()}-${cursor.getMonth()}-${cursor.getDate()}`;
    if (days.has(key)) { streak++; cursor.setDate(cursor.getDate() - 1); } else break;
  }
  return streak;
}

export function minutesToday(sessions: Session[]): number {
  const d = new Date();
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const ms = sessions.filter(s => s.startedAt >= startOfDay && s.endedAt).reduce((acc, s) => acc + ((s.endedAt as number) - s.startedAt), 0);
  return Math.round(ms / 60000);
}
