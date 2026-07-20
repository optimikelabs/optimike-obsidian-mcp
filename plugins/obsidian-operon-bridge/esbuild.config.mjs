import esbuild from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const entryFile = "src/main.ts";
const outdir = "build";
const outfile = join(outdir, "main.js");
const isWatch = process.argv.includes("--watch");

const buildOptions = {
  entryPoints: [entryFile],
  bundle: true,
  sourcemap: "inline",
  target: "es2022",
  format: "cjs",
  platform: "browser",
  outfile,
  banner: { js: "/* Optimike Operon Bridge - generated with esbuild */" },
  external: ["obsidian"],
  minify: false,
  logLevel: "info",
};

function postBuild() {
  mkdirSync(outdir, { recursive: true });
  if (existsSync("manifest.json")) {
    const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
    manifest.main = "main.js";
    writeFileSync(join(outdir, "manifest.json"), JSON.stringify(manifest, null, 2));
  }
  if (existsSync("styles.css")) copyFileSync("styles.css", join(outdir, "styles.css"));
}

async function run() {
  if (isWatch) {
    const context = await esbuild.context(buildOptions);
    await context.watch();
    console.log(`Watching ${entryFile}`);
    return;
  }
  await esbuild.build(buildOptions);
  postBuild();
  console.log(`Built ${outfile}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
