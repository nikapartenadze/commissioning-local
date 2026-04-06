import { execSync } from 'child_process'

// Inject build info at compile time
let gitHash = 'dev'
let gitTag = ''
let buildDate = new Date().toISOString().split('T')[0]
try {
  gitHash = execSync('git rev-parse --short HEAD').toString().trim()
} catch {}
try {
  gitTag = execSync('git describe --tags --abbrev=0 2>/dev/null || echo ""').toString().trim()
} catch {}

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_BUILD_HASH: gitHash,
    NEXT_PUBLIC_BUILD_DATE: buildDate,
    NEXT_PUBLIC_BUILD_VERSION: gitTag || `build-${gitHash}`,
  },
  // Standalone output for Docker (custom server wraps this)
  output: 'standalone',

  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
    // Native modules - don't bundle, use Node.js require
    serverComponentsExternalPackages: ['ffi-rs', 'ws', 'better-sqlite3'],
  },

  reactStrictMode: process.env.NODE_ENV === 'development', // Disable in production to prevent double renders

  // Optimize for production
  compress: true,

  // Image optimization
  images: {
    remotePatterns: [],
    formats: ['image/avif', 'image/webp'],
  },

  // Font optimization - skip during build if network issues
  optimizeFonts: process.env.NODE_ENV === 'production' ? false : true,

  // Disable ESLint during build
  eslint: {
    ignoreDuringBuilds: true,
  },

  // Note: C# backend proxy removed - all APIs now handled by Next.js API routes
  // The old rewrite was:
  // async rewrites() {
  //   const backendUrl = process.env.BACKEND_URL || 'http://localhost:5000'
  //   return [{ source: '/api/backend/:path*', destination: `${backendUrl}/api/:path*` }]
  // }
}

export default nextConfig
