import { RouterProvider } from 'react-router-dom'
import { ThemeProvider } from '@/components/theme-provider'
import { UserProvider } from '@/lib/user-context'
import { Toaster } from '@/components/ui/toaster'
import { ErrorBoundary } from '@/components/error-boundary'
import { ConnectionGuard } from '@/components/connection-guard'
import { router } from './router'

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
          {/* App-wide browser↔server connection guard: full-screen blocking
              overlay on heartbeat loss + slow banner, on every route. */}
          <ConnectionGuard />
          <Toaster />
        </ThemeProvider>
      </UserProvider>
    </ErrorBoundary>
  )
}
