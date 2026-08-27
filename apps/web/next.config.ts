import type { NextConfig } from "next";
import { createMDX } from "fumadocs-mdx/next";

const nextConfig: NextConfig = {
  transpilePackages: ["@openmetal/sdk", "@openmetal/contracts", "@openmetal/events"],
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default createMDX()(nextConfig);
