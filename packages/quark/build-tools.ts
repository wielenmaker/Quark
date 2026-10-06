import { readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Compile the bundled standard tools (`tools/*.ts`) into `dist/tools/*.js`.
 *
 * The installed app runs under Node, which refuses to type-strip files inside
 * node_modules. Shipping plain JS keeps the bundled tools loadable from an
 * installed package, while their npm deps (zod/glob/turndown) resolve at
 * runtime from the app's own node_modules.
 */
export async function buildTools(outdir = fileURLToPath(new URL("./dist/tools/", import.meta.url))) {
  const srcDir = fileURLToPath(new URL("./tools/", import.meta.url))
  const entrypoints = readdirSync(srcDir)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => join(srcDir, file))
  if (entrypoints.length === 0) return

  const result = await Bun.build({
    entrypoints,
    outdir,
    target: "node",
    format: "esm",
    packages: "external",
    naming: "[name].js",
    sourcemap: "linked",
  })
  if (!result.success) throw new AggregateError(result.logs, "tools build failed")
  return result
}

if (import.meta.main) {
  const result = await buildTools()
  for (const output of result?.outputs ?? []) console.log(`tool ${output.path} (${output.size} bytes)`)
}
