import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

/**
 * S9.9 security headers. Scripts: same origin plus the official YouTube IFrame API
 * (inline is still needed by Next without nonces; eval only in development, as the
 * Next CSP guide documents). Frames: the YouTube player only. Images and API
 * connections are unchanged (Qloo artwork hosts vary). The referrer policy keeps the
 * origin on cross-origin requests, which the YouTube embed relies on.
 */
const csp = [
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} https://www.youtube.com https://s.ytimg.com`,
  "frame-src https://www.youtube.com",
  "child-src https://www.youtube.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
