export interface AozaiCardStatus {
  saved: boolean
  maskedCode?: string
  type?: string
  remaining?: number
}

export type AozaiProgressState = 'submitting' | 'processing' | 'completed' | 'failed'

export interface AozaiProgressEvent {
  requestId: string
  accountId: string
  state: AozaiProgressState
  message: string
}

export interface AozaiProcessResult {
  ok: boolean
  message: string
  remaining?: number
}
