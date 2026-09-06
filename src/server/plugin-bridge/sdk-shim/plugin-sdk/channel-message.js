// Weixin 2.4.8 imports typing callbacks from channel-message; 2.4.6 uses
// channel-runtime. Both paths share the existing Bridge-mode typing policy.
export { createTypingCallbacks } from './channel-runtime.js';
