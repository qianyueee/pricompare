import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ExcelJS from 'exceljs'
import { expect, test } from '@playwright/test'
import { FILE_A_PRICES, FILE_B_PRICES, FIXTURE_PNS, makeFileA, makeFileB, makeMasterFile } from '../tests/fixtures/buildFixtures'

const TMP = join(dirname(fileURLToPath(import.meta.url)), '.tmp')
// 注意：容器内 Chromium 对非 ASCII 文件名的 setInputFiles 会静默丢文件，固件名保持 ASCII
const KV_PATH = join(TMP, 'KV202608153_0815.xlsx')
const MASTER_PATH = join(TMP, 'KKMaster.xlsx')
const HC_LABELED_PATH = join(TMP, 'HCQuote20260816_TestE.xlsx')

test.beforeAll(async () => {
  mkdirSync(TMP, { recursive: true })
  writeFileSync(KV_PATH, Buffer.from(await makeFileA()))
  writeFileSync(MASTER_PATH, Buffer.from(await makeMasterFile()))
  writeFileSync(HC_LABELED_PATH, Buffer.from(await makeFileB({ quoteNo: '询价 20260816 Test E' })))
})

test('汇总载入 → 报价按规则并入 → 单元格编辑 → 原格式导出 → 持久化', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  // 打开即汇总大表（空态提示载入）
  await expect(page.getByTestId('master-table')).toBeVisible()
  await expect(page.getByText('拖到窗口任意位置载入历史数据')).toBeVisible()

  // 载入 KK 汇总表 → 确认弹窗（含文本金额规范提示）→ 2 行数据（预编号空行默认隐藏）
  await page.setInputFiles('[data-testid=file-input]', [MASTER_PATH])
  await expect(page.getByTestId('master-import-dialog')).toBeVisible()
  await expect(page.getByText('将自动规范 1 个文本格式金额')).toBeVisible()
  await page.getByTestId('confirm-master-import').click()
  await expect(page.getByTestId('master-row')).toHaveCount(2)
  await expect(page.locator('[data-cell="1:9"]')).toHaveText('100') // '￥100.00' 已被规范为数字

  // 拖入 KV 风格报价 → 映射弹窗：供应商猜中 + 合并预览（1 行可填充、8 行新增）
  await page.setInputFiles('[data-testid=file-input]', [KV_PATH])
  const dialog = page.getByTestId('mapping-dialog')
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('vendor-input')).toHaveValue('SKW')
  await expect(page.getByTestId('merge-preview')).toContainText('更新 1 行 · 新增 8 行')
  await page.getByTestId('batch-input').fill('20260816 Test')
  await page.getByTestId('confirm-mapping').click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText('已并入 +8/改1')).toBeVisible()
  await expect(page.getByTestId('master-row')).toHaveCount(10)

  // 显示层最新批次在最上（批次内保持原顺序）；数据/导出仍按原表顺序
  const firstRow = page.getByTestId('master-row').first()
  await expect(firstRow).toContainText('20260816 Test')
  await expect(firstRow).toContainText(FIXTURE_PNS[1]!)

  // 合并结果：K=45、W 按列序拼接、H/U 取自 KV 家（带对客报价）
  await expect(page.locator('[data-cell="0:10"]')).toHaveText('45')
  await expect(page.locator('[data-cell="0:22"]')).toHaveText('22Days/3 weeks+cleaning')
  await expect(page.locator('[data-cell="0:7"]')).toHaveText('45')
  await expect(page.locator('[data-cell="0:20"]')).toHaveText('31')
  // 新增行落在预编号空行（批次写入 B 列）
  await expect(page.locator('[data-cell="2:3"]')).toHaveText(FIXTURE_PNS[1]!)
  await expect(page.locator('[data-cell="2:1"]')).toHaveText('20260816 Test')

  // 单元格编辑：J 列 56.7 → 60
  await page.locator('[data-cell="0:9"]').click()
  await page.getByTestId('cell-editor').fill('60')
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-cell="0:9"]')).toHaveText('60')
  await expect(page.getByText('（有未导出更改）')).toBeVisible()

  // 导出：以原工作簿为底，NEGO 透传、编辑与合并结果写回
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('export-master-btn').click()
  const download = await downloadPromise
  const outPath = join(TMP, 'master-out.xlsx')
  await download.saveAs(outPath)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(readFileSync(outPath) as unknown as ArrayBuffer)
  const ws = wb.getWorksheet('KK询价汇总')!
  expect(ws.getCell('J2').value).toBe(60)
  expect(ws.getCell('K2').value).toBe(45)
  expect(ws.getCell('H2').value).toBe(45)
  expect(ws.getCell('W2').value).toBe('22Days/3 weeks+cleaning')
  expect(ws.getCell('V2').value).toBe('KV202607133')
  expect(ws.getCell('D4').value).toBe(FIXTURE_PNS[1]) // 新增行占用预编号行、A 序号保留
  expect(ws.getCell('A4').value).toBe(3)
  expect(ws.getCell('J3').value).toBe(100) // 清洗后的文本金额以数字写回
  expect(wb.getWorksheet('NEGO')!.getCell('B1').value).toBe('Basis For Negotiation')

  // 刷新后汇总持久化（含编辑与并入结果）
  await page.reload()
  await expect(page.getByTestId('master-row')).toHaveCount(10)
  await expect(page.locator('[data-cell="0:9"]')).toHaveText('60')

  // ---- NEGO 比价面板 ----
  // 点 A 列选中两行（行0：J=60/K=45 qty10；行1：J=100/K=90 qty5）→ Ctrl+B 进入
  await page.locator('[data-cell="0:0"]').click()
  await page.locator('[data-cell="1:0"]').click()
  await expect(page.locator('[data-cell="0:0"]')).toHaveText('✓')
  await expect(page.getByTestId('selected-count')).toHaveText('已选 2 行')
  await page.keyboard.press('Control+b')
  const nego = page.getByTestId('nego-panel')
  await expect(nego).toBeVisible()
  await expect(page.getByTestId('nego-line')).toHaveCount(2)
  // 每行最低单价高亮（两行都是 SKW 低）；各家总额与最优组合
  await expect(nego.locator('[data-min="1"]')).toHaveCount(2)
  await expect(page.getByTestId('nego-sum-9')).toContainText('1100') // HC 60×10+100×5
  await expect(page.getByTestId('nego-sum-10')).toContainText('900') // SKW 45×10+90×5
  await expect(page.getByTestId('nego-sum-optimal')).toHaveText('900')

  // 输入 P/N 回车 → 数量档 chip（10）→ 点击加入一行（SKW 250，HC 缺报）
  await page.getByTestId('nego-pn-input').fill(FIXTURE_PNS[1]!)
  await page.getByTestId('nego-pn-input').press('Enter')
  await expect(page.getByText('数量档：')).toBeVisible()
  await expect(page.getByTestId('nego-tier-chip')).toHaveText('10')
  await page.getByTestId('nego-tier-chip').click()
  await expect(page.getByTestId('nego-line')).toHaveCount(3)
  await expect(page.getByTestId('nego-sum-10')).toContainText('3400') // 900 + 250×10
  await expect(page.getByTestId('nego-sum-9')).toContainText('缺1行') // 新行 HC 无报价
  await expect(page.getByTestId('nego-sum-optimal')).toHaveText('3400')

  // 改下单数量 10 → 20：该行总价翻倍
  await page.getByTestId('nego-qty').nth(2).fill('20')
  await expect(page.getByTestId('nego-sum-optimal')).toHaveText('5900') // 900 + 250×20

  // 复制为表格（剪贴板 TSV）→ toast 提示
  await page.getByTestId('nego-copy-btn').click()
  await expect(page.getByTestId('toast')).toContainText('复制')

  // Esc 关闭
  await page.keyboard.press('Escape')
  await expect(nego).toBeHidden()
})

