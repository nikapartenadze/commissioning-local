import { createBrowserRouter, Navigate } from 'react-router-dom'
import { lazy, Suspense } from 'react'

const CommissioningRedirect = lazy(() => import('../app/commissioning/page'))
const CommissioningPage = lazy(() => import('../app/commissioning/[id]/page'))
const GuidePage = lazy(() => import('../app/guide/page'))
const GuidedPage = lazy(() => import('../app/commissioning/[id]/guided/page'))
// central-tool: multi-MCM landing + settings
const McmLandingPage = lazy(() => import('../app/mcm/page'))
const FirmwarePage = lazy(() => import('../app/firmware/page'))
const McmSettingsPage = lazy(() => import('../app/settings/mcms/page'))
const UsersSettingsPage = lazy(() => import('../app/settings/users/page'))
const SyncPage = lazy(() => import('../app/sync/page'))

function Loading() {
  return (
    <div className="flex items-center justify-center h-screen text-muted-foreground">
      Loading...
    </div>
  )
}

function LazyPage({ Component }: { Component: React.LazyExoticComponent<any> }) {
  return (
    <Suspense fallback={<Loading />}>
      <Component />
    </Suspense>
  )
}

export const router = createBrowserRouter([
  // central-tool: multi-MCM dashboard is the default landing.
  // Direct deep-links to /commissioning/:id still work for single-MCM focus.
  { path: '/', element: <Navigate to="/mcm" replace /> },
  { path: '/commissioning', element: <LazyPage Component={CommissioningRedirect} /> },
  { path: '/commissioning/:id/guided', element: <LazyPage Component={GuidedPage} /> },
  { path: '/commissioning/:id', element: <LazyPage Component={CommissioningPage} /> },
  { path: '/guide', element: <LazyPage Component={GuidePage} /> },
  // central-tool: multi-MCM landing + settings
  { path: '/mcm', element: <LazyPage Component={McmLandingPage} /> },
  { path: '/firmware', element: <LazyPage Component={FirmwarePage} /> },
  { path: '/sync', element: <LazyPage Component={SyncPage} /> },
  { path: '/settings/mcms', element: <LazyPage Component={McmSettingsPage} /> },
  { path: '/settings/users', element: <LazyPage Component={UsersSettingsPage} /> },
])
