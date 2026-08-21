import { describe, expect, it } from 'vitest'
import { makeMasterFile } from '../fixtures/buildFixtures'
import { cleanAmountString, cleanMasterAmounts, parseMasterWorkbook, readWorkbook, KK_COL } from '@engine/index'

describe('金额清洗', () => {
  it('cleanAmountString：文本金额转数字，备注文字/TDB 返回 null', () => {
    expect(cleanAmountString('￥1,133.40')).toBe(1133.4)
    expect(cleanAmountString('$935.00 ')).toBe(935)
    expect(cleanAmountString('9000')).toBe(9000)
    expect(cleanAmountString(' 1,700.00 ')).toBe(1700)
    expect(cleanAmountString('¥88')).toBe(88)
    expect(cleanAmountString('TDB')).toBeNull()
    expect(cleanAmountString('没有图纸')).toBeNull()
    expect(cleanAmountString('上面有KW4件的价钱')).toBeNull()
    expect(cleanAmountString('/')).toBeNull()
    expect(cleanAmountString('')).toBeNull()
    expect(cleanAmountString('1310498-000')).toBeNull() // 带连字符的零件号不能被误转
  })

  it('cleanMasterAmounts：只动金额/数量列、不改备注列、返回修正数', async () => {
    const master = parseMasterWorkbook(readWorkbook(await makeMasterFile()), 'm.xlsm')!
    expect(master.rows[1]!.cells[9]).toBe('￥100.00') // 固件里的历史文本金额
    const { master: cleaned, changed } = cleanMasterAmounts(master)
    expect(changed).toBe(1)
    expect(cleaned.rows[1]!.cells[9]).toBe(100)
    // 原对象不被修改；其他单元格原样
    expect(master.rows[1]!.cells[9]).toBe('￥100.00')
    expect(cleaned.rows[0]!.cells[KK_COL.leadTime]).toBe('22Days')
    expect(cleaned.rows[0]!.cells[KK_COL.pn]).toBe(master.rows[0]!.cells[KK_COL.pn])
    // 幂等
    expect(cleanMasterAmounts(cleaned).changed).toBe(0)
  })
})
