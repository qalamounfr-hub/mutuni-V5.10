// MutuniDB : structure Matn -> Bab -> Bayt -> mots attendus.
// Remplace la saisie manuelle du textarea "Mutûn attendu" par une bibliothèque
// persistante de mutûn, organisée par matn (texte) puis bab (chapitre) puis
// bayt (vers).
//
// Le texte source (`textHaraka`) garde les harakat : c'est la référence
// d'affichage et le futur point d'entrée pour un moteur tajwid. Le cursor
// actuel (cursor.ts / normalize.ts) retire déjà systématiquement les harakat
// avant comparaison (tokenizeExpected -> normalizeArabic) ; ce module ne
// duplique pas cette normalisation, il fournit juste le texte source et
// laisse main.ts appeler cursor.setExpected(bayt.textHaraka) comme avant.
//
// Format d'import (voir importMatnFile) : un JSON par matn, structuré comme
// un tableau de bab { id, title, sub, clr, bayts: string[] }, où chaque bayt
// est "sadr # ajuz" (hémistiches séparés par '#'). C'est le format fourni
// par l'utilisateur pour ses 13 matns (tuhfa, alfiyya, waraqat, etc.).
import {CACHE_NAMESPACE} from './version';

export interface Bayt {
  id: string;            // ex: "tuhfa:muqaddima:1"
  babId: string;         // ex: "tuhfa:muqaddima"
  order: number;         // position du bayt dans le bab, à partir de 1
  textSadr: string;      // premier hémistiche, harakat conservées
  textAjuz: string;      // second hémistiche, harakat conservées
  textHaraka: string;    // texte complet (sadr + ajuz), harakat conservées — utilisé par le cursor
}

export interface Bab {
  id: string;             // ex: "tuhfa:muqaddima"
  matnId: string;         // ex: "tuhfa"
  title: string;          // ex: "المقدمة"
  sub?: string;           // ex: "Introduction"
  clr?: [string, string]; // couleurs d'affichage fournies par la source
  order: number;          // position du bab dans le matn, à partir de 1
}

export interface Matn {
  id: string;             // ex: "tuhfa"
  title: string;          // ex: "تحفة الأطفال"
}

/** Forme brute d'un fichier JSON matn tel que fourni par l'utilisateur. */
export interface RawMatnBab {
  id: string;
  title: string;
  sub?: string;
  clr?: [string, string];
  bayts: string[]; // "sadr # ajuz"
}

const DB = CACHE_NAMESPACE + '-mutundb';
const DB_VERSION = 2; // v2: passage au schéma Matn multiple (13 matns importés, remplace le seed unique tuhfa inventé)
const STORE_MATN = 'matn';
const STORE_BAB = 'bab';
const STORE_BAYT = 'bayt';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE_MATN)) db.createObjectStore(STORE_MATN, {keyPath: 'id'});
      if (!db.objectStoreNames.contains(STORE_BAB)) {
        const s = db.createObjectStore(STORE_BAB, {keyPath: 'id'});
        s.createIndex('matnId', 'matnId');
      }
      if (!db.objectStoreNames.contains(STORE_BAYT)) {
        const s = db.createObjectStore(STORE_BAYT, {keyPath: 'id'});
        s.createIndex('babId', 'babId');
      }
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

