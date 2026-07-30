import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['@prisma/client', 'bcryptjs'],
  output: 'standalone',
  // CSV imports post parsed rows through a server action; the 1 MB default
  // rejects a few thousand contacts.
  experimental: { serverActions: { bodySizeLimit: '12mb' } },
}

export default nextConfig
