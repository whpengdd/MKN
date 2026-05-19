import { defineConfig } from "vite";

// 内核位于 src/core,与外壳完全解耦;root 固定为仓库根。
//
// Tauri 迁移后,Vite 只负责把渲染端打进 `dist/`;外壳(窗口/IPC/打包)
// 全部由 Tauri CLI + src-tauri/ 接管,不再需要 vite-plugin-electron。
//
// 关键约束保持不变:`npm run dev` 是纯 vite 跑 5173。
//  - 浏览器直接开 → __TAURI_INTERNALS__ 缺失 → 降级纯编辑器(便于预览/验证)
//  - `tauri dev` 把 devUrl 指向同一个 5173,注入 Tauri 后走完整外壳
// 因此 dev 配置对两条路径通用,无需任何环境变量门控。
export default defineConfig({
  root: ".",
  // Tauri 期望固定端口且端口被占用时直接失败(而非自动换口,否则
  // tauri.conf.json 的 devUrl 对不上)。
  clearScreen: false,
  server: { port: 5173, strictPort: true, open: false },
  build: { outDir: "dist", emptyOutDir: true },
});
