/**
 * 门户域业务层 —— 照 ling-dsh-admin-pro/src/portal/portal.service.ts 形态：
 * 只编排业务规则（判重拒绝、三态语义、发布快照），数据动作全部委托仓储。
 */
import { PortalCodeDuplicateError } from './portal.repository.mjs'

export class PortalService {
  constructor(repository) { this.repo = repository }

  /** 创建门户：编码判重走异常，不走返回值。 */
  async create(input) {
    if (await this.repo.enCodeExists(input.enCode)) throw new PortalCodeDuplicateError()
    return this.repo.insert({ ...input, enabledMark: 1 })
  }

  /** 保存用户自定义布局（CUSTOM 态，按用户维隔离）。 */
  async saveCustomLayout(portalId, formData, userId) {
    return this.repo.upsertData(portalId, 'CUSTOM', 'default', formData, userId)
  }

  /** 发布：落 RELEASE 快照行（独立于 CUSTOM 存在，平台维隔离）。 */
  async publishSnapshot(portalId, platform, formData) {
    return this.repo.upsertData(portalId, 'RELEASE', platform, formData)
  }

  /** 分页列表：items + total 双查。 */
  async listPage(query) {
    const items = await this.repo.list(query)
    return { total: await this.repo.count(query), items }
  }

  /** 删除（逻辑删：mbp 盖删位，行不物理消失）。 */
  async remove(id) { return this.repo.mapper.deleteById(id) }
}
