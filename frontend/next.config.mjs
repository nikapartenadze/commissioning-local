/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable standalone output for Docker
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
}

export default nextConfig
