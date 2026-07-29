import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const root = fileURLToPath(new URL("./app", import.meta.url));
const outDir = fileURLToPath(new URL("./dist", import.meta.url));

export default defineConfig({
  root,
  plugins: [viteSingleFile()],
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL("./app/mcp-app.html", import.meta.url)),
    },
  },
});
