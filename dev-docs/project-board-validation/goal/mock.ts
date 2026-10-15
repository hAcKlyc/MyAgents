export * from '../mock';
export const isTauriEnvironment=()=>true;
export async function getSessionGoal(sessionId,workspacePath){
 window.boardCalls.push({kind:'goal-read',sessionId,workspacePath});
 if(sessionId!=='alpha-2')return null;
 if(window.boardGoalError)throw new Error('Goal lookup unavailable (synthetic)');
 return {sessionId,workspacePath,status:window.boardGoalStatus??'active',isExecuting:false};
}
