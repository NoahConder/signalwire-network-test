// First: rtcstats-js must wrap RTCPeerConnection before anything creates one.
import './services/rtcTrace'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import { applyTheme, loadThemePreference } from './services/theme'
import './styles/globals.css'

// Resolve the theme to data-theme before the first paint so the page never
// flashes the other theme (see services/theme.ts).
applyTheme(loadThemePreference())

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
