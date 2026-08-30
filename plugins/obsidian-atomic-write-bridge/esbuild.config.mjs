import esbuild from "esbuild";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const entryFile = "src/main.ts";
const outdir = "build";
const outfile = join(outdir, "main.js");
const isWatch = process.argv.includes("--watch");

const buildOptions = {
  entryPoints: [entryFile],
  bundle: true,
  sourcemap: "inline",
  target: "es2020",
  format: "cjs",
  platform: "browser",
  outfile,
  banner: { js: "/* Optimike Atomic Write Bridge - build via esbuild */" },
  external: ["obsidian", "node:crypto"],
  minify: false,
  logLevel: "info",
};

function postBuild() {
  mkdirSync(outdir, { recursive: true });
  const manifestPath = "manifest.json";
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.main = "main.js";
    writeFileSync(
      join(outdir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
  }
  if (existsSync("styles.css")) {
    copyFileSync("styles.css", join(outdir, "styles.css"));
  }
}

async function build() {
  if (!isWatch) {
    rmSync(outdir, { recursive: true, force: true });
    await esbuild.build(buildOptions);
    postBuild();
    return;
  }
  const context = await esbuild.context({
    ...buildOptions,
    plugins: [
      {
        name: "atomic-write-bridge-post-build",
        setup(build) {
          build.onEnd((result) => {
            if (result.errors.length === 0) postBuild();
          });
        },
      },
    ],
  });
  await context.watch();
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
