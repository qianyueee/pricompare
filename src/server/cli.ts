// pricompare 命令行入口（打包成 dist-server/cli.mjs）；命令与说明见 cliRun.ts，`node cli.mjs --help` 列出全部命令。
import { runCli } from './cliRun'

process.exitCode = await runCli(process.argv.slice(2))
