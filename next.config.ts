import type { NextConfig } from "next";

// The Python vision service. Proxied rather than called directly so the browser
// only ever talks to one origin: no CORS preflight on the detection loop, which
// fires several times a second while the camera is live.
const PY_API = process.env.PY_API_URL ?? "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: "/api/py/:path*", destination: `${PY_API}/:path*` }];
  },
};

export default nextConfig;
