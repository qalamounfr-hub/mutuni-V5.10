const DIACRITICS=/[\u064B-\u0652\u0670\u0640]/g;
export function normalizeArabicLight(input=''):string { return String(input).normalize('NFKC').replace(DIACRITICS,'').replace(/[آأإٱ]/g,'ا').replace(/ى/g,'ي').replace(/[،؛؟,:.!؟\-–—()[\]{}«»]/g,' ').replace(/\s+/g,' ').trim(); }
export function normalizeArabic(input=''):string { return normalizeArabicLight(input).replace(/ة/g,'ه').replace(/ؤ/g,'و').replace(/ئ/g,'ي').replace(/ء/g,''); }
// Dédup de lettres consécutives répétées (ex. ASR bégayant "سسميته" ->
// "سميته"). À appliquer UNIQUEMENT au texte issu de la reconnaissance vocale
// (heard), jamais au texte source attendu (expected) : des lettres doublées
// légitimes existent dans le texte arabe classique (الله, مدد...) et
// seraient sinon corrompues (bug trouvé et corrigé en 5.6.0 — la dédup
// s'appliquait auparavant aux deux côtés via normalizeArabic).
export function normalizeHeard(input=''):string { return normalizeArabic(input).replace(/(.)\1+/g,'$1'); }
export function tokenizeExpected(text:string):string[] { return normalizeArabic(text).split(/\s+/).filter(Boolean); }
// Tokenisation SANS substitution de lettres (pas de ة->ه, ى->ي, suppression
// harakat) : juste découpage en mots et nettoyage des espaces/ponctuation.
// Sert à obtenir le texte réellement affiché à l'utilisateur (bug corrigé en
// 5.6.3 : le texte affiché passait par tokenizeExpected/normalizeArabic,
// donc "رَحْمَةِ" s'affichait "رحمه" et "عَلَى" s'affichait "علي" — le texte
// affiché n'était déjà plus le vrai texte source avec harakat).
export function tokenizeRaw(text:string):string[] { return String(text).normalize('NFKC').replace(/[،؛؟,:.!؟\-–—()[\]{}«»]/g,' ').replace(/\s+/g,' ').trim().split(/\s+/).filter(Boolean); }
export function boundedLevenshtein(a:string,b:string,bound=Math.max(a.length,b.length)):number { let p=Array.from({length:b.length+1},(_,i)=>i); for(let i=1;i<=a.length;i++){const c=[i];for(let j=1;j<=b.length;j++)c[j]=Math.min(p[j]+1,c[j-1]+1,p[j-1]+(a[i-1]===b[j-1]?0:1));p=c;}return p[b.length]; }
export function similarity(a:string,b:string):number { const x=normalizeArabic(a),y=normalizeArabic(b),m=Math.max(x.length,y.length); return m?Math.max(0,1-boundedLevenshtein(x,y,m)/m):1; }
