import React from 'react';
import ReactDOM from 'react-dom/client';

import { App } from './App.js';
import './styles.css';

declare global {
  interface Window {
    __UI_DEFAULT_POLL_MS__?: number;
  }
}

const pollIntervalMs =
  typeof window.__UI_DEFAULT_POLL_MS__ === 'number' && window.__UI_DEFAULT_POLL_MS__ > 0
    ? window.__UI_DEFAULT_POLL_MS__
    : 10_000;

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Missing root element');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App defaultPollIntervalMs={pollIntervalMs} />
  </React.StrictMode>,
);
