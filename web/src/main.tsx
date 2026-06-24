import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App'
import './index.css'

const rootElement = document.getElementById('root')
if (rootElement === null) {
  throw new Error('root element #root not found in index.html')
}

// GOTCHA — on local dev, StrictMode deliberately mounts → unmounts → remounts every component once
// to surface effect bugs. That double-fires AuthProvider's mount effect, so you'll see GET /auth/me
// hit TWICE on a refresh. It's dev-only (the production build calls it once) and harmless (idempotent
// read). Don't remove StrictMode to silence it — the double-invoke is the safety net working.
createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
