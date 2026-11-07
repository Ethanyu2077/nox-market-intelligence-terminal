/* eslint-disable react-refresh/only-export-components */
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import { CrossExchangePanel } from '../CrossExchangePanel';
import type { MarketProject } from '../../shared/types';

// Minimal project used only by the browser test harness. Data comes from intercepted API
// responses in scripts/e2e-evidence.mjs; nothing here is real market data.
const project = {
  id: 'e2e', name: 'E2E Project', tokenSymbol: 'E2E', contractAddress: null,
  identitySource: 'symbol', identityNetwork: null, markets: [], primaryMarketId: null,
  monitoring: { defaultInterval: '5m', streamingEnabled: true, collectionMode: 'active' },
  archived: false, order: 0, createdAt: 1, updatedAt: 1,
} as unknown as MarketProject;

function Harness() {
  const [language, setLanguage] = useState<'en' | 'zh'>('en');
  return (
    <div style={{ padding: 16 }}>
      <button id="lang-toggle" onClick={() => setLanguage((value) => value === 'en' ? 'zh' : 'en')}>{language}</button>
      <CrossExchangePanel project={project} language={language} />
    </div>
  );
}

createRoot(document.getElementById('evidence-root') as HTMLElement).render(<StrictMode><Harness /></StrictMode>);
