import { ipcMain, type BrowserWindow } from 'electron'
import type { TaskPoolService } from '../application/task-pool-service'
import { IPC, type CreateDesktopTaskInput } from '../shared/desktop-api'
import { assertTrustedSender } from './ipc-security'

function createInputOf(value: unknown): CreateDesktopTaskInput {
  if (!value || typeof value !== 'object') throw new Error('任务参数无效')
  const raw = value as Record<string, unknown>
  if (typeof raw.title !== 'string') throw new Error('任务标题无效')
  if (raw.description !== undefined && typeof raw.description !== 'string') throw new Error('任务描述无效')
  if (raw.acceptance !== undefined && typeof raw.acceptance !== 'string') throw new Error('验收标准无效')
  if (raw.priority !== undefined && typeof raw.priority !== 'number') throw new Error('优先级无效')
  if (raw.maxAttempts !== undefined && typeof raw.maxAttempts !== 'number') throw new Error('重试次数无效')
  if (raw.dependsOnTaskIds !== undefined && !Array.isArray(raw.dependsOnTaskIds)) throw new Error('前置任务无效')
  if (raw.requiredCapabilities !== undefined && !Array.isArray(raw.requiredCapabilities)) throw new Error('任务能力无效')
  const dependsOnTaskIds = (raw.dependsOnTaskIds ?? []) as unknown[]
  const requiredCapabilities = (raw.requiredCapabilities ?? []) as unknown[]
  if (dependsOnTaskIds.some((item) => typeof item !== 'string')) throw new Error('前置任务无效')
  if (requiredCapabilities.some((item) => typeof item !== 'string')) throw new Error('任务能力无效')
  return {
    title: raw.title,
    description: raw.description as string | undefined,
    acceptance: raw.acceptance as string | undefined,
    priority: raw.priority as number | undefined,
    maxAttempts: raw.maxAttempts as number | undefined,
    dependsOnTaskIds: dependsOnTaskIds.map(String),
    requiredCapabilities: requiredCapabilities.map(String)
  }
}

function shortString(value: unknown, field: string, maxLength = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${field} 无效`)
  }
  return value.trim()
}

export function registerTaskPoolIpc(
  service: TaskPoolService,
  getWindow: () => BrowserWindow | undefined
): () => void {
  ipcMain.handle(IPC.taskPoolGet, (event) => {
    assertTrustedSender(event, getWindow)
    return service.getSnapshot()
  })
  ipcMain.handle(IPC.taskPoolCreate, (event, input: unknown) => {
    assertTrustedSender(event, getWindow)
    return service.createTask(createInputOf(input))
  })
  ipcMain.handle(IPC.taskPoolCancel, (event, taskId: unknown, reason: unknown) => {
    assertTrustedSender(event, getWindow)
    return service.cancelTask(shortString(taskId, 'taskId', 200), typeof reason === 'string' ? reason : undefined)
  })
  ipcMain.handle(IPC.taskPoolApprove, (event, taskId: unknown) => {
    assertTrustedSender(event, getWindow)
    return service.approveTask(shortString(taskId, 'taskId', 200))
  })
  ipcMain.handle(IPC.taskPoolReject, (event, taskId: unknown, reason: unknown) => {
    assertTrustedSender(event, getWindow)
    return service.rejectTask(
      shortString(taskId, 'taskId', 200),
      shortString(reason, '打回原因', 2_000)
    )
  })

  const unsubscribe = service.subscribe((snapshot) => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IPC.taskPoolSnapshot, snapshot)
  })

  return () => {
    unsubscribe()
    ipcMain.removeHandler(IPC.taskPoolGet)
    ipcMain.removeHandler(IPC.taskPoolCreate)
    ipcMain.removeHandler(IPC.taskPoolCancel)
    ipcMain.removeHandler(IPC.taskPoolApprove)
    ipcMain.removeHandler(IPC.taskPoolReject)
  }
}
