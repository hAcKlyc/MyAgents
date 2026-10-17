export * from '../goal/mock';
import { getSnapshot as originalSnapshot } from '../mock';
const original=originalSnapshot();
const snapshot={...original,sessions:original.sessions.filter(session=>session.id==='alpha-2')};
export const getSnapshot=()=>snapshot;
