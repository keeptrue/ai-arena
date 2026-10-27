/**
 * Build the offline replay assets.
 *
 * The export route only reads files: Next refuses `react-dom/server` inside a
 * route handler, so the standalone page carries a prebuilt client runtime
 * instead of rendering on demand. Run this before dev/build/start.
 */

import { build } from "bun";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const root = process.cwd();
const outDir = path.join(root, "public", "export");

async function main() {
  await mkdir(outDir, { recursive: true });

  const cssFrom = path.join(root, "src", "app", "globals.css");
  const cssSource = await readFile(cssFrom, "utf8");
  const compiled = await postcss([tailwind()]).process(cssSource, { from: cssFrom, map: false });
  // Drop the generator banner: the exported file should not carry an external URL.
  const css = compiled.css.replace(/^\/\*!\s*tailwindcss[\s\S]*?\*\/\s*/, "");
  if (/<\/style/i.test(css)) {
    throw new Error("compiled css contains </style and cannot be inlined");
  }
  await writeFile(path.join(outDir, "replay.css"), css);

  const result = await build({
    entrypoints: [path.join(root, "src", "export", "replay.tsx")],
    outdir: outDir,
    naming: "replay.js",
    target: "browser",
    // A classic script, not a module: file:// blocks module scripts via CORS.
    format: "iife",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("replay bundle failed");
  }

  const jsStat = await stat(path.join(outDir, "replay.js"));
  const cssStat = await stat(path.join(outDir, "replay.css"));
  console.log(
    `export assets: replay.js ${(jsStat.size / 1024).toFixed(0)}KB · replay.css ${(cssStat.size / 1024).toFixed(0)}KB`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
