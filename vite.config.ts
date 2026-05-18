import { defineConfig } from "vite";

// 内核位于 src/core,与外壳完全解耦;root 固定为仓库根。
//
// 关键约束:`npm run dev` 必须保持"纯 vite 跑 5173",绝不拉起 Electron
// (协调者的浏览器验证 / 预览工具依赖这一点)。而 vite-plugin-electron 一旦
// 出现在插件列表里,`vite serve` 就会自动 spawn Electron。
// 因此用环境变量 MKN_ELECTRON 作开关:只有 electron:dev / electron:build
// 这两个脚本会置位,普通 `dev` / `build` 完全感知不到该插件。
const electronEnabled = process.env.MKN_ELECTRON === "1";

export default defineConfig(async () => {
  const plugins = [];

  if (electronEnabled) {
    // 动态 import:未开启时连模块都不加载,杜绝任何副作用渗入纯 vite 流程。
    const electron = (await import("vite-plugin-electron/simple")).default;
    plugins.push(
      ...(await electron({
        main: {
          // 主进程入口;产物 → dist-electron/main.js(CJS)。
          entry: "electron/main.ts",
        },
        preload: {
          input: "electron/preload.ts",
          // ★ 强制 CommonJS 产物 preload.cjs。
          // package.json 有 "type":"module",默认会把 preload 打成 ESM(.mjs);
          // 而 Electron 的 ESM preload 极不稳(常静默加载失败 → window.mkn 不
          // 存在 → 渲染端误入浏览器降级,文件树/菜单全失效)。Electron 官方
          // 对 contextBridge preload 推荐 CJS,这里固定 .cjs 最稳。
          vite: {
            build: {
              rollupOptions: {
                output: { format: "cjs", entryFileNames: "preload.cjs" },
              },
            },
          },
        },
        // 渲染端无需 Node API(全部经 preload + IPC),renderer 留默认即可。
        renderer: {},
      }))
    );
  }

  return {
    root: ".",
    plugins,
    server: { port: 5173, open: false },
    build: { outDir: "dist", emptyOutDir: true },
  };
});
