// Retain one typing lifecycle across channel-runtime (old), channel-message
// (2026.8), and channel-outbound (2026.10). An undefined stub disables the
// plugin's import fallback but cannot supply the callbacks it needs.
export { createTypingCallbacks } from './channel-runtime.js';
