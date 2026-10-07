import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import LoginPage from '../pages/LoginPage.jsx';
import FileTree from './FileTree/FileTree.jsx';
import { AuthProvider, useAuth } from '../auth/AuthContext.jsx';
import { ProtectedRoute } from './ProtectedRoute.jsx';
import LandingPage from '../pages/LandingPage.jsx';
import ResponseArea from './ResponseArea/ResponseArea.jsx';
import SubmissionTimeline from './SubmissionTimeline/SubmissionTimeline.jsx';
import CodeEditor from './CodeEditor.jsx';
import './App.css';

// Main authenticated layout
function DashboardLayout() {
  const { user, signOut } = useAuth();

  return (
    <main className="app-shell page-enter">
      <header className="app-header">
        <p>
          You are signed in as <strong>{user?.username}</strong>
        </p>
        <button type="button" className="app-signout" onClick={signOut}>
          Sign out
        </button>
      </header>

      {/* P4 file tree */}
      <FileTree />
    </main>
  );
}

function AppRoutes() {
  const { user, loading } = useAuth();

  if (loading) {
    return <p style={{ margin: 'auto' }}>Loading...</p>;
  }

  return (
    <Routes>
      {/* Public Route */}
      <Route
        path="/login"
        element={user ? <Navigate to="/dashboard" replace /> : <LoginPage />}
      />

      {/* Protected Routes */}
      <Route element={<ProtectedRoute />}>
        <Route path="/dashboard" element={<DashboardLayout />} />
        <Route path="/home" element={<LandingPage />} />
        <Route path="/code" element={<ResponseArea />} />
        <Route path="/codes" element={<SubmissionTimeline />} />
        <Route path="/coding" element={<CodeEditor />} />
        <Route path="/code-editor" element={<CodeEditor />} />
        {/* Add additional protected routes here (e.g. /profile, /settings) */}
      </Route>

      {/* Root redirect */}
      <Route
        path="/"
        element={<Navigate to={user ? '/dashboard' : '/login'} replace />}
      />

      {/* Fallback 404 / Catch-all */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function PlaceholderApp() {
  return (
    <>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </>
  );
}
