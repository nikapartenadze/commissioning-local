import { createBrowserRouter, Navigate } from 'react-router-dom'
import { lazy, Suspense } from 'react'

const CommissioningRedirect = lazy(() => import('../app/commissioning/page'))
const CommissioningPage = lazy(() => import('../app/commissioning/[id]/page'))
const SetupPage = lazy(() => import('../app/setup/page'))
const GuidePage = lazy(() => import('../app/guide/page'))
const GuideScreenshots = lazy(() => import('../app/guide/screenshots/page'))
const GuidedPage = lazy(() => import('../app/commissioning/[id]/guided/page'))

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
  { path: '/', element: <Navigate to="/commissioning/_" replace /> },
  { path: '/commissioning', element: <LazyPage Component={CommissioningRedirect} /> },
  { path: '/commissioning/:id/guided', element: <LazyPage Component={GuidedPage} /> },
  { path: '/commissioning/:id', element: <LazyPage Component={CommissioningPage} /> },
  { path: '/setup', element: <LazyPage Component={SetupPage} /> },
  { path: '/guide', element: <LazyPage Component={GuidePage} /> },
  { path: '/guide/screenshots', element: <LazyPage Component={GuideScreenshots} /> },
])
