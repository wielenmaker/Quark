
import { transformAsync } from "@babel/core"
// @ts-expect-error - Types not important.
import ts from "@babel/preset-typescript"
// @ts-expect-error - Types not important.
import solid from "babel-preset-solid"
import { plugin } from "bun"

plugin({
  name: "bun-plugin-solid",
  setup: (build) => {
    // Match both forward slashes (Unix) and backslashes (Windows)
    build.onLoad({ filter: /[/\\]node_modules[/\\]solid-js[/\\]dist[/\\]server\.js$/ }, async (args) => {
      const path = args.path.replace("server.js", "solid.js")
      const code = await Bun.file(path).text()
      return { contents: code, loader: "js" }
    })
    build.onLoad({ filter: /[/\\]node_modules[/\\]solid-js[/\\]store[/\\]dist[/\\]server\.js$/ }, async (args) => {
      const path = args.path.replace("server.js", "store.js")
      const code = await Bun.file(path).text()
      return { contents: code, loader: "js" }
    })
    build.onLoad({ filter: /\.(js|ts)x$/ }, async (args) => {
      const code = await Bun.file(args.path).text()
      const transforms = await transformAsync(code, {
        filename: args.path,
        presets: [
          [
            solid,
            {
              moduleName: "@opentui/solid",
              generate: "universal",
            },
          ],
          [ts],
        ],
      })
      return {
        contents: transforms?.code ?? "",
        loader: "js",
      }
    })
  },
})
