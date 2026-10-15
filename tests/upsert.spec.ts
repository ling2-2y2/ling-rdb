/**
 * 方言写语句收敛层回归钉（波次 4.4 挂账⑤）：结构化三态渲染（原 store
 * dialect.ts 收编上移的黄金断言迁自 store codec.spec 覆盖面）+ 文本适配
 * 的翻译黄金断言（ON DUPLICATE/INSERT IGNORE 两族、VALUES(col)→EXCLUDED、
 * 含引号/括号的更新尾巴、多行语句、 mysql 直通零改动）。纯函数，无服务器。
 * @module @ling2/ling-rdb/tests/upsert.spec
 */
import { describe, expect, it } from 'vitest'
import {
  adaptUpsertText,
  extractUpsertTable,
  hasMysqlBoolLiteral,
  hasMysqlFunctionText,
  hasMysqlUpsertText,
  insertIgnoreSql,
  renderPgUpsertText,
  normalizeMysqlEscapedQuotesToPg,
  stripMysqlFromDualToPg,
  translateMysqlBoolLiteralsToPg,
  translateMysqlFunctionsToPg,
  translateMysqlUpdateJoinToPg,
  upsertSql,
} from '../src/kit/upsert.ts'
import type { RdbDatabase } from '../src/hub/types.ts'

describe('结构化 upsertSql 三态渲染', () => {
  const spec = {
    table: 't_demo',
    columns: [
      { name: 'id', value: '?' },
      { name: 'value', value: '?' },
    ],
    conflictKeys: ['id'],
    updates: [{ column: 'value' }, { column: 'revision', expr: 't_demo.revision + 1' }],
  } as const

  it('mysql 维持 ON DUPLICATE KEY UPDATE 形态', () => {
    expect(upsertSql('mysql', spec)).toBe(
      'INSERT INTO t_demo (id, value)\n'
      + 'VALUES (?, ?)\n'
      + '  AS new_row\n'
      + 'ON DUPLICATE KEY UPDATE\n'
      + '  value    = new_row.value,\n'
      + '  revision = t_demo.revision + 1',
    )
  })


  it('postgresql/kingbase 渲染 ON CONFLICT DO UPDATE 且新行引用为 EXCLUDED', () => {
    expect(upsertSql('postgresql', spec)).toBe(
      'INSERT INTO t_demo (id, value)\n'
      + 'VALUES (?, ?)\n'
      + 'ON CONFLICT (id) DO UPDATE SET\n'
      + '  value = EXCLUDED.value,\n'
      + '  revision = t_demo.revision + 1',
    )
    expect(upsertSql('kingbase', spec)).toBe(upsertSql('postgresql', spec))
  })

  it('oracle/dm 渲染 MERGE INTO 且参数集中在 USING 源行', () => {
    expect(upsertSql('oracle', spec)).toContain('MERGE INTO t_demo')
    expect(upsertSql('oracle', spec)).toContain('USING (SELECT ? AS id, ? AS value FROM dual) new_row')
    expect(upsertSql('dm', spec)).toBe(upsertSql('oracle', spec))
  })

  it('insertIgnoreSql 三态：DO NOTHING / MERGE NOT MATCHED', () => {
    const ignore = { table: 't_one', columns: [{ name: 'id', value: '?' }] as const, conflictKeys: ['id'] as const }
    expect(insertIgnoreSql('mysql', ignore)).toBe('INSERT IGNORE INTO t_one (id) VALUES (?)')
    expect(insertIgnoreSql('postgresql', ignore)).toBe('INSERT INTO t_one (id) VALUES (?)\nON CONFLICT (id) DO NOTHING')
    expect(insertIgnoreSql('oracle', ignore)).toContain('WHEN NOT MATCHED THEN INSERT')
  })
})

