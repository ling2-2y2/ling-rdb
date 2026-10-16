import { defineConfig } from 'tsdown'

/**
 * JS 打包（ESM 双入口：根 + orm 子路径）；产物扩展名取 .js。dts 不走打包器——
 * 相对路径模块增强（declare module）在单文件 dts 里会悬空失联，类型树由
 * tsconfig.build.json 经 tsc 直出。outExtensions 返回键是 `js`（写 `esm`
 * 会被静默忽略）。五方言驱动与 kysely 一律外置（真运行时依赖，不打进产物）。
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/orm/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'es2023',
  dts: false,
  sourcemap: true,
  clean: true,
  external: ['kysely', 'mysql2', 'pg', 'oracledb', 'dmdb', '@ling2/ling-cordis'],
  outExtensions: () => ({ js: '.js' }),
})
