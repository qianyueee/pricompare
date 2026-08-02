/**
 * KK 汇总模板布局常量。表头 33 列（A–AG）从用户真实 KK____.xlsm 的「KK询价汇总」
 * 逐字节复刻：注意 H/X 列内嵌换行、U 列双空格、Y 列全角括号前有空格。
 */
export const KK_SHEET_NAME = 'KK询价汇总'

export const KK_HEADERS: readonly string[] = [
  'No.',
  'Name',
  'Item',
  'P/N',
  'Rev',
  'Description',
  "Q'ty",
  'Quote \n(each)',
  'Mao',
  'HC',
  'SKW',
  'BY',
  'YJ',
  'JM',
  'US Vendor (US$)',
  'USD',
  'Cleaning',
  'Material Cost',
  'Shipping+Tariff',
  'Cost',
  'Quote  (EA)',
  'Quote #',
  'Lead Time',
  'Material \n（材料）',
  'Surface Finish （表面处理）',
  'Cleaning Spec',
  'Process',
  'Size',
  'Type',
  'Comment',
  'Comment 2',
  'Base P/N',
  'Base ID',
]

/** 0 基列号（对应 KK_HEADERS 下标） */
export const KK_COL = {
  no: 0,
  name: 1,
  item: 2,
  pn: 3,
  rev: 4,
  description: 5,
  qty: 6,
  quoteEach: 7,
  vendorSlotStart: 8, // I 列 Mao
  vendorSlotEnd: 13, // N 列 JM
  usVendor: 14, // O 列
  usd: 15, // P 列
  quoteEa: 20, // U 列
  quoteNo: 21, // V 列
  leadTime: 22, // W 列
  material: 23,
  surfaceFinish: 24,
  cleaningSpec: 25,
  process: 26,
  size: 27,
  partType: 28,
  comment: 29,
  comment2: 30,
  basePn: 31,
  baseId: 32,
} as const

/** 模板 I–N 供应商槽位的原表头（未占用的槽保留原文） */
export const KK_VENDOR_SLOT_HEADERS = ['Mao', 'HC', 'SKW', 'BY', 'YJ', 'JM'] as const

export const KK_COL_WIDTHS: readonly number[] = [
  5, 18, 5, 14, 6, 34, 6, 11, 11, 11, 11, 11, 11, 11, 13, 9, 8, 11, 13, 9, 11, 15, 20, 15, 20, 13,
  10, 10, 8, 16, 10, 12, 10,
]

/** 样式常量（argb） */
export const KK_STYLE = {
  headerFill: 'FFD9D9D9',
  minFill: 'FFC6EFCE',
  minFont: 'FF006100',
  pendingFill: 'FFFFEB9C',
  pendingFont: 'FF9C6500',
  borderColor: 'FFBFBFBF',
} as const
