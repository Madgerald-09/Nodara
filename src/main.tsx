import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ClientProvider } from '@solana/react'
import { solanaClient } from './lib/solana'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClientProvider client={solanaClient}>
      <App />
    </ClientProvider>
  </StrictMode>,
)
