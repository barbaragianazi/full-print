import { defineConfig } from "vite";
import { resolve } from "node:path";

const src = (path: string) => resolve(import.meta.dirname, "src", path);

// Fonte em src/, manifest e ícones em public/, saída em dist/ (carregar no Chrome).
export default defineConfig({
  root: resolve(import.meta.dirname, "src"),
  publicDir: resolve(import.meta.dirname, "public"),
  base: "./",
  build: {
    outDir: resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    target: "es2022",
    minify: false,
    // os SVGs oficiais (src/img) saem como arquivos, sem virar data URI
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        popup: src("popup/popup.html"),
        preview: src("preview/preview.html"),
        "service-worker": src("background/service-worker.ts"),
      },
      output: {
        // O manifest referencia o service worker por um caminho fixo (sem hash).
        entryFileNames: (chunk) =>
          chunk.name === "service-worker" ? "background/service-worker.js" : "assets/[name]-[hash].js",
      },
    },
  },
});
