import esbuild from "esbuild";
import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const banner = "/* Obsidian Bases Bridge - build via esbuild */";
const entryFile = "src/main.ts";
const outdir = "build";
const outfile = join(outdir, "main.js");
const isWatch = process.argv.includes("--watch");

const buildOptions = {
  entryPoints: [entryFile],
  bundle: true,
  sourcemap: "inline",
  target: "es2018",
  format: "cjs",
  platform: "browser",
  outfile,
  banner: { js: banner },
  external: ["obsidian", "node:crypto", "node:http", "node:url"],
  minify: false,
  logLevel: "info",
};

function postBuild() {
  mkdirSync(outdir, { recursive: true });

  const manifestPath = "manifest.json";
  const manifestOut = join(outdir, "manifest.json");
  if (existsSync(manifestPath)) {
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    m.main = "main.js";
    writeFileSync(manifestOut, JSON.stringify(m, null, 2));
  }

  if (existsSync("styles.css")) {
    copyFileSync("styles.css", join(outdir, "styles.css"));
  }
}

async function build() {
  if (isWatch) {
    const ctx = await esbuild.context({
      ...buildOptions,
      plugins: [
        {
          name: "obsidian-bases-bridge-post-build",
          setup(build) {
            build.onEnd((result) => {
              if (result.errors.length === 0) {
                try {
                  postBuild();
                  console.log(`Rebuilt → ${outfile}`);
                } catch (error) {
                  console.error(error);
                }
              }
            });
          },
        },
      ],
    });

    await ctx.watch();
    console.log("Watching for changes…");
  } else {
    await esbuild.build(buildOptions);
    postBuild();
    console.log(`Built → ${outfile}`);
  }
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
