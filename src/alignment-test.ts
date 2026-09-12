import {alignWords} from './wordAlign';
const cases=[['exact',['a','b','c']],['recovery',['a','c']],['repeat',['a','a','b']],['insert',['a','x','b']]];
for(const [name,heard] of cases){const r=alignWords(['a','b','c'],heard as string[]);console.log(name,r.words.map(w=>w.status).join(','),r.position)}
