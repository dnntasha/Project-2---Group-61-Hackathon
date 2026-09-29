import { StrictMode, React } from 'react'
import { createRoot, ReactDOM } from 'react-dom/client'
import './index.css'
import PlaceholderApp from './components/PlaceholderApp.jsx'
import { BrowserRouter } from "react-router-dom";

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <PlaceholderApp />
    </BrowserRouter>
  </StrictMode>,
)
