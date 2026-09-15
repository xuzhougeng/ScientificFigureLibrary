import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
export default defineConfig({
  root: fileURLToPath(new URL("./app", import.meta.url)),
  plugins: [viteSingleFile()],
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: false,
    rollupOptions: { input: fileURLToPath(new URL("./app/local-app.html", import.meta.url)) },
  },
});
