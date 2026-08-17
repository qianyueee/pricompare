# 询价比价系统（PriCompare）

本地桌面应用：以你们的 **KK 询价汇总表**为中心——打开就是完整历史汇总，把邮件里收到的
供应商报价 Excel（HC / SKW 等各家格式）拖进来**按既有规则自动并入汇总**，随时点格子直接编辑，
一键**按原格式导出**（其他 sheet 如 NEGO 原样保留）。所有数据只在本机处理与存储，不联网、不上传。

## 核心流程

1. **载入汇总**：把 `KK询价汇总表xxxx.xlsm` 拖进窗口 → 确认后成为本地工作底表（持久保存，下次打开即见）
2. **并入报价**：把 HC / KV(SKW) 报价拖进来 → 弹窗确认列映射、供应商、批次（能自动识别的都已填好）
   → 预览「更新 X 行 / 新增 Y 行」→ 确认并入
3. **编辑**：点任意单元格直接改（Enter 保存 / Esc 取消），改动即时保存在本机；
   **Excel 式选区**——A 列选行、表头选列、数据格上按住拖动框选多格（都支持拖选连续多行/多列），
   选中后 `Ctrl+C` 复制成表格、`Delete` 清空内容、「删除行」整行删除（A 列序号自动重排）、
   `Ctrl+Z` 一步撤销
4. **比价（NEGO 页）**：点 A 列选中几行 → `Ctrl+B` 进入独立比价页（参照汇总表 NEGO sheet）——
   编号/数量两格像 Excel 一样**直接输入或整列粘贴**（编号+数量两列一起粘也行）；
   编号填入后数量格灰字提示总表里的有效数量档「1/3/6/9/12」，数量不在档上按阶梯取 ≤数量 的最大档单价；
   各家单价并排、最低价高亮，按**下单数量**算各家总额与最优拆分总额；
   「复制为表格」把结果（含合计行）放进剪贴板，可直接粘贴回 Excel 的 NEGO sheet
5. **导出**：「导出汇总表」→ 以你上传的原工作簿为底，只更新汇总数据区——NEGO 等 sheet、
   列宽样式原样保留，可直接替换你现有的汇总文件

## 并入规则（从真实汇总快照 0812→0814 逐单元格 diff 实证）

- 每条报价行（P/N × 数量档位）自底向上找「同 P/N + 同数量 + 该供应商列还空着」的行填入；
  找不到则**追加**（优先占用底部只有 A 列序号的预编号空行，A 序号保留）
- HC 填 J 列、SKW 填 K 列（其他供应商按注册表槽位，未知供应商在弹窗里选）
- **W 交期**按列序拼接：`18Days/3 weeks+cleaning`（J 在前、K 在后；纯数字自动补 Days）
- **V 报价单号**只收真单号（`KV202608151`）；HC 单里的"询价 20260814 Natalie A"识别为**批次名**写入 B 列
- **H 选定价 / U 对客报价**：来自带 Quote(EA) 列的报价文件（KV 家宏算好的），只填空不覆盖
- 材料/表面处理/清洗/工艺/尺寸：空则填，SKW 的规格值优先；备注冲突时带供应商前缀追加
- 供应商列绿色高亮 = 本行最低价（`￥1,133.40` 这类文本价也参与比较）；TDB/待定 琥珀色

## 其他能力

- 表头行位置浮动（第 1 / 第 3 行）、中英双语列名、`#REF!`、宏说明垃圾行、" 2"/"Column1" 垃圾列都能处理
- **同一批自动识别**：同批询价发给多家时，回单里没批次信息的（如 KV 只有自家单号）
  按**零件号 + 数量集合**与总表已并入行或同时拖入的另一家匹配，批次名自动填成同一批
- 同格式文件确认一次后记住映射，下次拖入自动填好
- 批次筛选、P/N / 描述 / 单号搜索、显示/隐藏预编号空行
- **文本金额自动规范**：汇总表或报价里 `￥1,133.40`、`$935.00 `、`'315'` 这类字符串金额，
  导入时自动转成真正的数字（G 数量与 H–U 金额列；"没有图纸"、TDB 等备注文字原样保留）

