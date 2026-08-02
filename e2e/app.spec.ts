import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ExcelJS from 'exceljs'
import { expect, test } from '@playwright/test'
import { FILE_A_PRICES, FILE_B_PRICES, FIXTURE_PNS, makeFileA, makeFileB } from '../tests/fixtures/buildFixtures'

const TMP = join(dirname(fileURLToPath(import.meta.url)), '.tmp')
// 注意：容器内 Chromium 对非 ASCII 文件名的 setInputFiles 会静默丢文件，固件名保持 ASCII
const KV_PATH = join(TMP, 'KV202607133_0713.xlsx')
const HC_PATH = join(TMP, 'HCQuote20260711_KT20260711B.xlsx')

test.beforeAll(async () => {
  mkdirSync(TMP, { recursive: true })
  writeFileSync(KV_PATH, Buffer.from(await makeFileA()))
  writeFileSync(HC_PATH, Buffer.from(await makeFileB()))
})

test('导入 → 映射确认 → 比价矩阵 → KK 导出 → 指纹模板复用', async ({ page }) => {
  await page.goto('/')

  // 打开即是比价表格本体：表头骨架 + 空态拖入提示
  await expect(page.getByTestId('matrix')).toBeVisible()
  await expect(page.getByText('把供应商报价 Excel 拖到窗口任意位置')).toBeVisible()

  // 同时导入两份不同格式的报价（真实使用为整窗拖放，E2E 走同一入口的文件选择）
  await page.setInputFiles('[data-testid=file-input]', [KV_PATH, HC_PATH])

  // 第一份（KV 风格）：自动猜出供应商 SKW，直接确认
  const dialog = page.getByTestId('mapping-dialog')
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('vendor-input')).toHaveValue('SKW')
  await expect(dialog.getByText('表头第 1 行')).toBeVisible()
  await page.getByTestId('confirm-mapping').click()

  // 第二份（HC 风格）：表头第 3 行，供应商 HC
  await expect(page.getByTestId('vendor-input')).toHaveValue('HC')
  await expect(dialog.getByText('表头第 3 行')).toBeVisible()
  await page.getByTestId('confirm-mapping').click()
  await expect(dialog).toBeHidden()

  await expect(page.getByTestId('file-chip')).toHaveCount(2)

  // 确认后矩阵直接出现在同一界面：9 行、最低价标记、溢价百分比、纯数字交期补 days
  await expect(page.getByTestId('matrix-row')).toHaveCount(9)
  await expect(page.getByText('+26.0%').first()).toBeVisible() // 56.7 vs 45
  await expect(page.getByText('最低').first()).toBeVisible()
  await expect(page.getByText('22days').first()).toBeVisible()
  await expect(page.getByText('最优组合（每行取最低）')).toBeVisible()

  // 导出并校验 KK 格式内容
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('export-btn').click()
  const download = await downloadPromise
  const outPath = join(TMP, 'exported.xlsx')
  await download.saveAs(outPath)

  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(readFileSync(outPath) as unknown as ArrayBuffer)
  const ws = wb.getWorksheet('KK询价汇总')
  expect(ws).toBeTruthy()
  expect(ws!.getRow(1).getCell(4).value).toBe('P/N')
  expect(ws!.getRow(1).getCell(8).value).toBe('Quote \n(each)')
  expect(ws!.getRow(1).getCell(10).value).toBe('HC')
  expect(ws!.getRow(1).getCell(11).value).toBe('SKW')
  const r2 = ws!.getRow(2)
  expect(r2.getCell(4).value).toBe(FIXTURE_PNS[0])
  expect(r2.getCell(10).value).toBe(FILE_B_PRICES[0])
  expect(r2.getCell(11).value).toBe(FILE_A_PRICES[0])
  expect(r2.getCell(8).value).toBe(Math.min(FILE_A_PRICES[0]!, FILE_B_PRICES[0]!))
  const minFill = r2.getCell(11).fill as ExcelJS.FillPattern
  expect(minFill.fgColor?.argb).toBe('FFC6EFCE')
  expect(r2.getCell(23).value).toBe('22days/3 weeks+cleaning') // HC(J) 在前、SKW(K) 在后，纯数字补单位

  // 刷新后重拖同格式文件：指纹命中，自动映射免确认
  await page.reload()
  await page.setInputFiles('[data-testid=file-input]', [KV_PATH])
  await expect(page.getByTestId('badge-auto')).toBeVisible()
  await expect(page.getByTestId('mapping-dialog')).toBeHidden()
})
