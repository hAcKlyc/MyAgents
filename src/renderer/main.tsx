import React from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { ToastProvider } from './components/Toast';
import { ImagePreviewProvider } from './context/ImagePreviewContext';
import { initFrontendLogger } from './utils/frontendLogger';

import './index.css';

// Initialize frontend logger to capture React console logs
initFrontendLogger();

const root = createRoot(document.getElementById('root')!);
// Note: React.StrictMode removed to prevent double-rendering of SSE effects in development
// StrictMode causes useEffect to run twice, which duplicates SSE events and thinking blocks
root.render(
  <ToastProvider>
    <ImagePreviewProvider>
      <App />
    </ImagePreviewProvider>
  </ToastProvider>
);
