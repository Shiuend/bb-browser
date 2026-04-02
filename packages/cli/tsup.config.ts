import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8"));

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node18",
  banner: {
    js: "#!/usr/bin/env node",
  },
  define: {
    __BB_BROWSER_VERSION__: JSON.stringify(pkg.version),
  },
  // ws 使用 Node.js 内置模块，需要标记为外部依赖
  external: ["ws"],
  noExternal: [],
});
