import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import ProtectedRoute from './auth/ProtectedRoute';
import RoleRoute from './auth/RoleRoute';
import AppLayout from './routes/AppLayout';
import LoginPage from './pages/LoginPage';
import HomePage from './pages/HomePage';

/* These are the pages each group will add their contents too: P1 */
/**
 * Route table.
 *
 * /login is public. Everything else sits under ProtectedRoute so it needs a
 * session, and under AppLayout so the navbar is always present. User
 * Management is nested one level deeper inside a RoleRoute because the access
 * matrix restricts it to HR.
 */
function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />

        <Route element={<ProtectedRoute />}>
          <Route element={<AppLayout />}>
            <Route index element={<HomePage />} />

            <Route path="profile" element={<ComingSoonPage title="Profile" />} />
            <Route path="users" element={<UserManagementPage />} />
            </Route>
          </Route>
        </Route>

        {/* Unknown routes fall back to the dashboard. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}

export default App;