describe('hasMysqlUpsertText / extractUpsertTable', () => {
  it('探测 ON DUPLICATE / INSERT IGNORE / 命中与否', () => {
    expect(hasMysqlUpsertText('INSERT INTO t (a) VALUES (1) ON DUPLICATE KEY UPDATE a = VALUES(a)')).toBe(true)
    expect(hasMysqlUpsertText('INSERT IGNORE INTO t (a) VALUES (1)')).toBe(true)
    expect(hasMysqlUpsertText('INSERT INTO t (a) VALUES (1)')).toBe(false)
    expect(hasMysqlUpsertText('CREATE TABLE t (a INT)')).toBe(false)
  })

  it('表名提取支持反引号与 IGNORE 变体', () => {
    expect(extractUpsertTable('INSERT INTO mate_tool (id) VALUES (1) ON DUPLICATE KEY UPDATE id = id')).toBe('mate_tool')
    expect(extractUpsertTable('INSERT IGNORE INTO `base_module` (f_id) VALUES (1)')).toBe('base_module')
  })
})

describe('renderPgUpsertText 文本翻译黄金断言', () => {
  it('种子行单引号字面量 + NOW() + VALUES(col) 全套翻译', () => {
    const mysql = "INSERT INTO mate_tool (id, name, icon, create_time) VALUES (1000000018, 'CronJobTool', '⏰', NOW())\nON DUPLICATE KEY UPDATE name=VALUES(name), icon=VALUES(icon), create_time=NOW()"
    expect(renderPgUpsertText(mysql, ['id'])).toBe(
      "INSERT INTO mate_tool (id, name, icon, create_time) VALUES (1000000018, 'CronJobTool', '⏰', NOW())\n"
      + 'ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, icon=EXCLUDED.icon, create_time=NOW()',
    )
  })

  it("值内 '' 转义引号与含逗号字面量不撕裂切分；右值裸列补表名限定（PG 42702 歧义实证）", () => {
    const mysql = "INSERT INTO t (id, d) VALUES (1, 'it''s, tricky')\nON DUPLICATE KEY UPDATE d = VALUES(d), n = n + 1"
    expect(renderPgUpsertText(mysql, ['id'])).toBe(
      "INSERT INTO t (id, d) VALUES (1, 'it''s, tricky')\n"
      + 'ON CONFLICT (id) DO UPDATE SET d = EXCLUDED.d, n = t.n + 1',
    )
  })

  it('多行赋值尾巴（onboarding 形态）整体翻译', () => {
    const mysql = [
      'INSERT INTO console_onboarding_tour_state (user_id, skipped) VALUES (?, ?)',
      'ON DUPLICATE KEY UPDATE',
      '  skipped = VALUES(skipped),',
      '  updated_at = NOW()',
    ].join('\n')
    expect(renderPgUpsertText(mysql, ['user_id'])).toBe(
      'INSERT INTO console_onboarding_tour_state (user_id, skipped) VALUES (?, ?)\n'
      + 'ON CONFLICT (user_id) DO UPDATE SET skipped = EXCLUDED.skipped, updated_at = NOW()',
    )
  })

  it('INSERT IGNORE 翻译为 ON CONFLICT DO NOTHING', () => {
    expect(renderPgUpsertText('INSERT IGNORE INTO aip_rag_tag_rel (f_document_id, f_tag_id) VALUES (?, ?)', ['f_document_id', 'f_tag_id']))
      .toBe('INSERT INTO aip_rag_tag_rel (f_document_id, f_tag_id) VALUES (?, ?)\nON CONFLICT (f_document_id, f_tag_id) DO NOTHING')
  })

  it('无锚参数化绑参（?）在 INSERT VALUES 内保持原位——绑参序不变', () => {
    const mysql = 'INSERT INTO t (id, a, b) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE a = VALUES(a), b = VALUES(b)'
    expect(renderPgUpsertText(mysql, ['id'])).toBe(
      'INSERT INTO t (id, a, b) VALUES (?, ?, ?)\nON CONFLICT (id) DO UPDATE SET a = EXCLUDED.a, b = EXCLUDED.b',
    )
  })
})

