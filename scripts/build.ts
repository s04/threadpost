import { join } from "node:path";

const root = join(import.meta.dir, "..");
const result = await Bun.build({
  entrypoints: [join(root, "src/browser/admin.ts"), join(root, "src/browser/widget.ts")],
  outdir: join(root, "public"), target: "browser", format: "iife", minify: false,
});
if (!result.success) {
  for (const log of result.logs) console.error(log.message);
  process.exit(1);
}
console.log("Built admin and widget browser bundles from TypeScript.");
