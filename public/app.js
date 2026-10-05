'use strict';

const $ = (selector) => document.querySelector(selector);
const countryNames = { IN: '印度', NG: '尼日利亚', CN: '中国', US: '美国', GB: '英国', JP: '日本', SG: '新加坡', DE: '德国', CA: '加拿大', AU: '澳大利亚' };
const countryEnglish = { IN: 'INDIA', NG: 'NIGERIA' };
let state = { profiles: [], browser: null, token: '', links: {} };
let editingProfileId = null;
let observingProfileId = null;
let reviewingProfileId = null;
let loadingState = false;
let loadingCatalog = false;
const pending = new Set();
const editedEnvironmentFields = new Set();
const environmentDefaults = {
  IN: { locale: 'en-IN', timezoneId: 'Asia/Kolkata' },
  NG: { locale: 'en-NG', timezoneId: 'Africa/Lagos' }
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function countryName(code) {
  const value = String(code || '').toUpperCase();
  return countryNames[value] || value || '尚未记录';
}

function countryLabel(code) {
  return code ? `${countryName(code)} · ${String(code).toUpperCase()}` : '尚未记录';
}

function timeLabel(value, dateOnly = false) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', dateOnly
    ? { month: '2-digit', day: '2-digit' }
    : { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
  ).format(date);
}

function last(items) {
  return Array.isArray(items) && items.length ? items[items.length - 1] : null;
}

function elapsedDays(profile) {
  if (Number.isFinite(profile.stats?.elapsedDays)) return Math.max(0, profile.stats.elapsedDays);
  return profile.cycleStartedAt ? Math.max(0, (Date.now() - new Date(profile.cycleStartedAt).getTime()) / 86400000) : 0;
}

function nextReview(profile) {
  if (profile.stats?.nextReviewAt) return profile.stats.nextReviewAt;
  return profile.cycleStartedAt ? new Date(new Date(profile.cycleStartedAt).getTime() + 7 * 86400000).toISOString() : null;
}

function checkMatches(profile) {
  const check = last(profile.checks);
  return Boolean(profile.proxy && check?.ok && String(check.country).toUpperCase() === String(profile.country).toUpperCase()
    && (!profile.strictIp || !profile.expectedIp || check.ip === profile.expectedIp));
}

function profileLocked(profile) {
  return Boolean(profile?.locked ?? profile?.launches?.length);
}

function canLaunch(profile) {
  return Boolean(profile.proxy && state.browser && !pending.has(profile.id)
    && (profile.environment?.engine !== 'managed' || state.capabilities?.managed !== false));
}

