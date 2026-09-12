import {similarity} from './normalize';
export interface ExpectedHypothesis {word:string; score:number;}
/** Scaffold de rescoring : branchement futur des log-probs, sans dépendance lourde. */
export function rescoreExpectedWindow(ctcWords:string[], expected:string[], cursor:number, enabled=true):ExpectedHypothesis[]{
  if(!enabled) return ctcWords.map(word=>({word,score:0}));
  const allowed=expected.slice(cursor,cursor+10);
  return ctcWords.map(word=>({word,score:Math.max(...allowed.map(e=>similarity(e,word)),0)})).sort((a,b)=>b.score-a.score);
}
