'use strict';
const engine=require('./casino-segmentation');
async function segmentContacts(c,{apply,failedAgents,engineImpl=engine}={}){
 if(!apply||failedAgents)return {skipped:true,reason:!apply?'preview':'incomplete_sync'};
 await c.query('BEGIN');
 try{
  await c.query("SET LOCAL statement_timeout='300s'; SET LOCAL TIME ZONE 'America/Argentina/Buenos_Aires'");
  await c.query("SELECT pg_advisory_xact_lock(hashtext('casino-segmentation'))");
  const summary=await engineImpl.prepareSegmentation(c);
  const preserveActivityPlatforms=engineImpl.activityPreservationPlatforms();
  await engineImpl.applySegmentation(c,{preserveActivityPlatforms});
  await c.query('COMMIT');return {...summary,preserveActivityPlatforms};
 }catch(e){await c.query('ROLLBACK');throw e;}
}
module.exports={segmentContacts};
