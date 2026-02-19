import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { HealthCheckProvider } from './contexts/HealthCheckContext';
import { AuthProvider } from './contexts/AuthContext';

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(
  <React.StrictMode>
    <HealthCheckProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </HealthCheckProvider>
  </React.StrictMode>
);
