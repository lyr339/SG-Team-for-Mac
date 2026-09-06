import { describe, expect, it } from 'vitest'
import {
  cursorWindowsExecutableCandidates,
  resolveCursorWindowsExecutable,
  runningCursorWindowsExecutable
} from '../src/infrastructure/cursor/cursor-windows-launch'

const env = {
  LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local',
  ProgramFiles: 'C:\\Program Files',
  ProgramW6432: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)'
}

describe('Windows Cursor executable resolution', () => {
  it('lists per-user and all-users install locations once each', () => {
    expect(cursorWindowsExecutableCandidates(env)).toEqual([
      'C:\\Users\\demo\\AppData\\Local\\Programs\\Cursor\\Cursor.exe',
      'C:\\Program Files\\Cursor\\Cursor.exe',
      'C:\\Program Files (x86)\\Cursor\\Cursor.exe'
    ])
  })

  it('trusts the running process path, then the first existing install, then the bare name', () => {
    const programFiles = 'C:\\Program Files\\Cursor\\Cursor.exe'
    expect(resolveCursorWindowsExecutable({ runningPath: 'D:\\Tools\\Cursor\\Cursor.exe', env, exists: () => false }))
      .toBe('D:\\Tools\\Cursor\\Cursor.exe')
    // 全用户安装：LOCALAPPDATA 下没有，Program Files 下有——以前会退回裸名而找不到。
    expect(resolveCursorWindowsExecutable({ env, exists: (path) => path === programFiles })).toBe(programFiles)
    expect(resolveCursorWindowsExecutable({ env, exists: () => false })).toBe('Cursor.exe')
  })

  it('reads the running Cursor path from PowerShell and ignores anything that is not Cursor.exe', async () => {
    const calls: string[] = []
    const exec = (stdout: string) => async (file: string, args: string[]) => {
      calls.push(`${file} ${args.join(' ')}`)
      return { stdout }
    }
    await expect(runningCursorWindowsExecutable(exec('C:\\Program Files\\cursor\\Cursor.exe\r\n'))).resolves.toBe('C:\\Program Files\\cursor\\Cursor.exe')
    expect(calls[0]).toContain('Get-Process -Name Cursor')
    await expect(runningCursorWindowsExecutable(exec(''))).resolves.toBeUndefined()
    await expect(runningCursorWindowsExecutable(exec('C:\\Windows\\explorer.exe'))).resolves.toBeUndefined()
  })

  it('falls back to the System32 PowerShell on ENOENT and gives up on other failures', async () => {
    const attempted: string[] = []
    const enoentThenFound = async (file: string) => {
      attempted.push(file)
      if (file === 'powershell.exe') {
        const error = new Error('spawn powershell.exe ENOENT') as Error & { code?: string }
        error.code = 'ENOENT'
        throw error
      }
      return { stdout: 'C:\\Users\\demo\\AppData\\Local\\Programs\\Cursor\\Cursor.exe' }
    }
    await expect(runningCursorWindowsExecutable(enoentThenFound)).resolves.toBe('C:\\Users\\demo\\AppData\\Local\\Programs\\Cursor\\Cursor.exe')
    expect(attempted).toHaveLength(2)
    expect(attempted[1]).toMatch(/System32[\\/]WindowsPowerShell/)
    const timeout = async () => {
      const error = new Error('spawn ETIMEDOUT') as Error & { code?: string }
      error.code = 'ETIMEDOUT'
      throw error
    }
    await expect(runningCursorWindowsExecutable(timeout)).resolves.toBeUndefined()
  })
})
