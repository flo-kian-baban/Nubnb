/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['react-map-gl', 'lucide-react'],
  serverExternalPackages: ['@sparticuz/chromium-min'],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'images.unsplash.com',
      },
      {
        protocol: 'https',
        hostname: 'firebasestorage.googleapis.com',
      },
      {
        protocol: 'https',
        hostname: '*.firebasestorage.app',
      },
      {
        protocol: 'https',
        hostname: 'a0.muscache.com',
      },
      {
        protocol: 'https',
        hostname: 'a1.muscache.com',
      },
      {
        protocol: 'https',
        hostname: 'a2.muscache.com',
      },
    ],
  },
};

export default nextConfig;
