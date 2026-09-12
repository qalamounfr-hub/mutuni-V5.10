// NOTE (5.4.0) : ce curseur (DP bandé, alignement "tolérant") n'est plus le
// curseur affiché en direct dans main.ts — voir liveCursor.ts (mode
// "karaoké" strict, texte connu à l'avance) qui l'a remplacé pour éviter
// deux bugs de désynchronisation trouvés en usage réel (CHANGELOG 5.3.1).
// Conservé volontairement : cette approche DP reste pertinente pour un
// futur rapport de fin de session (mode premium rouge/jaune/vert), où on
// veut justement un alignement tolérant sur tout le transcript après coup,
// pas un curseur strict en direct. Ne pas supprimer sans avoir statué sur
// ce futur usage.
import {tokenizeExpected, normalizeArabic, similarity} from './normalize';
import {alignMonotone, AlignmentStep} from './alignment';
export type CursorStatus = 'pending' | 'matched' | 'uncertain' | 'skipped';
export interface CursorWord { expected:string; heard:string|null; score:number; status:CursorStatus; index:number; heardIndex:number|null; }
export class Cursor {
  private expected:string[]=[]; private heard:string[]=[]; private words:CursorWord[]=[]; private position=0; private heardPosition=0;
  constructor(expected:string|string[]=[]){this.setExpected(expected)}
  setExpected(e:string|string[]){this.expected=Array.isArray(e)?e.map(normalizeArabic).filter(Boolean):tokenizeExpected(e); this.reset()}
  reset(){this.heard=[]; this.position=0; this.heardPosition=0; this.words=this.expected.map((expected,index)=>({expected,heard:null,score:0,status:'pending',index,heardIndex:null}))}
  advance(words:string[]){
    const normalized=words.map(normalizeArabic).filter(Boolean);
    if (normalized.length < this.heard.length) return this.snapshot();
    this.heard=normalized;
    const result=alignMonotone(this.expected,this.heard,this.position,this.heardPosition,{window:12,maxSkip:1});
    // Ne marquer matched/uncertain que pour les mots dans le préfixe
    // effectivement validé (expectedIndex < nextExpected) : alignMonotone
    // retourne dans `steps` tout le chemin du backtrack, y compris les pas
    // situés après le point où sa propre boucle d'avancement s'est arrêtée
    // (score sous le seuil 0.55, ou skip refusé). Sans ce filtre, un mot
    // pouvait s'afficher "validé" alors que position (curseur réel) était
    // resté bloqué avant lui — les deux indicateurs devenaient incohérents.
    for(const step of result.steps){ if(step.expectedIndex>=result.nextExpected) continue; const w=this.words[step.expectedIndex]; if(!w || w.status!=='pending') continue; if(step.decision==='match'||step.decision==='uncertain'){w.heard=this.heard[step.heardIndex ?? 0]??null;w.score=step.score;w.heardIndex=step.heardIndex;w.status=step.decision === 'match' ? 'matched' : 'uncertain';} }
    this.position=Math.max(this.position,result.nextExpected); this.heardPosition=Math.max(this.heardPosition,result.nextHeard); return this.snapshot();
  }
  snapshot(){return this.words.map(w=>({...w}))}
  report(){const c={pending:0,matched:0,skipped:0,uncertain:0};this.words.forEach(w=>c[w.status]++);return {...c,total:this.words.length,position:this.position,score:this.words.length?Math.round((c.matched+c.uncertain*.5)/this.words.length*100):0}}
}
