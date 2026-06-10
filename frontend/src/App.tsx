import { RouterProvider } from 'react-router-dom'
import { ThemeProvider } from '@/components/theme-provider'
import { UserProvider, useUser } from '@/lib/user-context'
import { Toaster } from '@/components/ui/toaster'
import { ErrorBoundary } from '@/components/error-boundary'
import { ConnectionGuard } from '@/components/connection-guard'
import { LoginScreen } from '@/components/login-screen'
import { ChangePinGate } from '@/components/change-pin-gate'
import { router } from './router'

/**
 * Renders the auth gates ONLY when the server enforces auth (AUTH_REQUIRED).
 * In open mode (default / single-laptop / dev) authRequired is false and this
 * renders nothing — the app behaves exactly as before.
 */
function AuthGate() {
  const { isLoading, authRequired, needsLogin, mustChangePin } = useUser()
  if (isLoading || !authRequired) return null
  if (needsLogin) return <LoginScreen />
  if (mustChangePin) return <ChangePinGate />
  return null
}

export function App() {
  return (
    <ErrorBoundary>
      <UserProvider>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
          storageKey="commissioning-tool-theme"
        >
          <RouterProvider router={router} />
          {/* Login / first-run PIN gates (enforced-auth mode only). */}
          <AuthGate />
          {/* App-wide browser↔server connection guard: full-screen blocking
              overlay on heartbeat loss + slow banner, on every route. */}
          <ConnectionGuard />
          <Toaster />
        </ThemeProvider>
      </UserProvider>
    </ErrorBoundary>
  )
}
