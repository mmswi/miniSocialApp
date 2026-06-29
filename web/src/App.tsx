import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthProvider'
import { RequireAuth } from './auth/RequireAuth'
import { DashboardPage } from './pages/DashboardPage'
import { DocumentEditorPage } from './pages/DocumentEditorPage'
import { ForgotPasswordPage } from './pages/ForgotPasswordPage'
import { LoginPage } from './pages/LoginPage'
import { ResetPasswordPage } from './pages/ResetPasswordPage'
import { SecurityPage } from './pages/SecurityPage'
import { SignupPage } from './pages/SignupPage'
import { TwoFactorPage } from './pages/TwoFactorPage'

export const App = () => (
  <AuthProvider>
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {/* Public-ish: the server-side pending-MFA cookie (set at /login) is what actually gates it. */}
        <Route path="/2fa" element={<TwoFactorPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <DashboardPage />
            </RequireAuth>
          }
        />
        <Route
          path="/security"
          element={
            <RequireAuth>
              <SecurityPage />
            </RequireAuth>
          }
        />
        {/* The editor PAGE. Distinct from the REST resource path /documents/:id so a full page load /
            refresh isn't proxied to the API (which would return JSON). The app owns /editor/:id; the
            API owns /documents/:id. */}
        <Route
          path="/editor/:id"
          element={
            <RequireAuth>
              <DocumentEditorPage />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  </AuthProvider>
)
