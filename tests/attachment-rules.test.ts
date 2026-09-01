import { describe, expect, it } from 'vitest'
import {
  attachmentFileRejection,
  MAX_ATTACHMENT_FILE_BYTES,
  planAttachmentIntake
} from '../src/renderer/src/attachment-rules'

const file = (name: string, size: number, type = ''): { name: string; size: number; type: string } => ({ name, size, type })

describe('attachmentFileRejection', () => {
  it('拒绝模型无法解码的图片格式并给出转换指引', () => {
    expect(attachmentFileRejection({ name: 'IMG_4032.heic', size: 1_000_000, type: 'image/heic' }))
      .toMatch(/HEIC 格式，模型无法解码.+导出为 PNG\/JPG/)
    expect(attachmentFileRejection({ name: 'photo.heif', size: 1_000_000, type: '' }))
      .toMatch(/HEIF 格式，模型无法解码/)
    expect(attachmentFileRejection({ name: 'scan.tiff', size: 1_000_000, type: 'image/tiff' }))
      .toMatch(/TIFF 格式，模型无法解码/)
    expect(attachmentFileRejection({ name: 'shot.png', size: 1_000_000, type: 'image/png' }))
      .toBeUndefined()
  })

  it('接受白名单扩展名与图片类型', () => {
    expect(attachmentFileRejection(file('notes.md', 100))).toBeUndefined()
    expect(attachmentFileRejection(file('app.tsx', 100))).toBeUndefined()
    expect(attachmentFileRejection(file('photo', 100, 'image/png'))).toBeUndefined()
    expect(attachmentFileRejection(file('photo.PNG', 100))).toBeUndefined()
  })

  it('拒绝不支持的类型并给出文案', () => {
    expect(attachmentFileRejection(file('setup.exe', 100))).toMatch(/类型不支持/)
    expect(attachmentFileRejection(file('archive.bin', 100))).toMatch(/类型不支持/)
    expect(attachmentFileRejection(file('noextension', 100))).toMatch(/类型不支持/)
  })

  it('拒绝超过单文件上限并引导路径引用', () => {
    const rejection = attachmentFileRejection(file('big.png', MAX_ATTACHMENT_FILE_BYTES + 1, 'image/png'))
    expect(rejection).toMatch(/2.0 MB/)
    expect(rejection).toMatch(/路径/)
    expect(attachmentFileRejection(file('ok.png', MAX_ATTACHMENT_FILE_BYTES, 'image/png'))).toBeUndefined()
  })
})

describe('planAttachmentIntake', () => {
  it('数量上限 8 个：超出部分截断并提示', () => {
    const existing = Array.from({ length: 6 }, () => ({ size: 10 }))
    const selected = Array.from({ length: 5 }, (_, index) => file(`f${index}.md`, 10))
    const plan = planAttachmentIntake(selected, existing)
    expect(plan.accepted).toHaveLength(2)
    expect(plan.rejections.join()).toMatch(/最多 8 个/)
  })

  it('已有 8 个时全部拒绝', () => {
    const existing = Array.from({ length: 8 }, () => ({ size: 10 }))
    const plan = planAttachmentIntake([file('new.md', 10)], existing)
    expect(plan.accepted).toHaveLength(0)
    expect(plan.rejections.join()).toMatch(/最多 8 个/)
  })

  it('合计大小超过 8MB 时整批拒绝', () => {
    // 已有 6.5MB + 新增 1.9MB（单文件未超 2MB）= 8.4MB 触发合计上限
    const existing = [{ size: 6.5 * 1024 * 1024 }]
    const plan = planAttachmentIntake([file('a.png', 1.9 * 1024 * 1024, 'image/png')], existing)
    expect(plan.accepted).toHaveLength(0)
    expect(plan.rejections.join()).toMatch(/合计不能超过 8.0 MB/)
  })

  it('混合场景：合法接受、非法拒绝，互不影响', () => {
    const plan = planAttachmentIntake([
      file('ok.md', 100),
      file('bad.exe', 100),
      file('big.png', MAX_ATTACHMENT_FILE_BYTES + 1, 'image/png')
    ], [])
    expect(plan.accepted.map((item) => item.name)).toEqual(['ok.md'])
    expect(plan.rejections).toHaveLength(2)
  })

  it('空选择直接通过', () => {
    expect(planAttachmentIntake([], [])).toEqual({ accepted: [], rejections: [] })
  })
})
