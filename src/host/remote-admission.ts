import type {DesktopAdmissionResult} from '../server/session-engine/types';

/** Queue admission is already a real owner result. Remote chat must release
 * its mutation UI while that queued turn awaits an earlier human response. */
export async function settleHostSessionAdmission(remote:boolean,result:DesktopAdmissionResult) {
  if (!result.success) throw new Error('Session message admission failed');
  if (remote && result.queued && result.queueId) {
    void result.dispatchAcceptance?.catch(()=>{});
    return {accepted:true,queued:true,queueId:result.queueId};
  }
  const accepted=result.dispatchAcceptance ? await result.dispatchAcceptance:undefined;
  if (accepted && !accepted.accepted) throw new Error(/^REMOTE_[A-Z_]+$/.test(accepted.error??'') ? accepted.error:'Session dispatch was rejected');
  return {accepted:true,queued:result.queued,queueId:result.queueId};
}
