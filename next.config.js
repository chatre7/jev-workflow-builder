/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: { root: __dirname },
  reactStrictMode: true,
  allowedDevOrigins: ["*.ngrok-free.app", "*.ngrok.io", "*.loca.lt"],
  async headers() {
    return [
      {
        // Refuse framing so another site cannot overlay Run or Approve (clickjacking).
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
