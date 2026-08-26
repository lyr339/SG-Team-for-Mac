/**
 * Cloudflare Turnstile / 反自动化完整绕过（stealth）。
 *
 * 基于 puppeteer-extra-plugin-stealth 的核心技术，针对 Electron 环境适配。
 * 覆盖检测点：User-Agent、navigator.webdriver、CDP 指纹、插件/语言/平台伪装、
 * 权限查询、屏幕分辨率、时区、WebGL 指纹、Canvas 指纹、音频指纹等。
 */

export interface StealthOptions {
  /** 目标平台（影响 User-Agent、platform、屏幕分辨率等）。 */
  platform?: 'macos' | 'windows' | 'linux'
  /** 语言偏好。 */
  languages?: string[]
  /** 是否启用 Canvas 指纹随机化。 */
  canvasNoise?: boolean
  /** 是否启用 WebGL 指纹随机化。 */
  webglNoise?: boolean
  /** 是否启用音频指纹随机化。 */
  audioNoise?: boolean
  /** 自定义屏幕分辨率。 */
  screen?: { width: number; height: number }
}

const DEFAULT_LANGUAGES = ['zh-CN', 'en-US', 'en']

/**
 * 生成完整的 stealth 注入脚本。
 */
export function buildStealthScript(options: StealthOptions = {}): string {
  const platform = options.platform ?? 'macos'
  const languages = options.languages ?? DEFAULT_LANGUAGES
  const screen = options.screen ?? (platform === 'macos' ? { width: 1920, height: 1080 } : { width: 1920, height: 1080 })

  return `
(() => {
  'use strict';

  // ========== 1. 核心：隐藏 navigator.webdriver ==========
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  } catch (_) {}

  // ========== 2. 语言与平台伪装 ==========
  try {
    Object.defineProperty(navigator, 'languages', { get: () => ${JSON.stringify(languages)} });
    Object.defineProperty(navigator, 'platform', { get: () => '${platform === 'macos' ? 'MacIntel' : platform === 'windows' ? 'Win32' : 'Linux x86_64'}' });
  } catch (_) {}

  // ========== 3. 插件伪装（模拟真实浏览器插件列表） ==========
  try {
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
      ]
    });
  } catch (_) {}

  // ========== 4. 屏幕分辨率与颜色深度 ==========
  try {
    Object.defineProperty(screen, 'width', { get: () => ${screen.width} });
    Object.defineProperty(screen, 'height', { get: () => ${screen.height} });
    Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
    Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
  } catch (_) {}

  // ========== 5. 时区伪装（与 IP 地理位置匹配） ==========
  try {
    Object.defineProperty(Intl, 'DateTimeFormat', {
      get: () => class extends Intl.DateTimeFormat {
        resolvedOptions() {
          return { ...super.resolvedOptions(), timeZone: 'Asia/Shanghai' };
        }
      }
    });
  } catch (_) {}

  // ========== 6. 权限查询伪装 ==========
  try {
    const originalQuery = navigator.permissions.query;
    navigator.permissions.query = (parameters) => {
      if (parameters.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission });
      }
      return originalQuery.call(navigator.permissions, parameters);
    };
  } catch (_) {}

  // ========== 7. Chrome 对象伪装 ==========
  try {
    window.chrome = {
      runtime: {},
      loadTimes: () => ({ commitLoadTime: Date.now() / 1000, finishDocumentLoadTime: Date.now() / 1000, finishLoadTime: Date.now() / 1000, firstPaintAfterLoadTime: 0, firstPaintTime: Date.now() / 1000, navigationType: 'Other', npnNegotiatedProtocol: 'h2', connectionInfo: 'h2', requestTime: Date.now() / 1000, startLoadTime: Date.now() / 1000 }),
      csi: () => ({ onloadT: Date.now(), pageT: Date.now(), startE: Date.now() }),
      app: { isInstalled: false }
    };
  } catch (_) {}

  // ========== 8. Canvas 指纹随机化 ==========
  ${options.canvasNoise !== false ? `
  try {
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    const noise = () => Math.random() * 0.01;

    HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
      const context = this.getContext('2d');
      if (context) {
        const imageData = context.getImageData(0, 0, this.width, this.height);
        for (let i = 0; i < imageData.data.length; i += 4) {
          imageData.data[i] = Math.min(255, imageData.data[i] + noise() * 255);
          imageData.data[i + 1] = Math.min(255, imageData.data[i + 1] + noise() * 255);
          imageData.data[i + 2] = Math.min(255, imageData.data[i + 2] + noise() * 255);
        }
        context.putImageData(imageData, 0, 0);
      }
      return originalToDataURL.call(this, type, quality);
    };

    CanvasRenderingContext2D.prototype.getImageData = function(x, y, w, h) {
      const imageData = originalGetImageData.call(this, x, y, w, h);
      for (let i = 0; i < imageData.data.length; i += 4) {
        imageData.data[i] = Math.min(255, imageData.data[i] + noise() * 255);
        imageData.data[i + 1] = Math.min(255, imageData.data[i + 1] + noise() * 255);
        imageData.data[i + 2] = Math.min(255, imageData.data[i + 2] + noise() * 255);
      }
      return imageData;
    };
  } catch (_) {}
  ` : ''}

  // ========== 9. WebGL 指纹随机化 ==========
  ${options.webglNoise !== false ? `
  try {
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return 'Intel Inc.'; // UNMASKED_VENDOR_WEBGL
      if (parameter === 37446) return 'Intel(R) Iris(TM) Graphics 6100'; // UNMASKED_RENDERER_WEBGL
      return getParameter.call(this, parameter);
    };
  } catch (_) {}
  ` : ''}

  // ========== 10. 音频指纹随机化 ==========
  ${options.audioNoise !== false ? `
  try {
    const originalGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function(channel) {
      const data = originalGetChannelData.call(this, channel);
      for (let i = 0; i < data.length; i += 100) {
        data[i] = data[i] + (Math.random() - 0.5) * 0.0001;
      }
      return data;
    };
  } catch (_) {}
  ` : ''}

  // ========== 11. 隐藏 Electron/CDP 痕迹 ==========
  try {
    delete window.__electron__;
    delete window.__cdp__;
    delete window.__nightmare;
    delete window._phantom;
    delete window.callPhantom;
    delete window._selenium;
    delete window.__webdriver_evaluate;
    delete window.__selenium_evaluate;
    delete window.__webdriver_script_function;
    delete window.__webdriver_script_func;
    delete window.__webdriver_script_fn;
    delete window.__fxdriver_evaluate;
    delete window.__driver_evaluate;
    delete window.__webdriver_unwrapped;
    delete window.__driver_unwrapped;
    delete window.__fxdriver_unwrapped;
  } catch (_) {}

  // ========== 12. 防止 iframe 检测 ==========
  try {
    Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
    Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight });
  } catch (_) {}

  // ========== 13. 电池 API 伪装 ==========
  try {
    Object.defineProperty(navigator, 'getBattery', {
      get: () => () => Promise.resolve({
        charging: true,
        chargingTime: 0,
        dischargingTime: Infinity,
        level: 1,
        addEventListener: () => {},
        removeEventListener: () => {}
      })
    });
  } catch (_) {}

  // ========== 14. 连接状态伪装 ==========
  try {
    Object.defineProperty(navigator, 'connection', {
      get: () => ({
        effectiveType: '4g',
        rtt: 50,
        downlink: 10,
        saveData: false,
        addEventListener: () => {},
        removeEventListener: () => {}
      })
    });
  } catch (_) {}

  // ========== 15. 硬件并发数伪装 ==========
  try {
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  } catch (_) {}

  // ========== 16. 设备内存伪装 ==========
  try {
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
  } catch (_) {}

  return { stealth: true, platform: '${platform}' };
})();
`
}

