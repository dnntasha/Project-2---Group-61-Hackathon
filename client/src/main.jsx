import { StrictMode, React } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
//import PlaceholderApp from './components/PlaceholderApp.jsx';
import App from './App.jsx';
//import { BrowserRouter } from 'react-router-dom';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {/* <BrowserRouter>
      <PlaceholderApp />
    </BrowserRouter> */}
    <App />
  </StrictMode>
);