function txAll<T>(db: IDBDatabase, store: string, index: string, key: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readonly');
    const r = t.objectStore(store).index(index).getAll(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function putMatn(m: Matn) { const db = await openDB(); return tx(db, STORE_MATN, 'readwrite', s => s.put(m)); }
export async function putBab(b: Bab) { const db = await openDB(); return tx(db, STORE_BAB, 'readwrite', s => s.put(b)); }
export async function putBayt(v: Bayt) { const db = await openDB(); return tx(db, STORE_BAYT, 'readwrite', s => s.put(v)); }

export async function listMatns(): Promise<Matn[]> { const db = await openDB(); return tx(db, STORE_MATN, 'readonly', s => s.getAll()); }
export async function listBabs(matnId: string): Promise<Bab[]> { const db = await openDB(); const all = await txAll<Bab>(db, STORE_BAB, 'matnId', matnId); return all.sort((a, b) => a.order - b.order); }
export async function listBayts(babId: string): Promise<Bayt[]> { const db = await openDB(); const all = await txAll<Bayt>(db, STORE_BAYT, 'babId', babId); return all.sort((a, b) => a.order - b.order); }

/**
 * Tous les bayts d'un matn, tous babs confondus, dans l'ordre (bab.order
 * puis bayt.order) — pour le mode "réciter tout le matn" (5.8.0). Chaque
 * bayt garde son `babId` d'origine, donc l'écran de récitation peut afficher
 * de quel chapitre vient le bayt courant en cours de traversée.
 */
export async function listBaytsForMatn(matnId: string): Promise<Bayt[]> {
  const babs = await listBabs(matnId);
  const perBab = await Promise.all(babs.map(b => listBayts(b.id)));
  return perBab.flat();
}

export async function getBayt(id: string): Promise<Bayt | undefined> { const db = await openDB(); return tx(db, STORE_BAYT, 'readonly', s => s.get(id)); }

function clearStore(db: IDBDatabase, store: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const r = db.transaction(store, 'readwrite').objectStore(store).clear();
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

/** Vide entièrement la base (les trois stores). Utilisé pour repartir d'un import propre. */
export async function wipeAll() {
  const db = await openDB();
  await clearStore(db, STORE_BAYT);
  await clearStore(db, STORE_BAB);
  await clearStore(db, STORE_MATN);
}

/**
 * Supprime l'ancien seed inventé de la v1 (matn "tuhfat-al-atfal", 9 bayts
 * reconstitués à la main) s'il est présent, pour laisser la place à
 * l'import réel du fichier tuhfa.json fourni par l'utilisateur (5 bayts
 * pour la muqaddima, pas 9 — le seed v1 avait ajouté 4 vers en trop).
 */
async function removeLegacySeed() {
  const db = await openDB();
  const legacy = await tx<Matn | undefined>(db, STORE_MATN, 'readonly', s => s.get('tuhfat-al-atfal'));
  if (!legacy) return;
  const babs = await txAll<Bab>(db, STORE_BAB, 'matnId', 'tuhfat-al-atfal');
  for (const bab of babs) {
    const bayts = await txAll<Bayt>(db, STORE_BAYT, 'babId', bab.id);
    for (const v of bayts) await tx(db, STORE_BAYT, 'readwrite', s => s.delete(v.id));
    await tx(db, STORE_BAB, 'readwrite', s => s.delete(bab.id));
  }
  await tx(db, STORE_MATN, 'readwrite', s => s.delete('tuhfat-al-atfal'));
}

/**
 * Importe un matn depuis sa forme JSON brute (tableau de bab avec bayts
 * "sadr # ajuz"). Idempotent : ré-importer le même matnId écrase l'existant
 * proprement (put, pas d'accumulation de doublons).
 */
export async function importMatnFile(matnId: string, matnTitle: string, babs: RawMatnBab[]) {
  await putMatn({id: matnId, title: matnTitle});
  for (let babIndex = 0; babIndex < babs.length; babIndex++) {
    const rawBab = babs[babIndex];
    const babId = `${matnId}:${rawBab.id}`;
    await putBab({id: babId, matnId, title: rawBab.title, sub: rawBab.sub, clr: rawBab.clr, order: babIndex + 1});
    for (let baytIndex = 0; baytIndex < rawBab.bayts.length; baytIndex++) {
      const [sadr, ajuz] = rawBab.bayts[baytIndex].split('#').map(s => s.trim());
      await putBayt({
        id: `${babId}:${baytIndex + 1}`,
        babId,
        order: baytIndex + 1,
        textSadr: sadr ?? '',
        textAjuz: ajuz ?? '',
        textHaraka: [sadr, ajuz].filter(Boolean).join(' '),
      });
    }
  }
}

// Les 13 matns fournis par l'utilisateur, servis en statique depuis
// public/mutun/<id>.json (même format que RawMatnBab[]). Aucun des fichiers
// sources ne contient de titre de matn lisible (seulement des titres de bab,
// souvent "المقدمة" pour le premier bab de chacun) : le titre affiché ici
// est donc juste l'id technique. À corriger à la main si des titres humains
// sont voulus dans l'UI — je n'en ai pas inventé pour éviter de refaire
// l'erreur du seed précédent (texte non vérifié présenté comme fiable).
const BUNDLED_MATN_IDS = ['ajru', 'alfiyya', 'baiq', 'durr', 'haiy', 'jaz', 'qutrub', 'sakhawi', 'shat', 'shib', 'tayb', 'tuhfa', 'waraqat'];

/**
 * Importe les 13 matns embarqués dans public/mutun/ si la base ne les
 * contient pas encore. Supprime d'abord l'ancien seed v1 inventé (voir
 * removeLegacySeed) pour éviter un doublon "tuhfat-al-atfal" / "tuhfa".
 */
export async function bootstrapBundledMatns() {
  await removeLegacySeed();
  const existing = new Set((await listMatns()).map(m => m.id));
  const missing = BUNDLED_MATN_IDS.filter(id => !existing.has(id));
  if (!missing.length) return;
  for (const id of missing) {
    const res = await fetch(`/mutun/${id}.json`);
    if (!res.ok) throw new Error(`Import ${id}.json: HTTP ${res.status}`);
    const babs = await res.json() as RawMatnBab[];
    await importMatnFile(id, id, babs);
  }
}
