import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ExcelJS from 'exceljs'
import { expect, test } from '@playwright/test'
import { FIXTURE_PNS, makeFileA, makeMasterFile } from '../tests/fixtures/buildFixtures'

const TMP = join(dirname(fileURLToPath(import.meta.url)), '.tmp')
// 注意：容器内 Chromium 对非 ASCII 文件名的 setInputFiles 会静默丢文件，固件名保持 ASCII
const KV_PATH = join(TMP, 'KV202608153_0815.xlsx')
const MASTER_PATH = join(TMP, 'KKMaster.xlsx')

test.beforeAll(async () => {
  mkdirSync(TMP, { recursive: true })
  writeFileSync(KV_PATH, Buffer.from(await makeFileA()))
  writeFileSync(MASTER_PATH, Buffer.from(await makeMasterFile()))
})

test('汇总载入 → 报价按规则并入 → 单元格编辑 → 原格式导出 → 持久化', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  // 打开即汇总大表（空态提示载入）
  await expect(page.getByTestId('master-table')).toBeVisible()
  await expect(page.getByText('拖到窗口任意位置载入历史数据')).toBeVisible()

  // 载入 KK 汇总表 → 确认弹窗 → 2 行数据（预编号空行默认隐藏）
  await page.setInputFiles('[data-testid=file-input]', [MASTER_PATH])
  await expect(page.getByTestId('master-import-dialog')).toBeVisible()
  await page.getByTestId('confirm-master-import').click()
  await expect(page.getByTestId('master-row')).toHaveCount(2)

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
  expect(wb.getWorksheet('NEGO')!.getCell('B1').value).toBe('Basis For Negotiation')

  // 刷新后汇总持久化（含编辑与并入结果）
  await page.reload()
  await expect(page.getByTestId('master-row')).toHaveCount(10)
  await expect(page.locator('[data-cell="0:9"]')).toHaveText('60')
})