async function api(path, options = {}) {
  const headers = { ...options.headers };
  if (options.method && options.method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    headers['X-Lab-Token'] = state.token;
  }
  const response = await fetch(path, { cache: 'no-store', ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

function toast(message, type = '') {
  const node = element('div', `toast ${type}`, message);
  $('#toast-region').append(node);
  window.setTimeout(() => node.remove(), type === 'error' ? 9000 : 6000);
}

async function loadState() {
  if (loadingState) return;
  loadingState = true;
  const refresh = $('#refresh');
  refresh.disabled = true;
  try {
    const data = await api('/api/state');
    if (!Array.isArray(data.profiles) || typeof data.token !== 'string') throw new Error('本地服务返回了无法识别的状态。');
    state = data;
    $('#connection-error').hidden = true;
    render();
  } catch (error) {
    $('#connection-error').textContent = `无法读取本地服务：${error.message} 请确认服务仍在运行，然后刷新状态。`;
    $('#connection-error').hidden = false;
    if (!state.token) {
      $('#profile-grid').replaceChildren(element('div', 'empty-state loading-state', '连接恢复后，将在这里显示已保存的环境。'));
      $('#browser-name').textContent = '尚未连接';
    }
    throw error;
  } finally {
    loadingState = false;
    refresh.disabled = false;
  }
}

function render() {
  const profiles = state.profiles;
  $('#stat-profiles').textContent = String(profiles.length).padStart(2, '0');
  $('#stat-configured').textContent = `${profiles.filter((p) => p.proxy).length} 个已配置代理`;
  $('#stat-healthy').textContent = String(profiles.filter(checkMatches).length).padStart(2, '0');
  $('#stat-reviews').textContent = String(profiles.filter((p) => p.cycleStartedAt && elapsedDays(p) >= 7).length).padStart(2, '0');
  $('#browser-name').textContent = state.browser?.name || '未检测到可用浏览器';
  $('#browser-hint').textContent = state.browser ? '每个环境使用独立配置目录' : '安装 Chrome 或 Edge 后重启服务';
  $('#app-version').textContent = state.version ? ` / ${state.version}` : '';
  $('#profile-grid').replaceChildren(...profiles.map(renderProfile));
  if (!profiles.length) $('#profile-grid').append(element('div', 'empty-state loading-state', '还没有环境。点击“新建环境”开始。'));
  renderObservations();
  const faq = $('#faq-link');
  const url = safeResourceLink(state.links?.faq);
  if (url) {
    faq.href = url;
    faq.hidden = false;
  } else {
    faq.hidden = true;
    faq.removeAttribute('href');
  }
}

function safeResourceLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'google.com' || url.hostname.endsWith('.google.com')) ? url.href : null;
  } catch { return null; }
}

function actionButton(label, className, onClick, disabled = false, ariaLabel) {
  const button = element('button', className, label);
  button.type = 'button';
  button.disabled = disabled;
  if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
  button.addEventListener('click', () => onClick(button));
  return button;
}

