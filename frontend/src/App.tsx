import { RouterProvider } from 'react-router-dom'
import { ThemeProvider } from '@/components/theme-provider'
import { UserProvider } from '@/lib/user-context'
import { Toaster } from '@/components/ui/toaster'
import { ErrorBoundary } from '@/components/error-boundary'
import { ServerLaptopBanner } from '@/components/server-laptop-banner'
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
          <ServerLaptopBanner />
          <RouterProvider router={router} />
          <Toaster />
        </ThemeProvider>
      </UserProvider>
    </ErrorBoundary>
  )
}
