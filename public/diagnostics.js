(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const text = value => value === undefined || value === null ? '无法读取 / 浏览器未提供' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  function expectedEnvironment() {
    if (!location.hash) return { value: null, error: null };
    try {
      if (location.hash.length > 4096) throw new Error();
      const parsed = JSON.parse(decodeURIComponent(location.hash.slice(1)));
      const input = parsed.environment || parsed;
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
      const keys = ['engine', 'locale', 'timezoneId', 'viewport', 'colorScheme'];
      if (Object.keys(input).some(key => !keys.includes(key))) throw new Error();
      if (!['native', 'managed'].includes(input.engine) || typeof input.locale !== 'string' || typeof input.timezoneId !== 'string'
          || !input.viewport || !Number.isInteger(input.viewport.width) || !Number.isInteger(input.viewport.height)
          || !['light', 'dark', 'system'].includes(input.colorScheme)) throw new Error();
      return { value: { engine: input.engine, locale: input.locale, timezoneId: input.timezoneId,
        viewport: { width: input.viewport.width, height: input.viewport.height }, colorScheme: input.colorScheme }, error: null };
    } catch { return { value: null, error: '配置参数无效；仍可查看浏览器实测值。' }; }
  }
  function webglDetails() {
    const canvas = document.createElement('canvas');
    let gl;
    try {
      gl = canvas.getContext('webgl');
      if (!gl) return { available: false };
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      return { available: true, vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER),
        unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null };
    } catch { return { available: false }; }
    finally { try { gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* Optional API. */ } }
  }
  function canonicalZone(value) { try { return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone; } catch { return value; } }
  function canonicalLocale(value) { try { return Intl.getCanonicalLocales(value)[0]; } catch { return value; } }
  async function permission(name) { try { return (await navigator.permissions.query({ name })).state; } catch { return 'unavailable'; } }
  let report;
  async function collect() {
    const expected = expectedEnvironment();
    const actual = {
      language: navigator.language, languages: Array.from(navigator.languages || []),
      timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
      userAgent: navigator.userAgent, platform: navigator.platform,
      viewport: { width: innerWidth, height: innerHeight },
      screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth },
      devicePixelRatio, colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      webdriver: typeof navigator.webdriver === 'boolean' ? navigator.webdriver : null,
      hardwareConcurrency: navigator.hardwareConcurrency ?? null, deviceMemoryGiB: navigator.deviceMemory ?? null,
      webgl: webglDetails(),
      permissions: { geolocation: await permission('geolocation'), camera: await permission('camera'), microphone: await permission('microphone') },
    };
    const config = expected.value;
    const comparisons = [
      { key: 'locale', label: '网页语言', expected: config?.locale, actual: actual.language, equal: canonicalLocale(config?.locale) === canonicalLocale(actual.language) },
      { key: 'timezoneId', label: '时区', expected: config?.timezoneId, actual: actual.timezoneId, equal: config && canonicalZone(config.timezoneId) === canonicalZone(actual.timezoneId) },
      { key: 'viewport', label: '内容窗口', expected: config?.viewport, actual: actual.viewport, equal: config && config.viewport.width === actual.viewport.width && config.viewport.height === actual.viewport.height },
      { key: 'colorScheme', label: '配色偏好', expected: config?.colorScheme, actual: actual.colorScheme, equal: config?.colorScheme === actual.colorScheme, observeOnly: config?.colorScheme === 'system' },
    ].map(row => ({ ...row, status: !config || row.observeOnly ? 'observe' : row.equal ? 'pass' : 'mismatch' }));
    report = { schemaVersion: 1, capturedAt: new Date().toISOString(), expected: config, actual,
      comparisons: comparisons.map(({ key, expected: wanted, actual: observed, status }) => ({ key, expected: wanted ?? null, actual: observed, status })),
      limitations: ['No network, STUN, IP or DNS test was performed.', 'WebRTC network policy was not verified.', 'Profile isolation is not full device fingerprint isolation.', 'This report does not verify Google sign-in, device sign-out or account country.'] };
    $('expected-note').textContent = expected.error || (config ? `${config.engine === 'managed' ? '受控浏览器' : '原生浏览器'}配置。原生模式仅向浏览器请求语言和窗口尺寸，不会自动改变系统时区；实际结果以本页诊断为准。` : '未提供预期配置；以下仅展示当前实测信息。');
    $('status').textContent = actual.webdriver === true
      ? '当前浏览器向网页报告 webdriver = true：处于自动化控制模式。此状态未被隐藏。'
      : '当前浏览器未报告 webdriver = true。这个接口不能证明浏览器是否受控制或是否能被识别。';
    $('comparison').replaceChildren(...comparisons.map(row => {
      const tr = document.createElement('tr');
      for (const value of [row.label, row.expected === undefined ? '未设置' : text(row.expected), text(row.actual)]) {
        const td = document.createElement('td'); td.textContent = value; tr.append(td);
      }
      const status = document.createElement('td');
      status.className = row.status === 'pass' ? 'pass' : row.status === 'mismatch' ? 'mismatch' : 'unknown';
      status.textContent = row.status === 'pass' ? '一致' : row.status === 'mismatch' ? '存在差异' : '仅观察'; tr.append(status); return tr;
    }));
    const details = [
      ['语言列表', actual.languages], ['时区', actual.timezoneId], ['User-Agent', actual.userAgent], ['平台', actual.platform],
      ['内容窗口', actual.viewport], ['屏幕', actual.screen], ['设备像素比', actual.devicePixelRatio], ['配色偏好', actual.colorScheme],
      ['webdriver', actual.webdriver], ['逻辑处理器', actual.hardwareConcurrency], ['内存提示 (GiB)', actual.deviceMemoryGiB],
      ['WebGL', actual.webgl], ['本页权限', actual.permissions], ['WebRTC 网络策略', '未进行网络验证'],
    ];
    $('details').replaceChildren(...details.flatMap(([name, value]) => {
      const dt = document.createElement('dt'); const dd = document.createElement('dd');
      dt.textContent = name; dd.textContent = text(value); return [dt, dd];
    }));
    $('download').disabled = false;
  }
  $('download').addEventListener('click', () => {
    if (!report) return;
    const href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = href; link.download = `browser-diagnostics-${report.capturedAt.slice(0, 10)}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  });
  collect().catch(() => { $('status').textContent = '部分浏览器接口不可用，诊断未完成。'; });
})();
