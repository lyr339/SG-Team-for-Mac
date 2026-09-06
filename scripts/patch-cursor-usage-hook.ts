/**
 * Cursor bundle usage hook 补丁（一次性工具，Cursor 3.6.31 逆向产物）。
 *
 * 背景：turnEnded 流事件携带真实计费 token（inputTokens/outputTokens/
 * cacheReadTokens/cacheWriteTokens，BigInt），但渲染进程两条消费路径都把值丢弃
 * （cloud 路径只写 status；local 路径只存 turnTokenUsage 且不随持久化落盘）。
 * CDP 注入无法触达这些闭包，唯一出路是 bundle 内定点注入——本 Cursor 构建
 * 已有 __QINGTIAN_COMPOSER_SERVICE_HOOK_V2__ 定制先例，版本固定后此法稳定。
 *
 * 双锚点（59MB 全文各唯一，已验证）：
 * 1. local（拾光会话主路径，chatService.submitChatMaybeAbortCurrent 管线）：
 *    AgentResponseAdapter 的 turnEnded case——注入点能拿到 this.composerDataHandle
 *    与事件值 d（4 项 token）。
 * 2. cloud（后台 agent，bcId 路径）：
 *    CloudAgentRepository._startInteractionUpdateConsumer 的 turnEnded 分支——
 *    注入点能拿到 e（composerDataHandle）与 V.message.value。
 *
 * 注入：调用 globalThis.__sgTeamUsage(JSON)（CDP binding，由拾光
 * CursorStreamObserver 注册接收），payload = {c,i,o,r,w,t}。
 *
 * 幂等：已含 __SG_TEAM_USAGE_PATCH__ 标记则跳过；锚点数≠1 立即中止。
 * 安全：先备份 .sg-usage-backup；写 /Applications 需 macOS「App 管理」权限。
 *
 * 用法：npx tsx scripts/patch-cursor-usage-hook.ts [--restore] [--bundle <path>]
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'

// Cursor 默认安装路径（macOS）；如装在别处可用 --bundle 覆盖。
const DEFAULT_BUNDLE = '/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js'
const MARKER = '__SG_TEAM_USAGE_PATCH_V3__'

/** 本地路径锚点：AgentResponseAdapter turnEnded（拾光会话走这条）。 */
const LOCAL_ANCHOR = '(d.inputTokens!==void 0||d.outputTokens!==void 0||d.cacheReadTokens!==void 0||d.cacheWriteTokens!==void 0)&&o.updateComposerDataSetStore(this.composerDataHandle'
/** 云端路径锚点：CloudAgentRepository turnEnded 分支（后台 agent 走这条）。 */
const CLOUD_ANCHOR = 'if(V.message.case==="turnEnded"){await D(),E(),e.setData("status","completed")'

/** 本地注入：composerId 取自 handle.data；d.* 为 BigInt，Number() 收敛。 */
const LOCAL_INJECT = [
  '/* __SG_TEAM_USAGE_PATCH_V3__ */',
  'try{const __sg=globalThis.__sgTeamUsage;',
  '__sg&&__sg(JSON.stringify({c:String((this.composerDataHandle&&this.composerDataHandle.data&&this.composerDataHandle.data.composerId)||""),',
  'g:String(this.generationUUID||this.composerDataHandle?.data?.chatGenerationUUID||this.composerDataHandle?.data?.latestChatGenerationUUID||""),',
  'm:this.composerDataHandle?.data?.modelConfig?.modelName,',
  'i:Number(d.inputTokens||0),o:Number(d.outputTokens||0),',
  'r:Number(d.cacheReadTokens||0),w:Number(d.cacheWriteTokens||0),t:Date.now()}))}catch(__q){}'
].join('')

/** 云端注入：e 为 composerDataHandle。 */
const CLOUD_INJECT = [
  '/* __SG_TEAM_USAGE_PATCH_V3__ */',
  'try{const __sg=globalThis.__sgTeamUsage;',
  '__sg&&e&&e.data&&__sg(JSON.stringify({c:String(e.data.composerId||""),',
  'g:String(e.data.chatGenerationUUID||e.data.latestChatGenerationUUID||""),m:e.data.modelConfig?.modelName,',
  'i:Number(V.message.value.inputTokens||0),',
  'o:Number(V.message.value.outputTokens||0),',
  'r:Number(V.message.value.cacheReadTokens||0),',
  'w:Number(V.message.value.cacheWriteTokens||0),',
  't:Date.now()}))}catch(__q){}'
].join('')

function applyAnchor(source: string, anchor: string, inject: string, label: string): string {
  const hits = source.split(anchor).length - 1
  if (hits !== 1) {
    console.error(`[patch] ${label} 锚点命中 ${hits} 次（预期 1）——Cursor 版本可能已变化，中止`)
    throw new Error(`${label} usage anchor mismatch`)
  }
  return source.replace(anchor, inject + anchor)
}

export function patchUsageSource(source: string): string {
  if (source.includes(MARKER)) {
    if (!source.includes(LOCAL_INJECT) || !source.includes(CLOUD_INJECT)) throw new Error('usage V3 patch incomplete')
    return source
  }
  if (source.includes('__SG_TEAM_USAGE_PATCH__')) {
    const old = /\/\* __SG_TEAM_USAGE_PATCH__ \*\/try\{const __sg=globalThis\.__sgTeamUsage;[\s\S]*?\}catch\(__q\)\{\}/g
    const matches = source.match(old)
    if (matches?.length !== 2) throw new Error('legacy usage patch mismatch')
    source = source.replace(old, '')
  }
  source = applyAnchor(source, LOCAL_ANCHOR, LOCAL_INJECT, 'local')
  return applyAnchor(source, CLOUD_ANCHOR, CLOUD_INJECT, 'cloud')
}

function main(): void {
  const args = process.argv.slice(2)
  const restore = args.includes('--restore')
  const bundleArgIdx = args.indexOf('--bundle')
  const bundleArg = bundleArgIdx >= 0 ? args[bundleArgIdx + 1] : undefined
  const bundlePath = bundleArg ?? DEFAULT_BUNDLE
  const backupPath = `${bundlePath}.sg-usage-backup`

  if (!existsSync(bundlePath)) {
    console.error(`[patch] 未找到 bundle：${bundlePath}`)
    process.exit(1)
  }

  if (restore) {
    if (!existsSync(backupPath)) {
      console.error(`[patch] 无备份可还原：${backupPath}`)
      process.exit(1)
    }
    copyFileSync(backupPath, bundlePath)
    console.log(`[patch] 已还原原始 bundle（${statSync(bundlePath).size}B）`)
    return
  }

  let source = readFileSync(bundlePath, 'utf8')

  source = patchUsageSource(source)
  // 保留首次原始备份；升级补丁不覆盖它。
  if (!existsSync(backupPath)) copyFileSync(bundlePath, backupPath)
  writeFileSync(bundlePath, source, 'utf8')
  console.log(`[patch] 完成：local+cloud 双锚点注入；备份 → ${backupPath}（--restore 可还原）`)
  console.log('[patch] 请完全退出并重启 Cursor 生效')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
