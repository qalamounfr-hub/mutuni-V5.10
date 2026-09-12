import type {LiveWord} from './liveCursor';
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function renderCursor(el:HTMLElement, words:LiveWord[]){const active=words.findIndex(w=>w.status==='pending'||w.status==='uncertain');el.innerHTML=words.map((w,i)=>`<span class="${i===active?'w-active ':''}w-${w.status==='matched'?'ok':w.status==='uncertain'?'doubt':w.status==='skipped'?'miss':'todo'}" title="${w.score.toFixed(2)}">${esc(w.expected)}</span>`).join(' ');}
export function renderReport(el:HTMLElement, words:LiveWord[]){el.textContent=words.map(w=>`${w.index+1}. ${w.expected} → ${w.heard??'—'} [${w.status}] ${w.score.toFixed(2)}`).join('\n');}