describe('translateMysqlFunctionsToPg 函数族翻译', () => {
  it('IFNULL → COALESCE', () => {
    expect(translateMysqlFunctionsToPg('SELECT IFNULL(a, 0) FROM t')).toBe('SELECT COALESCE(a, 0) FROM t')
  })

  it('INSTR(a, b) → POSITION(b IN a)（实参序翻转）', () => {
    expect(translateMysqlFunctionsToPg("WHERE INSTR(api_key, '*') = 0")).toBe("WHERE POSITION('*' IN api_key) = 0")
  })

  it('DATE_SUB/DATE_ADD 的 INTERVAL 形态', () => {
    expect(translateMysqlFunctionsToPg('WHERE create_time >= DATE_SUB(NOW(), INTERVAL 30 DAY)'))
      .toBe("WHERE create_time >= (NOW() - INTERVAL '30 DAY')")
    expect(translateMysqlFunctionsToPg('DATE_ADD(d, INTERVAL 1 HOUR)')).toBe("(d + INTERVAL '1 HOUR')")
  })

  it('嵌套与多兄弟出现一次收敛', () => {
    expect(translateMysqlFunctionsToPg('SELECT IFNULL(INSTR(a, b), 0), IFNULL(c, 1) FROM t'))
      .toBe("SELECT COALESCE(POSITION(b IN a), 0), COALESCE(c, 1) FROM t")
  })

  it('字面量内同名不误翻', () => {
    expect(translateMysqlFunctionsToPg("SELECT 'IFNULL(a,0)' FROM t")).toBe("SELECT 'IFNULL(a,0)' FROM t")
  })

  it('探测函数：hasMysqlFunctionText', () => {
    expect(hasMysqlFunctionText('SELECT IFNULL(a,0)')).toBe(true)
    expect(hasMysqlFunctionText('SELECT COALESCE(a,0)')).toBe(false)
  })
})

describe('translateMysqlBoolLiteralsToPg 布尔字面量归一', () => {
  it('TRUE/FALSE 归一为 1/0（SET 位与 WHERE 位）', () => {
    expect(translateMysqlBoolLiteralsToPg('UPDATE t SET enabled = TRUE WHERE deleted = FALSE'))
      .toBe('UPDATE t SET enabled = 1 WHERE deleted = 0')
  })

  it("字符串字面量与 -- 注释内的 TRUE 不误翻", () => {
    expect(translateMysqlBoolLiteralsToPg("UPDATE t SET note = 'TRUE story' WHERE flag = TRUE -- TRUE 注释"))
      .toBe("UPDATE t SET note = 'TRUE story' WHERE flag = 1 -- TRUE 注释")
  })

  it('标识符含 true 字样不误翻（词边界）', () => {
    expect(translateMysqlBoolLiteralsToPg('SELECT is_true_flag FROM t')).toBe('SELECT is_true_flag FROM t')
  })

  it('FROM DUAL 剥除（skip-if-exists 播种惯用法→合法 PG）', () => {
    const mysql = "INSERT INTO t (id, k)\nSELECT 1, 'a', NOW()\nFROM DUAL\nWHERE NOT EXISTS (SELECT 1 FROM t WHERE k = 'a')"
    expect(translateMysqlBoolLiteralsToPg(mysql)).toBe(mysql) // 无布尔不动
    expect(stripMysqlFromDualToPg(mysql)).toBe("INSERT INTO t (id, k)\nSELECT 1, 'a', NOW()\n\nWHERE NOT EXISTS (SELECT 1 FROM t WHERE k = 'a')")
  })

  it("字符串字面量内的 \\' 转义归一为 ''（PG 标准串不认反斜杠撇号）", () => {
    expect(normalizeMysqlEscapedQuotesToPg("VALUES ('Anthropic\\'s Claude', 1)"))
      .toBe("VALUES ('Anthropic''s Claude', 1)")
    expect(normalizeMysqlEscapedQuotesToPg("VALUES ('it''s ok')")).toBe("VALUES ('it''s ok')")
  })

  it('UPDATE JOIN → UPDATE FROM（agent 去重种子同款形态，含 UUID() 与 SET 别名剥离）', () => {
    const mysql = [
      'UPDATE mate_agent t',
      'JOIN (',
      '    SELECT workspace_id, name, MIN(id) AS keep_id FROM mate_agent',
      '    GROUP BY workspace_id, name HAVING COUNT(*) > 1',
      ') k',
      '  ON t.workspace_id = k.workspace_id AND t.id <> k.keep_id',
      "SET t.name = CONCAT('__dup__', t.id, '__', UUID());",
    ].join('\n')
    const pg = translateMysqlUpdateJoinToPg(translateMysqlFunctionsToPg(mysql))
    expect(pg).toContain('UPDATE mate_agent t\nSET name =')
    expect(pg).toContain('FROM (')
    expect(pg).toContain('WHERE t.workspace_id = k.workspace_id AND t.id <> k.keep_id')
    expect(pg).toContain('gen_random_uuid()')
    expect(pg).not.toContain('JOIN')
  })

  it('探测函数：hasMysqlBoolLiteral', () => {
    expect(hasMysqlBoolLiteral('INSERT INTO t (a) VALUES (TRUE)')).toBe(true)
    expect(hasMysqlBoolLiteral('INSERT INTO t (a) VALUES (1)')).toBe(false)
  })
})

