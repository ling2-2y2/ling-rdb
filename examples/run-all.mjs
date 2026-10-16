// 冒烟总入口：依次运行 examples/ 下全部自含示例，任一失败即非零退出。
// CI（ci.yml 的 pnpm smoke）与本仓发布前验证都走本文件。
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const examples = readdirSync(here, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => join(entry.name, 'boot.mjs'))
  .sort()

let failed = 0
for (const relative of examples) {
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', join(here, relative)], { stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`✗ ${relative}`)
    failed += 1
  } else {
    console.log(`✓ ${relative}`)
  }
}
if (failed > 0) {
  console.error(`${failed}/${examples.length} 个示例失败`)
  process.exit(1)
}
console.log(`all ${examples.length} examples OK`)