test('同一批不同供应商报价：第二家自动识别批次并落到同一行', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.setInputFiles('[data-testid=file-input]', [MASTER_PATH])
  await page.getByTestId('confirm-master-import').click()
  await expect(page.getByTestId('master-row')).toHaveCount(2)

  // 同时拖入：HC 风格（Quote No.=「询价 20260816 Test E」）+ KV 风格（只有真单号，无批次信息）
  await page.setInputFiles('[data-testid=file-input]', [HC_LABELED_PATH, KV_PATH])

  // 弹窗 1（HC）：批次自动取自「询价」标签；R2 的 J 已有旧价 → 9 行全新增
  const dialog = page.getByTestId('mapping-dialog')
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('vendor-input')).toHaveValue('HC')
  await expect(page.getByTestId('batch-input')).toHaveValue('20260816 Test E')
  await expect(page.getByTestId('merge-preview')).toContainText('更新 0 行 · 新增 9 行')
  await page.getByTestId('confirm-mapping').click()

  // 弹窗 2（KV）：无自带标签 → 按 (P/N,数量) 与总表匹配，自动识别为同一批
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('vendor-input')).toHaveValue('SKW')
  await expect(page.getByTestId('batch-input')).toHaveValue('20260816 Test E')
  await expect(page.getByTestId('batch-suggestion')).toContainText('已识别为同一批')
  await expect(page.getByTestId('batch-suggestion')).toContainText('9/9')
  await expect(page.getByTestId('merge-preview')).toContainText('更新 9 行 · 新增 0 行')
  await page.getByTestId('confirm-mapping').click()
  await expect(dialog).toBeHidden()

  // 两家价落在同一行（HC 新建的 PN0 行：J=56.7、K=45），批次同名；只多出一个批次
  await expect(page.getByTestId('master-row')).toHaveCount(11)
  await expect(page.locator('[data-cell="2:3"]')).toHaveText(FIXTURE_PNS[0]!)
  await expect(page.locator('[data-cell="2:9"]')).toHaveText(String(FILE_B_PRICES[0]))
  await expect(page.locator('[data-cell="2:10"]')).toHaveText(String(FILE_A_PRICES[0]))
  await expect(page.locator('[data-cell="2:1"]')).toHaveText('20260816 Test E')
  await expect(page.getByTestId('batch-filter').locator('option')).toHaveCount(3) // 全部 + Old + Test E
})
