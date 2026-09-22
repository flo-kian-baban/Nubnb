/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['react-map-gl', 'lucide-react'],
  serverExternalPackages: ['@sparticuz/chromium-min'],
  images: {
    /**
     * Vercel's image optimiser is switched off.
     *
     * `loader: 'custom'` means `next/image` never requests `/_next/image`, so
     * a page view costs no image transformations, no image cache reads or
     * writes, and no Fast Data Transfer for image bytes. The loader rewrites
     * a mirrored Storage URL to its pre-generated WebP variant at the nearest
     * width; see app/lib/image-loader.ts and app/lib/image-variants.ts.
     */
    loader: 'custom',
    loaderFile: './app/lib/image-loader.ts',

    /**
     * The only widths that exist in Storage.
     *
     * `next/image` builds its `srcset` from deviceSizes (for `sizes`-based
     * images) and imageSizes (for fixed widths), so constraining both to the
     * generated variants means every URL in every srcset resolves to a real
     * object. Kept in sync with VARIANT_WIDTHS in app/lib/image-variants.ts.
     *
     * The sources cap at 1200px wide — Airbnb serves `im_w=1200` — so there
     * is nothing above 1200 to offer.
     */
    deviceSizes: [750, 1200],
    imageSizes: [200],

    /**
     * Inert while `loader` is 'custom' — Next only enforces remotePatterns
     * for its own optimiser endpoint, which nothing now calls. Kept as the
     * record of which hosts property imagery legitimately comes from.
     */
    remotePatterns: [
      { protocol: 'https', hostname: 'images.unsplash.com' },
      { protocol: 'https', hostname: 'firebasestorage.googleapis.com' },
      { protocol: 'https', hostname: '*.firebasestorage.app' },
      { protocol: 'https', hostname: 'a0.muscache.com' },
      { protocol: 'https', hostname: 'a1.muscache.com' },
      { protocol: 'https', hostname: 'a2.muscache.com' },
    ],
  },
};

export default nextConfig;