function renderProfile(profile) {
  const card = element('article', 'profile-card');
  const check = last(profile.checks);
  const observation = last(profile.observations);
  const deviceReview = last(profile.deviceReviews);
  const environment = profile.environment || {};
  const busy = pending.has(profile.id);
  const header = element('div', 'profile-card-header');
  const country = String(profile.country || '').toUpperCase();
  header.append(element('div', `country-tile country-${country.toLowerCase()}`, country));
  const identity = element('div', 'profile-identity');
  const name = element('h3', 'profile-name', profile.label);
  identity.append(name, element('p', 'profile-country', `${countryName(country)} / ${countryEnglish[country] || country} · ${environment.engine === 'managed' ? '受控实验模式' : '原生兼容模式'}`));
  header.append(identity, actionButton('编辑', 'icon-button edit-button', () => openProfileDialog(profile), busy, `编辑${profile.label}`));
  card.append(header);

  const statusRow = element('div', 'profile-status-row');
  let status = '待配置代理';
  let statusClass = '';
  if (profile.proxy) {
    status = '待检查出口';
    if (check?.country) {
      status = checkMatches(profile) ? '出口符合目标' : `出口为${countryName(check.country)}`;
      statusClass = checkMatches(profile) ? 'success' : 'warning';
    } else if (check) {
      status = '网络检查失败';
      statusClass = 'error';
    }
    if (check?.ip && profile.strictIp && profile.expectedIp && check.ip !== profile.expectedIp) {
      status = '出口 IP 已变化';
      statusClass = 'warning';
    }
  }
  statusRow.append(element('span', `status-pill ${statusClass}`, status), actionButton('检查网络 ↗', 'network-check', (button) => checkNetwork(profile, button), busy, `检查${profile.label}的网络出口`));
  card.append(statusRow);
  const facts = element('div', 'profile-facts');
  const network = element('div');
  network.append(element('span', 'fact-label', '最近网络出口'), element('span', 'fact-value', check?.country ? countryLabel(check.country) : '尚未确认'));
  network.append(element('span', 'fact-secondary', check?.country ? `${check.ip || 'IP 未提供'} · ${timeLabel(check.at, true)}` : profile.proxy ? '已配置代理，等待检查' : '配置后即可启动环境'));
  const region = element('div');
  region.append(element('span', 'fact-label', '条款页关联地区'), element('span', 'fact-value', countryLabel(observation?.country)), element('span', 'fact-secondary', observation ? `${timeLabel(observation.at, true)} · 人工观察` : '打开条款页后手动记录'));
  facts.append(network, region);
  card.append(facts);
  const isolation = element('div', 'isolation-meta');
  isolation.append(element('span', '', profile.accountLabel ? `账号代号：${profile.accountLabel}` : '账号代号：未设置'), element('span', profile.session?.active ? 'session-active' : '', environment.engine !== 'managed' ? '原生会话状态需手动确认' : profile.session?.active ? '受控浏览器运行中' : '受控浏览器已关闭'));
  const ipSummary = profile.strictIp === false ? '按国家校验 · 未启用 IP 绑定' : profile.expectedIp ? `固定 IP：${profile.expectedIp}` : '严格 IP 绑定 · 首次出口检查通过并启动浏览器后绑定';
  const checkCount = profile.stats?.checkCount ?? profile.checks?.length ?? 0;
  const ipChanges = profile.stats?.ipChanges;
  isolation.append(element('span', 'isolation-wide', `${ipSummary} · 检查 ${checkCount} 次${Number.isFinite(ipChanges) ? ` · IP 变化 ${ipChanges} 次` : ''}`));
  isolation.append(element('span', 'isolation-wide', `${environment.locale || environmentDefaults[country]?.locale || 'en-US'} · ${environment.timezoneId || environmentDefaults[country]?.timezoneId || 'UTC'}${environment.engine === 'managed' ? ' · 受控模式环境参数' : ' · 时区为诊断目标'}`));
  card.append(isolation);
  if (check && !check.ok && check.error) card.append(element('p', 'network-error', String(check.error)));

  const days = Math.min(7, Math.floor(elapsedDays(profile)));
  const cycleTitle = element('div', 'cycle-title');
  cycleTitle.append(element('span', '', '七天观察周期'), element('strong', '', !profile.cycleStartedAt ? '尚未开始' : days >= 7 ? '可以复查了' : `第 ${days + 1} 天 / 7 天`));
  const track = element('div', 'cycle-track');
  track.setAttribute('role', 'img');
  track.setAttribute('aria-label', profile.cycleStartedAt ? `观察周期已过 ${days} 天，共 7 天` : '观察周期尚未开始');
  for (let i = 0; i < 7; i += 1) track.append(element('span', `cycle-day ${i < days ? 'done' : profile.cycleStartedAt && i === days ? 'current' : ''}`));
  const meta = element('div', 'cycle-meta');
  meta.append(element('span', '', profile.cycleStartedAt ? `开始 ${timeLabel(profile.cycleStartedAt, true)} · 复查 ${timeLabel(nextReview(profile), true)}` : '配置环境后开始记录'));
  meta.append(actionButton(profile.cycleStartedAt ? '开始新周期 ↻' : '开始周期 ↗', 'cycle-reset', (button) => startCycle(profile, button), busy));
  card.append(cycleTitle, track, meta);

  const actions = element('div', 'profile-actions');
  const launchDisabled = !canLaunch(profile);
  const launch = actionButton('打开条款页 ↗', 'button button-primary', (button) => launchTarget(profile, 'terms', button), launchDisabled, `在${profile.label}环境打开Google服务条款页`);
  if (!profile.proxy) launch.title = '请先编辑环境，配置专属代理';
  else if (!state.browser) launch.title = '尚未找到可用的 Chrome 或 Edge';
  actions.append(launch, actionButton('＋ 记录地区', 'button button-outline', () => openObservationDialog(profile), busy));
  const quick = element('div', 'quick-links');
  quick.append(
    actionButton('Gmail ↗', 'quick-link', (button) => launchTarget(profile, 'gmail', button), launchDisabled, `在${profile.label}环境打开Gmail`),
    actionButton('YouTube ↗', 'quick-link', (button) => launchTarget(profile, 'youtube', button), launchDisabled, `在${profile.label}环境打开YouTube`),
    actionButton('官方变更申请 ↗', 'quick-link', (button) => launchTarget(profile, 'appeal', button), launchDisabled, `在${profile.label}环境打开官方国家地区变更申请`)
  );
  card.append(actions, quick);
  const management = element('div', 'management-actions');
  management.append(actionButton('检查 / 退出其他设备', 'button button-small button-outline', () => openDevicesDialog(profile), busy), actionButton('环境诊断 ↗', 'button button-small button-quiet', (button) => launchTarget(profile, 'diagnostics', button), launchDisabled));
  if (environment.engine === 'managed' && profile.session?.active) management.append(actionButton('关闭受控环境', 'button button-small button-quiet', (button) => profileAction(profile, button, 'close', {}, () => toast('受控浏览器已关闭，登录会话仍保留在独立配置中。')), busy));
  card.append(management);
  card.append(element('p', 'device-review-meta', deviceReview
    ? `设备核查 ${timeLabel(deviceReview.at)} · ${deviceReview.otherSessionsSignedOut ? '已确认清理其他会话' : '其他会话待确认'} · ${deviceReview.currentSessionKept ? '已确认保留当前会话' : '当前会话待确认'}${deviceReview.note ? ` · ${deviceReview.note}` : ''}`
    : '尚无设备核查记录 · 外部设备需在 Google 官方页面逐项管理'));
  return card;
}