/**
 * 生成模拟人类行为的脚本（鼠标移动、键盘输入延迟）。
 */
export function buildHumanBehaviorScript(): string {
  return `
(() => {
  'use strict';

  // 模拟真实鼠标移动（贝塞尔曲线）
  window.__humanMouseMove = (fromX, fromY, toX, toY, duration = 300) => {
    const steps = Math.floor(duration / 16);
    const points = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      // 贝塞尔曲线控制点
      const cp1x = fromX + (toX - fromX) * 0.25 + (Math.random() - 0.5) * 50;
      const cp1y = fromY + (toY - fromY) * 0.25 + (Math.random() - 0.5) * 50;
      const cp2x = fromX + (toX - fromX) * 0.75 + (Math.random() - 0.5) * 50;
      const cp2y = fromY + (toY - fromY) * 0.75 + (Math.random() - 0.5) * 50;
      // 三次贝塞尔公式
      const x = Math.pow(1-t, 3) * fromX + 3 * Math.pow(1-t, 2) * t * cp1x + 3 * (1-t) * Math.pow(t, 2) * cp2x + Math.pow(t, 3) * toX;
      const y = Math.pow(1-t, 3) * fromY + 3 * Math.pow(1-t, 2) * t * cp1y + 3 * (1-t) * Math.pow(t, 2) * cp2y + Math.pow(t, 3) * toY;
      points.push({ x, y });
    }
    return points;
  };

  // 模拟真实键盘输入（随机间隔）
  window.__humanTypeDelay = () => 50 + Math.random() * 150;

  // 随机页面滚动（模拟阅读行为）
  window.__humanScroll = () => {
    const maxScroll = document.body.scrollHeight - window.innerHeight;
    const targetScroll = Math.random() * maxScroll;
    window.scrollTo({ top: targetScroll, behavior: 'smooth' });
  };

  return { humanBehavior: true };
})();
`
}

/**
 * 完整的 stealth + 人类行为注入脚本。
 */
export function buildFullStealthScript(options: StealthOptions = {}): string {
  return buildStealthScript(options) + '\n' + buildHumanBehaviorScript()
}
