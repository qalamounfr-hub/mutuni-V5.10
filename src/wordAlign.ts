// Alignement monotone par programmation dynamique, avec bande diagonale.
import { normalizeArabic, normalizeArabicLight, similarity } from './normalize';

export type AlignmentStatus = 'pending' | 'matched' | 'uncertain' | 'skipped';
export interface AlignmentWord { expected:string; heard:string|null; score:number; status:AlignmentStatus; index:number; heardIndex:number|null; }
export interface AlignmentResult { words: AlignmentWord[]; matches:number; total:number; position:number; }

export function wordsMatch(a:string,b:string):boolean { return similarity(a,b) >= 0.66; }

function scorePair(a:string,b:string):number {
  const aggressive = similarity(a,b);
  const light = similarity(normalizeArabicLight(a), normalizeArabicLight(b));
  // La variante légère départage les scores proches sans créer de collision الله/اله.
  return Math.abs(aggressive-light) < 0.12 ? Math.max(aggressive, light) : aggressive;
}

/** Réaligne tout l'historique : un mot précédemment sauté peut donc redevenir validé. */
export function alignWords(expectedRaw:string[], heardRaw:string[], band=15): AlignmentResult {
  const expected=expectedRaw.map(normalizeArabic).filter(Boolean), heard=heardRaw.map(normalizeArabic).filter(Boolean);
  const n=expected.length, m=heard.length;
  if (!n) return {words:[],matches:0,total:0,position:0};
  const inf=1e9, gapExpected=0.62, gapHeard=0.48;
  const dp:number[][]=Array.from({length:n+1},()=>Array(m+1).fill(inf));
  const back:Array<Array<[number,number, 'match'|'skip'|'insert']|null>>=Array.from({length:n+1},()=>Array(m+1).fill(null));
  dp[0][0]=0;
  for(let i=0;i<=n;i++) for(let j=0;j<=m;j++) {
    if(i===0&&j===0) continue;
    if(Math.abs(i-j)>band && !(i===n||j===m)) continue;
    if(i>0&&dp[i-1][j]+gapExpected<dp[i][j]) { dp[i][j]=dp[i-1][j]+gapExpected; back[i][j]=[i-1,j,'skip']; }
    if(j>0&&dp[i][j-1]+gapHeard<dp[i][j]) { dp[i][j]=dp[i][j-1]+gapHeard; back[i][j]=[i,j-1,'insert']; }
    if(i>0&&j>0) { const c=1-scorePair(expected[i-1],heard[j-1]); if(dp[i-1][j-1]+c<dp[i][j]) { dp[i][j]=dp[i-1][j-1]+c; back[i][j]=[i-1,j-1,'match']; } }
  }
  const rows=expected.map((e,index)=>({expected:e,heard:null as string|null,score:0,status:'pending' as AlignmentStatus,index,heardIndex:null as number|null}));
  let i=n,j=m, matches=0;
  while(i||j) { const b=back[i][j]; if(!b) { if(i) {i--; rows[i].status='skipped';} else j--; continue; } const [pi,pj,k]=b; if(k==='match') { const s=scorePair(expected[i-1],heard[j-1]); rows[i-1].heard=heard[j-1]; rows[i-1].score=s; rows[i-1].heardIndex=j-1; rows[i-1].status=s>=0.72?'matched':s>=0.55?'uncertain':'skipped'; if(s>=0.55) matches++; } else if(k==='skip') rows[i-1].status='skipped'; i=pi;j=pj; }
  const position=rows.findIndex(w=>w.status!=='matched');
  return {words:rows,matches,total:n,position:position<0?n:position};
}

export function alignedMatchCount(expectedWords:string[], actualWords:string[]) { const a=alignWords(expectedWords,actualWords); return {matches:a.matches,total:a.total}; }
