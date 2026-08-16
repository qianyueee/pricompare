import { describe, expect, it } from 'vitest'
import { matchField, normalizeHeader, stripParens } from '@engine/synonyms'

describe('normalizeHeader', () => {
  it('抹平内嵌换行/双空格/nbsp 并转小写半角', () => {
    expect(normalizeHeader('Quote \n(each)')).toBe('quote(each)')
    expect(normalizeHeader('Quote  (EA)')).toBe('quote(ea)')
    expect(normalizeHeader('Lead Time (Calendar Days)')).toBe('leadtime(calendardays)')
    expect(normalizeHeader('Material \n（材料）')).toBe('material(材料)')
    expect(normalizeHeader("Q'ty")).toBe("q'ty")
    expect(normalizeHeader('单价：')).toBe('单价')
  })
  it('stripParens 去括号注释', () => {
    expect(stripParens(normalizeHeader('P/N（零件编号）'))).toBe('p/n')
    expect(stripParens(normalizeHeader('Surface Finish （表面处理）'))).toBe('surfacefinish')
  })
})

describe('matchField', () => {
  it('精确/去括号/模糊三级匹配', () => {
    expect(matchField('P/N')).toEqual({ field: 'pn', confidence: 1 })
    expect(matchField('P/N（零件编号）')).toEqual({ field: 'pn', confidence: 0.8 })
    expect(matchField('Quote \n(each)')).toEqual({ field: 'price', confidence: 1 })
    expect(matchField('Quote Each RMB')).toEqual({ field: 'price', confidence: 1 })
    expect(matchField('Lead Time (Calendar Days)')).toEqual({ field: 'leadTime', confidence: 1 })
    expect(matchField('交货周期（天）')).toEqual({ field: 'leadTime', confidence: 0.8 })
    expect(matchField('交期')).toEqual({ field: 'leadTime', confidence: 1 })
    expect(matchField('Cleaning清洗标准')).toEqual({ field: 'cleaningSpec', confidence: 1 })
    expect(matchField('Method（工艺）')).toEqual({ field: 'process', confidence: 0.8 })
    expect(matchField('备注')).toEqual({ field: 'remark', confidence: 1 })
    expect(matchField('Quote #')).toEqual({ field: 'quoteNo', confidence: 1 })
  })
  it('垃圾列与衍生成本列 ignore', () => {
    expect(matchField(' 2').field).toBe('ignore')
    expect(matchField('Column1').field).toBe('ignore')
    expect(matchField('Material Cost').field).toBe('ignore')
    expect(matchField('Shipping+Tariff').field).toBe('ignore')
    expect(matchField('USD').field).toBe('ignore')
    expect(matchField('Quote  (EA)').field).toBe('quoteEa')
    expect(matchField('').field).toBe('ignore')
  })
})