function renderObservations() {
  const observations = state.profiles.flatMap((profile) => (profile.observations || []).map((item) => ({ ...item, label: profile.label })));
  observations.sort((a, b) => new Date(b.at) - new Date(a.at));
  const rows = observations.map((item) => {
    const row = element('tr');
    const country = element('td');
    country.append(element('span', 'record-country', countryLabel(item.country)));
    row.append(element('td', '', timeLabel(item.at)), element('td', '', item.label), country, element('td', '', item.note || '—'));
    return row;
  });
  $('#observation-rows').replaceChildren(...rows);
  $('#observation-empty').hidden = observations.length !== 0;
  $('#observations .table-scroll').hidden = observations.length === 0;
}

async function profileAction(profile, button, path, body, onSuccess) {
  if (pending.has(profile.id)) return;
  pending.add(profile.id);
  button.disabled = true;
  const original = button.textContent;
  button.textContent = '处理中…';
  try {
    const result = await api(`/api/profiles/${encodeURIComponent(profile.id)}/${path}`, { method: 'POST', body: JSON.stringify(body) });
    pending.delete(profile.id);
    await loadState();
    onSuccess?.(result);
  } catch (error) {
    pending.delete(profile.id);
    await loadState().catch(() => {});
    toast(error.message, 'error');
  } finally {
    pending.delete(profile.id);
    button.disabled = false;
    button.textContent = original;
  }
}

function checkNetwork(profile, button) {
  return profileAction(profile, button, 'check', {}, () => {
    const current = state.profiles.find((item) => item.id === profile.id);
    const check = last(current?.checks);
    if (check?.ok && current && checkMatches(current)) toast(`${profile.label}：网络出口为${countryName(check.country)}，符合目标。账号地区请另行查看条款页。`);
    else if (check?.ip && current?.strictIp && current.expectedIp && check.ip !== current.expectedIp) toast(`出口 IP 已变为 ${check.ip}，与绑定的 ${current.expectedIp} 不一致，启动将被拦截。`, 'warning');
    else if (check?.country && check.country === current?.country && !check.ok) toast(check.error || '网络检查未通过。', 'error');
    else if (check?.country) toast(`实际出口为${countryName(check.country)}，与目标${countryName(profile.country)}不一致。`, 'warning');
    else toast(check?.error || '网络检查未通过，请检查代理配置。', 'error');
  });
}

