export function userFacingErrorMessage(reason: unknown): string {
  const raw = reason instanceof Error ? reason.message : String(reason)
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/u, '')
    .replace(/^Error:\s*/u, '')
    .trim() || '操作失败'
}