## 直接下载安装包（推荐）

仓库配有 GitHub Actions 工作流：每次推送自动在 GitHub 的 Windows 机器上打出 NSIS 安装包。

1. 打开仓库 **Actions** 页 → 最新一次绿色 ✓ 的「打包 Windows 安装包」运行
2. 页面底部 **Artifacts** 下载 `询价比价系统-Setup-win-x64`（zip 内即 Setup.exe）
3. 未做代码签名，首次运行 SmartScreen 提示"未知发布者"→「更多信息 → 仍要运行」

## 开发与打包（Windows）

需要 Node.js ≥ 20（建议 22）。

```bash
npm install          # 首次安装（Electron 下载慢可启用 electron-builder.yml 里的镜像注释）
npm run dev          # 开发模式启动桌面应用
npm run dist:win     # 本机打包 → release/询价比价系统-Setup-x.y.z.exe
```

## 无显示器环境验证（CI / 容器）

```bash
npm run typecheck    # TypeScript 检查
npm run test         # vitest 引擎单测（合成固件仿真真实报价/汇总结构）
npm run e2e          # Playwright 全流程：载汇总→并报价→编辑→导出→持久化
npm run verify       # 以上全部
npm run dev:web      # 仅浏览器模式起 renderer（无需 Electron 二进制）
xvfb-run -a npx electron --no-sandbox out/main/index.js --smoke   # Electron 壳冒烟（需先 npm run build）
```

容器内 Playwright 浏览器为预装 chromium（对应 `@playwright/test@1.56.1`，勿随意升级该依赖）。

## 数据与安全说明

- 汇总数据、映射模板、供应商别名保存在 Electron `userData/store/*.json`（浏览器模式为 localStorage）；
  上传的汇总原文件同样本地留存，作为导出底版
- Excel 解析使用 `xlsx@0.18.5`（npm 最新开源版）。该版本存在针对**恶意构造文件**的已知 CVE
  （ReDoS / 原型污染）；本应用仅解析你自己邮箱收到的报价文件，风险可控，请勿当作公开上传服务使用
- 导出为 .xlsx（原 .xlsm 不含宏时内容等价）；仓库测试固件全为虚构数据，真实样本回归位于
  `tests/local/`（已 gitignore，不入库）

## 目录结构

```
src/engine/            纯 TS 引擎（无 Electron 依赖，可单测）
  workbook.ts            SheetJS 读取封装（行/列上限保护）
  headerDetect.ts        表头行扫描打分
  synonyms.ts            中英字段同义词典 + 归一化
  columnMap.ts           自动列映射
  priceColumn.ts         单价列候选排名（Quote each 一族优先）
  extractRows.ts         数据行提取与垃圾行剔除
  normalize/             价格与交期清洗（22 → 22Days）
  vendor.ts              供应商注册表与归属猜测
  fingerprint.ts         表头指纹（映射模板记忆）
  master/model.ts        汇总表解析（33 列原值 + NEGO 透传 + 预编号空行）
  master/merge.ts        并入规则引擎（fill/append、W 拼接、V 真单号、H/U、规格优先级）
  master/clean.ts        文本金额规范（￥/$/全角逗号/nbsp → 数字，备注文字保留）
  master/nego.ts         NEGO 比价（数量档提取、各家总额与最优组合、TSV 剪贴板）
  master/exportMaster.ts 以原工作簿为底的导出（zip 级补丁优先，公式/批注/样式字节保真）
  compare.ts / export/   （比价矩阵与 KK 导出的引擎实现，供单测与后续复用）
src/renderer/          React 界面（汇总大表 / 并入确认弹窗 / 汇总载入弹窗）
src/main|preload/      Electron 壳（窗口、保存对话框、JSON 持久化、中文菜单）
tests/                 vitest 单测 + 合成固件生成器
e2e/                   Playwright 全流程测试
```