function launchTarget(profile, target, button) {
  const names = { gmail: 'Gmail', youtube: 'YouTube', terms: 'Google 服务条款页', appeal: '官方国家/地区变更申请', devices: 'Google 官方设备管理页', diagnostics: '本机环境诊断页（未执行出口国家检查）' };
  return profileAction(profile, button, 'launch', { target }, () => toast(`已请求在“${profile.label}”的独立浏览器环境中打开${names[target]}。`));
}

function startCycle(profile, button) {
  return profileAction(profile, button, 'cycle', {}, () => toast('新的七天观察周期已开始；既有观察记录仍保留。'));
}

function openProfileDialog(profile = null, defaults = {}) {
  editingProfileId = profile?.id || null;
  editedEnvironmentFields.clear();
  $('#profile-form').reset();
  $('#profile-dialog-title').textContent = profile ? '编辑环境' : '新建环境';
  $('#profile-submit').textContent = profile ? '保存环境' : '创建环境';
  $('#profile-label').value = profile?.label || '';
  $('#profile-account').value = profile?.accountLabel || '';
  $('#profile-account').disabled = Boolean(profile?.session?.active);
  $('#profile-country').value = profile?.country || defaults.country || '';
  $('#profile-proxy').value = profile?.proxy || '';
  $('#profile-proxy').placeholder = defaults.fanout ? 'socks5://127.0.0.1:1080' : 'socks5://127.0.0.1:1081';
  $('#profile-strict-ip').checked = profile?.strictIp !== false;
  const environment = profile?.environment || {};
  const localeDefaults = environmentDefaults[$('#profile-country').value] || { locale: 'en-US', timezoneId: 'UTC' };
  $('#environment-engine').value = environment.engine || 'native';
  $('#environment-locale').value = environment.locale || localeDefaults.locale;
  $('#environment-timezone').value = environment.timezoneId || localeDefaults.timezoneId;
  $('#environment-width').value = environment.viewport?.width || 1365;
  $('#environment-height').value = environment.viewport?.height || 900;
  $('#environment-color').value = environment.colorScheme || 'system';
  $('#environment-details').open = false;
  const isBound = profileLocked(profile);
  ['profile-country', 'profile-proxy', 'profile-strict-ip', 'environment-engine', 'environment-locale', 'environment-timezone', 'environment-width', 'environment-height', 'environment-color'].forEach((id) => { document.getElementById(id).disabled = isBound; });
  $('#profile-binding-note').textContent = isBound
    ? `这个环境已启动过浏览器，国家、代理、IP 绑定选项和浏览器设置已固定。${profile?.session?.active ? '关闭受控浏览器后可修改账号代号。' : '仍可修改名称与账号代号。'}需要更换设置时请新建环境。`
    : '首次打开浏览器（包括环境诊断）后，国家、代理与浏览器设置固定。严格 IP 绑定会在首次出口检查通过并启动浏览器后记录出口。';
  updateEngineHelp();
  $('#profile-form-error').hidden = true;
  $('#profile-dialog').showModal();
  $('#profile-label').focus();
}

function updateEngineHelp() {
  $('#environment-engine-help').textContent = $('#environment-engine').value === 'managed'
    ? '受控模式应用语言、时区、视口和外观，可由工作台关闭。使用 Playwright 启动，Google 可能限制此类浏览器登录；请先评估兼容性。'
    : '兼容模式请求浏览器语言和窗口大小；实际效果以诊断页为准。时区仅用于对照，需在操作系统或当地远程电脑配置；外观跟随原生浏览器行为。';
}

