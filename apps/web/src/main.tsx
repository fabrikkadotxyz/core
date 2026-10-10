import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.tsx';
import { openOutsideLinksInBrowser } from './desktop.ts';
import './styles.css';
import { startThemes } from './themes.ts';

openOutsideLinksInBrowser();
startThemes();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
