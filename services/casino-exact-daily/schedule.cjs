'use strict';
const FLOOR='2026-09-22';
const agents=Object.freeze({zeus:['betcoin','bigwin','farabet','ofizeus','royal','imperio'],bet30:['btcuno','btcdos','zeus','zeusroyal','bigwin','imperio']});
function validDay(day){return typeof day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(day+'T12:00:00Z'))&&new Date(day+'T12:00:00Z').toISOString().slice(0,10)===day;}
function addDay(day,n){if(!validDay(day))throw Error('DAY_INVALID');return new Date(Date.parse(day+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);}
function closedDay(now=new Date()){return addDay(new Date(now.getTime()-10800000).toISOString().slice(0,10),-1);}
function plan(cursor,until=closedDay()){
 if(!validDay(until)||until<FLOOR)throw Error('END_DAY_INVALID');
 if(cursor&&(!validDay(cursor.coveredFrom)||!validDay(cursor.coveredThrough)||cursor.coveredFrom>cursor.coveredThrough||cursor.coveredThrough>until||cursor.coveredThrough<FLOOR))throw Error('CURSOR_INVALID');
 // Replay two closed days for late arrival; always walk a gap oldest-first.
 const start=cursor?[FLOOR,cursor.coveredFrom,addDay(cursor.coveredThrough,-1)].sort().at(-1):FLOOR;
 const days=[];for(let d=start;d<=until&&days.length<31;d=addDay(d,1))days.push(d);
 return {days,coveredFrom:cursor?.coveredFrom||FLOOR,coveredThrough:days.at(-1),backlog:days.at(-1)<until};
}
module.exports={FLOOR,agents,validDay,addDay,closedDay,plan};
