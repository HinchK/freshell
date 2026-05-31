import React from 'react'
import { createRoot } from 'react-dom/client'
import './chooser.css'
import { LaunchChooser } from './chooser.js'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LaunchChooser />
  </React.StrictMode>,
)
