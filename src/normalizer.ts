const DIACRITICS_RE=/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DE\u06DF-\u06ED\u0640]/g;
const NORM_MAP:Record<string,string>={"أ":"ا","إ":"ا","آ":"ا","ٱ":"ا","ة":"ه","ى":"ي"};
export function normalizeArabic(text:string){return text.replace(/\ufeff/g,"").replace(DIACRITICS_RE,"").replace(/./g,ch=>NORM_MAP[ch]??ch).split(/\s+/).filter(Boolean).join(" ");}
