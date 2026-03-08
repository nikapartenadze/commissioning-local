/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output for Docker (custom server wraps this)
  output: 'standalone',

  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
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

  // Proxy API calls to C# backend (SignalR proxied via /app/api/hub/ routes)
  async rewrites() {
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:5000'
    return [
      {
        source: '/api/backend/:path*',
        destination: `${backendUrl}/api/:path*`,
      },
    ]
  },
}

export default nextConfig
