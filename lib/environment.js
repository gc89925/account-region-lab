const ENVIRONMENT_KEYS = new Set(['engine', 'locale', 'timezoneId', 'viewport', 'colorScheme']);
const DEFAULTS = Object.freeze({
  IN: { locale: 'en-IN', timezoneId: 'Asia/Kolkata' },
  NG: { locale: 'en-NG', timezoneId: 'Africa/Lagos' },
});

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${label}必须是配置对象。`);
  }
}

export function normalizeEnvironment(input = {}, country = 'IN') {
  plainObject(input, '浏览器环境');
  if (Object.keys(input).some(key => !ENVIRONMENT_KEYS.has(key))) throw new Error('浏览器环境包含不支持的选项。');
  const defaults = Object.hasOwn(DEFAULTS, country) ? DEFAULTS[country] : { locale: 'en-US', timezoneId: 'UTC' };
  const engine = input.engine === undefined ? 'native' : input.engine;
  if (!['native', 'managed'].includes(engine)) throw new Error('浏览器模式无效。');
  const localeInput = input.locale === undefined ? defaults.locale : input.locale;
  if (typeof localeInput !== 'string' || localeInput.length > 50) throw new Error('语言代码无效。');
  let locale;
  try {
    [locale] = Intl.getCanonicalLocales(localeInput);
    if (!locale || !Intl.DateTimeFormat.supportedLocalesOf([locale]).length) throw new Error();
  } catch { throw new Error('请输入浏览器支持的语言代码，例如 en-IN。'); }
  const timezoneId = input.timezoneId === undefined ? defaults.timezoneId : input.timezoneId;
  if (typeof timezoneId !== 'string' || timezoneId.length > 80 || !/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(timezoneId)) throw new Error('时区无效。');
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezoneId }).format(0); }
  catch { throw new Error('请输入有效的 IANA 时区，例如 Asia/Kolkata。'); }
  const viewportInput = input.viewport === undefined ? {} : input.viewport;
  plainObject(viewportInput, '窗口尺寸');
  if (Object.keys(viewportInput).some(key => !['width', 'height'].includes(key))) throw new Error('窗口尺寸包含不支持的选项。');
  const width = viewportInput.width === undefined ? 1365 : viewportInput.width;
  const height = viewportInput.height === undefined ? 900 : viewportInput.height;
  if (!Number.isInteger(width) || width < 640 || width > 2560
      || !Number.isInteger(height) || height < 480 || height > 1600) {
    throw new Error('窗口宽度应为 640–2560，高度应为 480–1600 的整数。');
  }
  const colorScheme = input.colorScheme === undefined ? 'light' : input.colorScheme;
  if (!['light', 'dark', 'system'].includes(colorScheme)) throw new Error('配色模式无效。');
  return { engine, locale, timezoneId, viewport: { width, height }, colorScheme };
}

export function environmentLockedEqual(a, b) {
  return JSON.stringify(normalizeEnvironment(a)) === JSON.stringify(normalizeEnvironment(b));
}