function openDevicesDialog(profile) {
  reviewingProfileId = profile.id;
  $('#devices-form').reset();
  $('#devices-context').textContent = `当前环境：${profile.label}${profile.accountLabel ? ` · 账号代号：${profile.accountLabel}` : ''}。以下确认由你填写，工具不会自动读取设备列表。`;
  $('#open-devices').disabled = !canLaunch(profile);
  $('#open-devices').title = profile.proxy ? '' : '请先配置此环境的代理';
  $('#devices-form-error').hidden = true;
  $('#devices-dialog').showModal();
}

function profileFormBody() {
  const body = { label: $('#profile-label').value.trim(), accountLabel: $('#profile-account').value.trim() };
  const profile = state.profiles.find((item) => item.id === editingProfileId);
  if (!profileLocked(profile)) Object.assign(body, {
    country: $('#profile-country').value.trim().toUpperCase(),
    proxy: $('#profile-proxy').value.trim(),
    strictIp: $('#profile-strict-ip').checked,
    environment: {
      engine: $('#environment-engine').value,
      locale: $('#environment-locale').value.trim(),
      timezoneId: $('#environment-timezone').value.trim(),
      viewport: { width: Number($('#environment-width').value), height: Number($('#environment-height').value) },
      colorScheme: $('#environment-color').value
    }
  });
  return body;
}

function renderCatalog(data) {
  const results = $('#catalog-results');
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  const total = Number.isFinite(data.total) ? data.total : nodes.length;
  $('#catalog-status').textContent = `${countryName(data.country)} ${nodes.length} 个 · 全球目录 ${total} 个 · ${data.cached ? '缓存' : '已获取'} ${timeLabel(data.fetchedAt)} · 来源 ${data.source || 'VPN Gate'}`;
  if (!nodes.length) {
    results.replaceChildren(element('div', 'catalog-empty', `${countryName(data.country)}当前 0 个可展示的公共节点。可稍后重试，或配置你已有的当地线路。`));
    return;
  }
  const table = element('table', 'catalog-table');
  const head = element('thead');
  const header = element('tr');
  for (const label of ['节点 / IP', '国家', '延迟 / 速度', '在线 / 会话', '协议 / 住宅属性']) header.append(element('th', '', label));
  head.append(header);
  const body = element('tbody');
  for (const node of nodes) {
    const row = element('tr');
    const address = element('td');
    address.append(element('strong', '', node.hostname || node.id || '未命名节点'), element('span', 'catalog-detail', node.ip || 'IP 未提供'));
    const metric = (value, unit) => Number.isFinite(value) ? `${value} ${unit}` : '未提供';
    row.append(address, element('td', '', countryLabel(node.country)), element('td', '', `${metric(node.latencyMs, 'ms')} / ${metric(node.speedMbps, 'Mbps')}`), element('td', '', `${metric(node.uptimeHours, '小时')} / ${metric(node.sessions, '会话')}`), element('td', '', `${Array.isArray(node.transport) ? node.transport.join(', ') : node.transport || 'VPN / OpenVPN'} · 住宅未验证`));
    body.append(row);
  }
  table.append(head, body);
  const scroll = element('div', 'table-scroll');
  scroll.append(table);
  results.replaceChildren(scroll);
}

async function loadCatalog() {
  if (loadingCatalog) return;
  loadingCatalog = true;
  const button = $('#load-catalog');
  const selectedCountry = $('#catalog-country').value;
  button.disabled = true;
  button.textContent = '读取目录中…';
  $('#catalog-country').disabled = true;
  $('#catalog-error').hidden = true;
  try {
    const data = await api(`/api/catalog?country=${encodeURIComponent(selectedCountry)}`);
    renderCatalog({ ...data, country: data.country || selectedCountry });
  } catch (error) {
    $('#catalog-error').textContent = error.message;
    $('#catalog-error').hidden = false;
  } finally {
    loadingCatalog = false;
    button.disabled = false;
    button.textContent = '加载公共节点';
    $('#catalog-country').disabled = false;
  }
}

