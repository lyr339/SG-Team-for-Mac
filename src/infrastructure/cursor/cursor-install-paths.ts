import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Cursor 用户数据目录（state.vscdb / settings.json / workspaceStorage 所在）：
 * mac ~/Library/Application Support/Cursor；win %APPDATA%\Cursor；linux $XDG_CONFIG_HOME/Cursor。
 * 读写 Cursor 本机状态的模块统一从这里取根目录，不各自复制一份平台分支。
 */
export function cursorUserDataRoot(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Cursor')
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Cursor')
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Cursor')
}

/**
 * Cursor 安装位置（两平台唯一出处）：
 * - macOS：/Applications/Cursor.app（bundle 在 Contents/Resources/app 下）；
 * - Windows：Inno Setup 提供「仅当前用户」（%LOCALAPPDATA%\Programs\Cursor）与
 *   「所有用户」（%ProgramFiles%\Cursor）两种位置，后者不注册 App Paths。
 * 需要读写 Cursor 自身文件（workbench bundle 补丁、CLI）的模块都从这里取候选，再按存在性挑选。
 */
export function cursorInstallRoots(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === 'darwin') return ['/Applications/Cursor.app']
  if (platform !== 'win32') return []
  const roots: string[] = []
  if (env.LOCALAPPDATA) roots.push(join(env.LOCALAPPDATA, 'Programs', 'Cursor'))
  for (const programFiles of [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']]) {
    if (programFiles) roots.push(join(programFiles, 'Cursor'))
  }
  return [...new Set(roots)]
}

/** workbench 主 bundle（用量 hook 补丁 / 运行时换号 Companion 的锚点所在）。 */
export function cursorWorkbenchBundleCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  const relative = platform === 'darwin'
    ? ['Contents', 'Resources', 'app', 'out', 'vs', 'workbench', 'workbench.desktop.main.js']
    : ['resources', 'app', 'out', 'vs', 'workbench', 'workbench.desktop.main.js']
  return cursorInstallRoots(platform, env).map((root) => join(root, ...relative))
}

/** 本机实际存在的 workbench bundle；找不到返回 undefined，由调用方给出带候选路径的错误。 */
export function locateCursorWorkbenchBundle(exists: (path: string) => boolean = existsSync): string | undefined {
  return cursorWorkbenchBundleCandidates().find((candidate) => exists(candidate))
}
