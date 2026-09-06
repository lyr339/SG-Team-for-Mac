/** Cursor 官网受限模型的数据留存政策版本。集中维护，避免通道层散落接口细节。 */
export interface CursorModelDataPolicy {
  modelId: string
  consentVersion: string
}

export const REQUIRED_CURSOR_MODEL_DATA_POLICIES: readonly CursorModelDataPolicy[] = Object.freeze([
  Object.freeze({ modelId: 'claude-fable-5', consentVersion: 'fable-data-retention-v1' })
])

export type CursorModelDataPolicyConsentResult =
  | { kind: 'already_acknowledged'; modelId: string; consentVersion: string }
  | { kind: 'acknowledged'; modelId: string; consentVersion: string }
  | { kind: 'failed'; modelId: string; stage: 'read' | 'write' | 'verify'; status?: number; detail: string }

export type CursorModelDataPolicyConsentSuccess = Exclude<CursorModelDataPolicyConsentResult, { kind: 'failed' }>

interface RawConsentResult {
  kind?: unknown
  modelId?: unknown
  consentVersion?: unknown
  stage?: unknown
  status?: unknown
  detail?: unknown
}

const FETCH_TIMEOUT_MS = 6_000

function compact(value: unknown, limit = 160): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

/**
 * 在已经登录的 cursor.com 页面上下文中执行账户级确认。
 *
 * 顺序固定为：查询 → 缺失才提交 → 再查询验证。接口与载荷来自官网当前页面本身；
 * 相比查找按钮或屏幕坐标，这条链不受文案、布局、缩放和主题变化影响。
 */
export function buildEnsureCursorModelDataPolicyScript(policy: CursorModelDataPolicy): string {
  const encodedPolicy = JSON.stringify(policy)
  return `/* __sgModelDataPolicy */(async()=>{
    const policy=${encodedPolicy};
    const request=async(url,body)=>{
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),${FETCH_TIMEOUT_MS});
      try{
        const response=await fetch(url,{
          method:'POST',
          credentials:'include',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify(body),
          signal:controller.signal
        });
        const text=await response.text();
        let json={};
        try{json=text?JSON.parse(text):{}}catch{}
        return {ok:response.ok,status:response.status,json,text:text.slice(0,160)};
      }catch(error){
        return {ok:false,status:0,json:{},text:error instanceof Error?error.message:String(error)};
      }finally{clearTimeout(timer)}
    };
    const hasConsent=(payload)=>Array.isArray(payload?.consents)&&payload.consents.some(
      entry=>entry?.modelId===policy.modelId&&entry?.consentVersion===policy.consentVersion
    );
    const statusBody={scope:'SCOPE_USER'};
    const current=await request('/api/dashboard/get-no-zdr-model-consent-status',statusBody);
    if(!current.ok)return {kind:'failed',modelId:policy.modelId,stage:'read',status:current.status,detail:current.text};
    if(hasConsent(current.json))return {kind:'already_acknowledged',...policy};
    const written=await request('/api/dashboard/set-user-no-zdr-model-consent',{
      modelId:policy.modelId,
      enabled:true,
      acknowledged:true,
      consentVersion:policy.consentVersion
    });
    if(!written.ok||written.json?.consented!==true){
      return {kind:'failed',modelId:policy.modelId,stage:'write',status:written.status,detail:written.text};
    }
    const verified=await request('/api/dashboard/get-no-zdr-model-consent-status',statusBody);
    if(!verified.ok||!hasConsent(verified.json)){
      return {kind:'failed',modelId:policy.modelId,stage:'verify',status:verified.status,detail:verified.text};
    }
    return {kind:'acknowledged',...policy};
  })()`
}

export function parseCursorModelDataPolicyConsentResult(
  value: unknown,
  policy: CursorModelDataPolicy
): CursorModelDataPolicyConsentResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'failed', modelId: policy.modelId, stage: 'verify', detail: '页面返回格式异常' }
  }
  const raw = value as RawConsentResult
  if (
    (raw.kind === 'already_acknowledged' || raw.kind === 'acknowledged')
    && raw.modelId === policy.modelId
    && raw.consentVersion === policy.consentVersion
  ) {
    return { kind: raw.kind, modelId: policy.modelId, consentVersion: policy.consentVersion }
  }
  const stage = raw.stage === 'read' || raw.stage === 'write' || raw.stage === 'verify' ? raw.stage : 'verify'
  return {
    kind: 'failed',
    modelId: policy.modelId,
    stage,
    ...(typeof raw.status === 'number' && Number.isFinite(raw.status) ? { status: raw.status } : {}),
    detail: compact(raw.detail) || '官网未确认接受状态'
  }
}

export function cursorModelDataPolicyFailureMessage(result: Extract<CursorModelDataPolicyConsentResult, { kind: 'failed' }>): string {
  const stage = result.stage === 'read' ? '查询' : result.stage === 'write' ? '提交' : '复核'
  const status = result.status ? `，HTTP ${result.status}` : ''
  const detail = result.detail ? `：${result.detail}` : ''
  return `模型数据政策${stage}失败（${result.modelId}${status}）${detail}`
}
