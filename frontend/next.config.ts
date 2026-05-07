import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  // Excluir pg del bundle de webpack — se resuelve en runtime por Node.js
  serverExternalPackages: ['pg', 'pg-native'],
};

export default nextConfig;
