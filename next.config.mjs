/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['react-map-gl', 'lucide-react'],
  serverExternalPackages: ['@sparticuz/chromium-min'],
};

export default nextConfig;
