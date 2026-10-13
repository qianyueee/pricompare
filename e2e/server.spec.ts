import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ExcelJS from 'exceljs'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { makeMasterFile } from '../tests/fixtures/buildFixtures'
import { makeQuote } from '../tests/fixtures/rows'

// 网页版由 Mac 上的 pricompare 服务发出（playwright.config.ts 第二个 webServer，临时数据目录）
const SERVER = 'http://127.0.0.1:5180'
const TMP = join(dirname(fileURLToPath(import.meta.url)), '.tmp')
const MASTER_PATH = join(TMP, 'KKMasterServer.xlsx')
const TONY = { 'cf-access-authenticated-user-email': 'tony@example.com', 'cf-ray': 'e2e' }

test.use({ baseURL: SERVER })

test.beforeAll(async () => {
  mkdirSync(TMP, { recursive: true })
  writeFileSync(MASTER_PATH, Buffer.from(await makeMasterFile()))
})

async function serverMaster(request: APIRequestContext) {
  const res = await request.get(`${SERVER}/api/master`)
  return (await res.json()) as { version: number; master: { rows: { cells: (string | number | null)[] }[] } | null }
}

test('网页版连服务：导入、改格存到服务、后台并入实时出现、Tony 只读', async ({ page, browser, request }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  // Zane（本机访问）可以导入汇总表，存到服务上
  await page.setInputFiles('[data-testid=file-input]', [MASTER_PATH])
  await page.getByTestId('confirm-master-import').click()
  await expect(page.getByTestId('master-row')).toHaveCount(2)
  await expect.poll(async () => (await serverMaster(request)).version).toBe(1)
  const file = await (await request.get(`${SERVER}/api/master/file`)).json()
  expect(file.name).toBe('KKMasterServer.xlsx')

  // 改格：本页立即生效，服务上也改了；清掉浏览器存储刷新后仍在（数据在服务上）
  await page.locator('[data-cell="0:10"]').click()
  await page.getByTestId('cell-editor').fill('77')
  await page.getByTestId('cell-editor').press('Enter')
  await expect(page.locator('[data-cell="0:10"]')).toHaveText('77')
  await expect.poll(async () => (await serverMaster(request)).master?.rows[0]?.cells[10]).toBe(77)
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await expect(page.locator('[data-cell="0:10"]')).toHaveText('77')

  // 撤销也经服务
  await page.locator('[data-cell="0:11"]').click()
  await page.getByTestId('cell-editor').fill('12')
  await page.getByTestId('cell-editor').press('Enter')
  await page.getByTestId('undo-btn').click()
  await expect(page.locator('[data-cell="0:11"]')).toHaveText('')
  await expect.poll(async () => (await serverMaster(request)).master?.rows[0]?.cells[11]).toBeNull()

  // Tony 经 Cloudflare 打开：只读，看不到 O、P、Q、S 列
  const tonyCtx = await browser.newContext({ baseURL: SERVER, extraHTTPHeaders: TONY })
  const tony = await tonyCtx.newPage()
  await tony.goto('/')
  await expect(tony.getByTestId('read-only-badge')).toBeVisible()
  await expect(tony.getByTestId('add-files-btn')).toHaveCount(0)
  await expect(tony.getByTestId('master-row')).toHaveCount(2)
  await expect(tony.locator('[data-cell="0:14"]')).toHaveCount(0) // O
  await expect(tony.locator('[data-cell="0:18"]')).toHaveCount(0) // S
  await expect(tony.locator('[data-cell="0:17"]')).toHaveCount(1) // R 材料费照常显示
  await tony.locator('[data-cell="0:10"]').click()
  await expect(tony.getByTestId('cell-editor')).toHaveCount(0)

  // 后台每小时并入（命令行经接口发 merge 操作）：两边页面不刷新就出现新报价
  const { version } = await serverMaster(request)
  const merged = await request.post(`${SERVER}/api/ops`, {
    headers: { 'x-pri-client': '1', 'x-pri-source': 'cli' },
    data: {
      baseVersion: version,
      opId: 'hourly-e2e',
      op: {
        kind: 'merge',
        quotes: [makeQuote('0777777-000', { qty: 4, amount: 321 })],
        options: { batch: '20261013 Hourly', vendorSlot: 11, vendorId: 'cl', vendorDisplay: 'CL' },
      },
    },
  })
  expect(merged.ok()).toBe(true)
  await expect(page.getByTestId('master-row')).toHaveCount(3)
  await expect(tony.getByTestId('master-row')).toHaveCount(3)
  await expect(tony.getByTestId('master-row').first()).toContainText('0777777-000')

  // Zane 改的格，Tony 那边也实时更新
  await page.locator('[data-cell="1:9"]').click()
  await page.getByTestId('cell-editor').fill('95')
  await page.getByTestId('cell-editor').press('Enter')
  await expect(tony.locator('[data-cell="1:9"]')).toHaveText('95')

  // Tony 可以导出：在服务上的原件上打补丁，含刚才的改动和后台并入的报价
  // （容器里的 Chromium 不认中文下载名，这里不查文件名）
  const download = tony.waitForEvent('download')
  await tony.getByTestId('export-master-btn').click()
  const outPath = join(TMP, 'server-export.xlsx')
  await (await download).saveAs(outPath)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(readFileSync(outPath) as unknown as ArrayBuffer)
  const ws = wb.getWorksheet('KK询价汇总')!
  expect(ws.getCell('J3').value).toBe(95)
  expect(ws.getCell('K2').value).toBe(77)
  expect(ws.getCell('D4').value).toBe('0777777-000')
  expect(ws.getCell('L4').value).toBe(321)
  expect(wb.getWorksheet('NEGO')?.getCell('A2').value).toBe('marker')

  // Tony 直接调接口改表也会被拒
  const denied = await tonyCtx.request.post(`${SERVER}/api/ops`, {
    headers: { 'x-pri-client': '1' },
    data: { baseVersion: 0, opId: 'tony', op: { kind: 'deleteRows', rows: [0] } },
  })
  expect(denied.status()).toBe(403)
  await tonyCtx.close()
})
