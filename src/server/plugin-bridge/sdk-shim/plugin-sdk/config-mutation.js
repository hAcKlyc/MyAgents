// OpenClaw relocated write helpers out of config-runtime. Bridge retains its
// normalized in-process snapshot; this never creates openclaw.json.
export {
  logConfigUpdated,
  readConfigFileSnapshotForWrite,
  mutateConfigFile,
  replaceConfigFile,
  updateConfig,
} from './config-runtime.js';
