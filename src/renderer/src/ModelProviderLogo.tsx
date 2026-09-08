import type { ModelProvider } from './model-provider'
const claude = new URL('./assets/model-logos/claude.svg', import.meta.url).href
const openai = new URL('./assets/model-logos/openai.svg', import.meta.url).href
const gemini = new URL('./assets/model-logos/gemini-color.svg', import.meta.url).href
const grok = new URL('./assets/model-logos/grok.svg', import.meta.url).href
const kimi = new URL('./assets/model-logos/kimi.svg', import.meta.url).href
const zai = new URL('./assets/model-logos/zai.svg', import.meta.url).href
const cursor = new URL('./assets/model-logos/cursor.svg', import.meta.url).href

const LOGOS: Partial<Record<ModelProvider, string>> = {
  anthropic: claude, openai, google: gemini, xai: grok, moonshot: kimi, zhipu: zai, cursor
}

/** 装饰性标识；名称与可访问性说明仍由调用方提供。资源随应用打包，无运行时请求。 */
export function ModelProviderLogo({ provider }: { provider: ModelProvider }): React.JSX.Element {
  const source = LOGOS[provider]
  return (
    <span className="model-logo-slot" aria-hidden="true" data-provider={provider}>
      {source ? provider === 'google'
        ? <img className="model-logo" src={source} alt="" />
        : <span className="model-logo model-logo--mask" style={{ maskImage: `url("${source}")` }} />
        : <svg className="model-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            {provider === 'auto'
              ? <path d="M4 7h3c5 0 5 10 10 10h3M4 17h3c5 0 5-10 10-10h3m-3-3 3 3-3 3m0 4 3 3-3 3" />
              : <><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M9 12h6m-3-3v6" /></>}
          </svg>}
    </span>
  )
}
