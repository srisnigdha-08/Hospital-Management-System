import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
        <Toaster
          position="top-right"
          toastOptions={{
            duration: 4000,
            style: {
              background: '#0F2540',
              color: '#F5F7F9',
              fontFamily: '"Plus Jakarta Sans", sans-serif',
              fontSize: '0.875rem',
              borderRadius: '0.75rem',
            },
            success: { iconTheme: { primary: '#35BBAB', secondary: '#0F2540' } },
            error: { iconTheme: { primary: '#DC2626', secondary: '#0F2540' } },
          }}
        />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
