import nextConfig from "@openmetal/eslint-config/next";

const config = [...nextConfig, { ignores: [".source/**"] }];

export default config;
