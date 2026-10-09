import { join } from "node:path";
import { compileAppCss } from "./guide-preview-css";

/**
 * Writes the app stylesheet the compiled sidecar embeds for `guide.preview`
 * (`sidecar/guide/preview-css.ts`). Runs before `bun build --compile` in
 * `build:sidecar`; the output is git-ignored.
 */
const out = join(import.meta.dir, "../sidecar/guide/app-stylesheet.gen.txt");
await Bun.write(out, await compileAppCss(join(import.meta.dir, "../src")));
console.log(`wrote ${out}`);