describe('adaptUpsertText 方言分派', () => {
  const fakeDb = (dialect: RdbDatabase['dialect'], name = 'fake'): RdbDatabase =>
    ({ name, dialect }) as unknown as RdbDatabase

  it('mysql 原样直通（行为零变化）', async () => {
    const sql = 'INSERT INTO t (id) VALUES (1) ON DUPLICATE KEY UPDATE id = id'
    expect(await adaptUpsertText(fakeDb('mysql'), sql)).toBe(sql)
  })

  it('不含 MySQL 专有写法的语句全方言直通', async () => {
    const sql = 'INSERT INTO t (id) VALUES (?)'
    expect(await adaptUpsertText(fakeDb('postgresql'), sql)).toBe(sql)
  })

  it('PG 族显式冲突键翻译', async () => {
    const sql = 'INSERT INTO t_setting (id, k) VALUES (?, ?) ON DUPLICATE KEY UPDATE k = VALUES(k)'
    expect(await adaptUpsertText(fakeDb('postgresql'), sql, ['k'])).toBe(
      'INSERT INTO t_setting (id, k) VALUES (?, ?)\nON CONFLICT (k) DO UPDATE SET k = EXCLUDED.k',
    )
  })

  it('oracle/dm 文本适配 fail loud 并指向结构化入口', async () => {
    const sql = 'INSERT INTO t (id) VALUES (1) ON DUPLICATE KEY UPDATE id = id'
    await expect(adaptUpsertText(fakeDb('oracle'), sql)).rejects.toThrow('结构化 upsertSql')
  })

  it('PG 分支综合：函数族 + upsert 尾巴一次翻译（llm.seed DATE_SUB 同款形态）', async () => {
    const sql = "UPDATE t SET enabled = TRUE WHERE create_time >= DATE_SUB(NOW(), INTERVAL 30 DAY) AND INSTR(k, '*') = 0"
    expect(await adaptUpsertText(fakeDb('postgresql'), sql))
      .toBe("UPDATE t SET enabled = 1 WHERE create_time >= (NOW() - INTERVAL '30 DAY') AND POSITION('*' IN k) = 0")
  })

  it('REPLACE INTO fail loud（语义无文本级等价）', async () => {
    await expect(adaptUpsertText(fakeDb('postgresql'), 'REPLACE INTO t (id) VALUES (1)')).rejects.toThrow('REPLACE INTO')
  })
})
