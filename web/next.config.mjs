/** @type {import('next').NextConfig} */
const nextConfig = {
  // Self-contained server bundle: smaller footprint on the monitoring host.
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
