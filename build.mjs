// Empaqueta cada entrada en un único .mjs sin dependencias externas,
// así el plugin corre con `node` apenas se instala (sin npm install).
import { build } from "esbuild";

const entries = {
  "mcp-server": "src/mcp/server.ts",
  "pre-tool-guard": "src/hooks/pre-tool-guard.ts",
  "stop-gate": "src/hooks/stop-gate.ts",
};

for (const [name, entry] of Object.entries(entries)) {
  await build({
    entryPoints: [entry],
    outfile: `dist/${name}.mjs`,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: "warning",
  });
}
console.log("dist/ listo:", Object.keys(entries).map((n) => `${n}.mjs`).join(", "));
