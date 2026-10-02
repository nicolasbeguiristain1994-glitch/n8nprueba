'use strict';
const exact=require('./exact.cjs');
const BONUS=/(?:^|[^\p{L}\p{M}\p{N}_])bonos?(?=$|[^\p{L}\p{M}\p{N}_])/iu;
function normalize(raw,platform,agent,day){
 const rows=[],excludedIds=[],unsupportedIds=[],nonPlayerRows=[];let creatorMismatch=0;
 for(const r of raw){
  if(platform==='bet30'&&typeof r.detalles==='string'&&BONUS.test(r.detalles)&&!/(carga|retiro|indirecto)/i.test(r.detalles)){
   exact.sourceId(r.id);exact.exactCents(r.valor);if(exact.timestamp(r.fecha,true).day!==day)throw Error('BONUS_DAY_INVALID');unsupportedIds.push(r.id);continue;
  }
  const n=exact.normalizeRaw(r,{platform,agent,day});
  if(n.excluded){excludedIds.push(n.id);continue;}
  if(n.creatorMismatch)creatorMismatch++;
  if(n.row.username.length>100)throw Error('PLAYER_NAME_TOO_LONG');
  if(n.row.username.toLowerCase()===agent.toLowerCase()){excludedIds.push(n.id);nonPlayerRows.push(n.row);continue;}
  rows.push({...n.row,platform});
 }
 return {rows,excludedIds,unsupportedIds,nonPlayerRows,creatorMismatch};
}
module.exports={normalize};
