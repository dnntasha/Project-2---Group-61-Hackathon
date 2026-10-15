import { React, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';

import LoginPage from './pages/LoginPage.jsx';
import FileTree from './components/FileTree/FileTree.jsx';
import { AuthProvider, useAuth } from './auth/AuthContext.jsx';
import { ProtectedRoute } from './auth/ProtectedRoute.jsx';
import LandingPage from './pages/LandingPage.jsx';
import ResponseArea from './components/ResponseArea/ResponseArea.jsx';
import SubmissionTimeline from './components/SubmissionTimeline/SubmissionTimeline.jsx';
import CodeEditor from './components/CodeEditor/CodeEditor.jsx';
import GroupsPage from './pages/GroupsPage.jsx';
import GroupPage from './pages/GroupPage.jsx';

import './App.css';

// Main authenticated dashboard.
// Keeps the group/team UI and the editor/files UI on the same page.
function DashboardLayout() {
  const { user, signOut } = useAuth();
  const [groupId, setGroupId] = useState(null);

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

      {/* Group / team management */}
      <section className="dashboard-groups">
        {groupId ? (
          <GroupPage groupId={groupId} onBack={() => setGroupId(null)} />
        ) : (
          <GroupsPage onOpen={setGroupId} />
        )}
      </section>

      {/* Collaborative editor / file tree */}
      <section className="dashboard-editor">
        <FileTree />
      </section>
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
      {/* Public route */}
      <Route
        path="/login"
        element={user ? <Navigate to="/dashboard" replace /> : <LoginPage />}
      />

      {/* Protected routes */}
      <Route element={<ProtectedRoute />}>
        <Route path="/dashboard" element={<DashboardLayout />} />

        <Route path="/home" element={<LandingPage />} />

        <Route path="/code" element={<ResponseArea />} />

        <Route path="/codes" element={<SubmissionTimeline />} />

        <Route path="/coding" element={<CodeEditor />} />

        <Route path="/code-editor" element={<CodeEditor />} />
      </Route>

      {/* Root redirect */}
      <Route
        path="/"
        element={<Navigate to={user ? '/dashboard' : '/login'} replace />}
      />

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
