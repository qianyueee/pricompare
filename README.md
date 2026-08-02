# 询价比价系统（PriCompare）

本地桌面应用：把邮件里收到的**各种格式**的供应商报价 Excel 拖进窗口，自动统一成标准结构，
按零件（P/N）跨供应商比价（价格 + 交期，最低价高亮），一键导出成你们现有的 **KK 汇总模板**格式。
所有数据只在本机处理与存储，不联网、不上传。

## 功能

- **拖放导入**：支持 `.xlsx / .xlsm / .xls`，可一次拖入多份；多工作表文件可切换 sheet
- **智能解析**：自动识别表头行位置（第 1 行 / 第 3 行都能认）、中英双语列名（P/N（零件编号）、交期、Lead Time…）、
  单价所在列（多列候选按数值密度推荐）；供应商归属按文件名/报价单号/询价人自动猜测
- **脏数据清洗**：`￥1,133.40` 文本价、`$935.00`、`TDB/待定`、`#REF!` 错误、宏说明垃圾行、" 2"/"Column1" 垃圾列
- **映射确认**：每份文件弹出预览界面，可人工修正表头行、逐列字段、单价列与币种；
  勾选「记住此格式」后，同格式文件下次拖入**自动映射免确认**
- **比价矩阵**：按 P/N + Rev + 数量档位对齐（支持同一零件按 1/2/5 的阶梯报价），
  最低价绿色高亮、溢价百分比、交期原文并列显示；各家合计与「最优组合」合计
- **KK 格式导出**：33 列（A–AG）逐字节复刻现有模板，HC/SKW 等供应商价格落回传统列位，
  新供应商自动占用空槽，H 列默认取最低价、P 列按汇率折美元、W 列交期按惯例用 "/" 拼接，
  最低价单元格带绿色填充，导出后可直接复制回现有 xlsm

## 日常使用

1. 打开应用 → 把报价 Excel 拖进窗口
2. 在弹出的确认界面核对（或修正）供应商、单价列、字段映射 → 「确认导入」
3. 切到「比价与导出」页查看矩阵，必要时调整美元汇率（默认 6.5）与汇总名称
4. 点「导出 KK 汇总 Excel」选择保存位置

## 开发与打包（Windows）

需要 Node.js ≥ 20（建议 22）。

```bash
npm install          # 首次安装依赖（含 Electron，下载慢可启用 electron-builder.yml 里的镜像注释）
npm run dev          # 开发模式启动桌面应用
npm run dist:win     # 打包 Windows 安装包 → release/询价比价系统-Setup-x.y.z.exe
```

打包建议直接在 Windows 上执行（NSIS 安装包在 Windows 上构建最稳）。

## 无显示器环境验证（CI / 容器）

```bash
npm run typecheck    # TypeScript 检查
npm run test         # vitest 引擎单测（合成固件仿真三种真实报价结构）
npm run e2e          # Playwright 全流程（浏览器模式跑 renderer：导入→映射→比价→导出→模板复用）
npm run verify       # 以上全部
npm run dev:web      # 仅浏览器模式起 renderer（无需 Electron 二进制）
xvfb-run -a npx electron --no-sandbox out/main/index.js --smoke   # Electron 壳冒烟（需先 npm run build）
```

容器内 Playwright 浏览器为预装 chromium（对应 `@playwright/test@1.56.1`，勿随意升级该依赖版本）。

## 数据与安全说明

- 解析、比价、导出全部在本机完成；映射模板 / 供应商别名 / 汇率设置保存在
  Electron `userData/store/*.json`（浏览器模式为 localStorage）
- Excel 解析使用 `xlsx@0.18.5`（npm 上最新的开源版）。该版本存在针对**恶意构造文件**的
  已知 CVE（ReDoS / 原型污染）；本应用仅用于解析你自己邮箱收到的报价文件，风险可控。
  请勿把它当作面向陌生人上传文件的服务使用
- 仓库中的测试固件全部为代码生成的虚构数据；真实报价样本回归位于 `tests/local/`（已 gitignore，不入库）

## 目录结构

```
src/engine/        纯 TS 解析/比价/导出引擎（无 Electron 依赖，可单测）
  workbook.ts        SheetJS 读取封装（行/列上限保护）
  headerDetect.ts    表头行扫描打分
  synonyms.ts        中英字段同义词典 + 归一化
  columnMap.ts       自动列映射
  priceColumn.ts     单价列候选排名
  extractRows.ts     数据行提取与垃圾行剔除
  normalize/         价格与交期清洗
  vendor.ts          供应商注册表与归属猜测
  fingerprint.ts     表头指纹（映射模板记忆）
  compare.ts         比价矩阵
  export/            KK 汇总模板导出（exceljs 带样式）
src/renderer/      React 界面（导入页 / 映射确认弹窗 / 比价页）
src/main|preload/  Electron 壳（窗口、保存对话框、JSON 持久化、中文菜单）
tests/             vitest 单测 + 合成固件生成器
e2e/               Playwright 全流程测试
```
