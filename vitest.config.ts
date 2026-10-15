import { defineConfig } from 'vitest/config'

/**
 * 自含 vitest 配置——测试相对导入 `../src`，零 paths 插件；五方言 provider
 * 集成套件按各自 `DSH_*_URL` 环境变量门控（无实例=skip 非 fail，绝不指向
 * 共享业务库——users 套件 DROP 表、会话套件 TRUNCATE，务必专用库）。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})