function openObservationDialog(profile) {
  observingProfileId = profile.id;
  $('#observation-form').reset();
  $('#observation-context').textContent = `当前环境：${profile.label}。请先在该环境登录 Google，并读取服务条款页。`;
  $('#observation-form-error').hidden = true;
  $('#observation-dialog').showModal();
  $('#observation-country').focus();
}

async function saveForm({ event, form, button, errorElement, dialog, path, method, body, success }) {
  event.preventDefault();
  if (button.disabled || !form.reportValidity()) return;
  const label = button.textContent;
  errorElement.hidden = true;
  button.disabled = true;
  button.textContent = '保存中…';
  try {
    await api(path, { method, body: JSON.stringify(body) });
    dialog.close();
    await loadState();
    toast(success);
  } catch (error) {
    if (dialog.open) {
      errorElement.textContent = error.message;
      errorElement.hidden = false;
    } else toast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

$('#new-profile').addEventListener('click', () => openProfileDialog());
$('#refresh').addEventListener('click', () => loadState().catch(() => {}));
$('#environment-engine').addEventListener('change', updateEngineHelp);
function updateCountryDefaults() {
  if (editingProfileId) return;
  const defaults = environmentDefaults[$('#profile-country').value.toUpperCase()];
  if (defaults) {
    if (!editedEnvironmentFields.has('environment-locale')) $('#environment-locale').value = defaults.locale;
    if (!editedEnvironmentFields.has('environment-timezone')) $('#environment-timezone').value = defaults.timezoneId;
  }
}
$('#profile-country').addEventListener('input', updateCountryDefaults);
$('#profile-country').addEventListener('change', updateCountryDefaults);
for (const id of ['environment-locale', 'environment-timezone']) {
  document.getElementById(id).addEventListener('input', () => editedEnvironmentFields.add(id));
}
$('#load-catalog').addEventListener('click', loadCatalog);
$('#configure-fanout').addEventListener('click', () => openProfileDialog(null, { country: $('#catalog-country').value, fanout: true }));
$('#open-devices').addEventListener('click', (event) => {
  const profile = state.profiles.find((item) => item.id === reviewingProfileId);
  if (profile) launchTarget(profile, 'devices', event.currentTarget);
});
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => document.getElementById(button.dataset.close).close()));
document.querySelectorAll('dialog').forEach((dialog) => {
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
});

$('#profile-form').addEventListener('submit', (event) => saveForm({
  event,
  form: $('#profile-form'),
  button: $('#profile-submit'),
  errorElement: $('#profile-form-error'),
  dialog: $('#profile-dialog'),
  path: editingProfileId ? `/api/profiles/${encodeURIComponent(editingProfileId)}` : '/api/profiles',
  method: editingProfileId ? 'PATCH' : 'POST',
  body: profileFormBody(),
  success: editingProfileId ? '环境配置已保存。' : '新的独立环境已创建。'
}));

$('#devices-form').addEventListener('submit', (event) => saveForm({
  event,
  form: $('#devices-form'),
  button: $('#devices-submit'),
  errorElement: $('#devices-form-error'),
  dialog: $('#devices-dialog'),
  path: `/api/profiles/${encodeURIComponent(reviewingProfileId)}/device-review`,
  method: 'POST',
  body: { otherSessionsSignedOut: $('#devices-signed-out').checked, currentSessionKept: $('#devices-current-kept').checked, note: $('#devices-note').value.trim() },
  success: '人工设备核查记录已保存。'
}));

$('#observation-form').addEventListener('submit', (event) => saveForm({
  event,
  form: $('#observation-form'),
  button: $('#observation-submit'),
  errorElement: $('#observation-form-error'),
  dialog: $('#observation-dialog'),
  path: `/api/profiles/${encodeURIComponent(observingProfileId)}/observations`,
  method: 'POST',
  body: { country: $('#observation-country').value.trim().toUpperCase(), note: $('#observation-note').value.trim() },
  success: '观察记录已保存。'
}));

loadState().catch(() => {});
