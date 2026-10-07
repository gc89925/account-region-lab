import { applyProxyInput } from './proxy-input.js';

const $ = (selector) => document.querySelector(selector);
const countryNames = { IN: '印度', NG: '尼日利亚', CN: '中国', US: '美国', GB: '英国', JP: '日本', KR: '韩国', SG: '新加坡', DE: '德国', CA: '加拿大', AU: '澳大利亚' };
const countryEnglish = { IN: 'INDIA', NG: 'NIGERIA', US: 'UNITED STATES', JP: 'JAPAN', KR: 'SOUTH KOREA' };
let state = { profiles: [], browser: null, token: '', links: {} };
let editingProfileId = null;
let observingProfileId = null;
let reviewingProfileId = null;
let loadingState = null;
let selectedRemoteProfileId = null;
let remoteViewerOpen = false;
let remoteSelectorSignature = '';
const launchingProfiles = new Set();
let loadingCatalog = false;
let catalogData = null;
let scanState = { state: 'idle', running: false };
let scanPollTimer = null;
let scanRequestPending = false;
let diagnosisSequence = 0;
const pending = new Set();
const operationStates = new Map();
const proxyChecks = new Map();
const proxyRows = new Map();
const pendingProxyChecks = new Set();
const directProxyCountries = ['US', 'JP', 'KR'];
const proxyCheckMaxAge = 120000;
const editedEnvironmentFields = new Set();
const environmentDefaults = {
  IN: { locale: 'en-IN', timezoneId: 'Asia/Kolkata' },
  NG: { locale: 'en-NG', timezoneId: 'Africa/Lagos' },
  US: { locale: 'en-US', timezoneId: 'America/New_York' },
  JP: { locale: 'ja-JP', timezoneId: 'Asia/Tokyo' },
  KR: { locale: 'ko-KR', timezoneId: 'Asia/Seoul' }
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

function remoteBrowserEnabled() {
  return state.capabilities?.remoteBrowser === true;
}

function remoteDesktopPath(profile) {
  const value = profile?.session?.desktopUrl;
  if (!remoteBrowserEnabled() || typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null;
  try {
    const url = new URL(value, window.location.origin);
    const match = url.pathname.match(/^\/desktop\/([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})\/([a-f\d]{32})\/vnc\.html$/);
    return profile.session.active && url.origin === window.location.origin && match && match[1] === profile.id
      && !url.username && !url.password && !url.hash
      && [...url.searchParams.keys()].length === 3
      && url.searchParams.get('autoconnect') === 'true' && url.searchParams.get('resize') === 'scale'
      && url.searchParams.get('path') === `desktop/${match[1]}/${match[2]}/websockify`
      ? `${url.pathname}${url.search}` : null;
  } catch { return null; }
}

function remoteCapacity() {
  const configured = state.remoteSessions?.limit ?? state.capabilities?.maxRemoteEnvironments;
  const limit = Number.isInteger(configured) && configured >= 1 && configured <= 5 ? configured : 5;
  const active = state.profiles.filter((profile) => profile.session?.active && !profile.session?.starting).length;
  const starting = state.profiles.filter((profile) => profile.session?.starting || (!profile.session?.active && launchingProfiles.has(profile.id))).length;
  return { limit, active, starting };
}

function closeRemoteDesktop() {
  remoteViewerOpen = false;
  $('#remote-desktop-frame-container').replaceChildren();
  $('#remote-browser').hidden = true;
  $('#open-remote-desktop').setAttribute('aria-expanded', 'false');
}

function renderRemoteDesktop() {
  const available = state.profiles.filter((profile) => remoteDesktopPath(profile));
  const selected = available.find((profile) => profile.id === selectedRemoteProfileId) || available[0];
  selectedRemoteProfileId = selected?.id || null;
  const path = remoteDesktopPath(selected);
  const link = $('#remote-desktop-tab');
  link.hidden = !path;
  if (path) {
    link.href = path;
    link.setAttribute('aria-label', `在独立窗口打开${selected.label}`);
  } else link.removeAttribute('href');
  $('#remote-browser-context').textContent = selected
    ? `当前画面：${selected.label} · ${countryLabel(selected.country)}。邮箱、密码和验证码均在 Google 官方页面输入。`
    : '尚未启动账号环境。请先在环境卡片点击“登录 Google 账号”，再打开对应画面。';
  const signature = JSON.stringify(available.map((profile) => [profile.id, profile.label, profile.country, profile.id === selectedRemoteProfileId]));
  if (signature !== remoteSelectorSignature) {
    remoteSelectorSignature = signature;
    $('#remote-environment-selector').replaceChildren(...available.map((profile) => {
      const selected = profile.id === selectedRemoteProfileId;
      const button = actionButton(`${profile.label} · ${profile.country}`, `remote-environment-button${selected ? ' selected' : ''}`, () => openRemoteDesktop(profile.id), false, `查看${profile.label}的远程画面`);
      button.setAttribute('aria-pressed', String(selected));
      button.setAttribute('aria-controls', 'remote-desktop-frame-container');
      return button;
    }));
  }
  if (!path || !remoteBrowserEnabled()) { closeRemoteDesktop(); return; }
  if (!remoteViewerOpen) return;
  const container = $('#remote-desktop-frame-container');
  const current = container.querySelector('iframe');
  if (!current || current.getAttribute('src') !== path) {
    const frame = element('iframe', 'remote-desktop-frame');
    frame.title = `${selected.label}的远程浏览器`;
    frame.src = path;
    frame.allow = 'clipboard-read; clipboard-write; fullscreen';
    frame.setAttribute('allowfullscreen', '');
    container.replaceChildren(frame);
  } else current.title = `${selected.label}的远程浏览器`;
  $('#remote-browser').hidden = false;
  $('#open-remote-desktop').setAttribute('aria-expanded', 'true');
}

function openRemoteDesktop(profileId = selectedRemoteProfileId) {
  const profile = state.profiles.find((item) => item.id === profileId) || (!profileId && state.profiles.find((item) => remoteDesktopPath(item)));
  if (!remoteDesktopPath(profile)) { toast('此环境的远程画面暂不可用。请先启动环境，或刷新工作台状态后重试。', 'error'); return; }
  selectedRemoteProfileId = profile.id;
  remoteViewerOpen = true;
  renderRemoteDesktop();
  $('#remote-browser').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function renderRuntimeLocation() {
  const remote = remoteBrowserEnabled();
  $('#runtime-location').textContent = remote ? '在服务器运行' : '仅在本机运行';
  $('#browser-location-label').textContent = remote ? '服务器浏览器' : '本机浏览器';
  $('#hero-description').textContent = remote
    ? '为每个账号配置专属代理，再点击“登录 Google 账号”。多个浏览器可在服务器上同时运行；本页切换画面，或分别打开独立窗口操作。'
    : '先配置账号专属代理，再点击环境卡片中的“登录 Google 账号”。登录页会打开在本机独立 Chrome / Edge 窗口，请到任务栏切换。';
  $('#signin-step-location').textContent = remote ? '③ 打开远程浏览器，在画面中登录' : '③ 到本机浏览器窗口登录';
  $('#method-signin-description').textContent = remote
    ? `点击对应环境的“登录 Google 账号”，程序检查出口后启动服务器上的独立浏览器，最多同时运行 ${remoteCapacity().limit} 个环境。各环境有自己的登录目录、代理和远程画面；使用卡片中的“独立窗口”可并排操作。切换或收起画面不会关闭浏览器；要停止某个环境，请点击它的“关闭浏览器”。实际出口取决于该环境的代理，目标国家设置不会改变 IP。使用“检查 / 退出其他设备”进入 Google 官方页面逐项管理会话。`
    : '点击对应环境的“登录 Google 账号”，程序检查出口后启动本机独立 Chrome / Edge。到任务栏切换到新窗口，自己完成登录，再回到这里打开 Gmail 或 YouTube。使用“检查 / 退出其他设备”进入 Google 官方页面逐项管理会话。';
  $('#runtime-footer').textContent = remote ? '服务器配置 · 人工观察 · 数据可导出' : '本机配置 · 人工观察 · 数据可导出';
  $('#account-storage-hint').textContent = remote ? '可选，保存在此服务器' : '可选，仅保存在本机';
  $('#open-remote-desktop').hidden = !remote;
  $('#remote-logout').hidden = !remote;
  const capacity = remoteCapacity();
  $('#remote-session-summary').hidden = !remote;
  $('#remote-session-summary').textContent = `运行中 ${capacity.active} / ${capacity.limit}${capacity.starting ? ` · 正在启动 ${capacity.starting} 个` : ''}`;
  $('#remote-browser-note').textContent = `最多同时运行 ${capacity.limit} 个环境；每个环境独立连接。切换或收起画面只断开当前画面，浏览器继续运行。点击“独立窗口”可同时操作多个环境，关闭其中一个浏览器不影响其他环境。`;
  renderRemoteDesktop();
}

async function api(path, options = {}) {
  const headers = { ...options.headers };
  if (options.method && options.method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    headers['X-Lab-Token'] = state.token;
  }
  const controller = new AbortController();
  const timeoutMs = path.endsWith('/launch') ? 120000 : path === '/api/proxy/diagnose' ? 100000 : path.endsWith('/check') ? 55000 : 25000;
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, { cache: 'no-store', ...options, headers, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (response.status === 403) throw new Error(`${remoteBrowserEnabled() ? '工作台' : '本地'}服务已重启或页面会话已失效。请点击“刷新状态”后重试。`);
    if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
    return data;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`请求超过 ${timeoutMs / 1000} 秒。代理检查或浏览器启动未及时返回；请检查线路，然后刷新状态确认结果，避免重复启动。`);
    if (error instanceof TypeError) throw new Error(remoteBrowserEnabled() ? '无法连接服务器。请确认网络连接与服务器状态，然后点击“刷新状态”重试。' : '无法连接本地服务。请双击 Start.cmd，等待启动完成后再点击“刷新状态”；无需保留终端窗口。');
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

function operationStatus(profile) {
  return operationStates.get(profile.id) || { type: 'info', message: profile.proxy
    ? remoteBrowserEnabled() ? '下一步：点击“登录 Google 账号”。会先检查出口，再启动服务器浏览器；点击“打开远程浏览器”完成登录。' : '下一步：点击“登录 Google 账号”。会先检查出口，再在本机独立 Chrome / Edge 窗口中打开登录页。'
    : '第一步：配置此账号的代理地址。点击“登录 Google 账号”可进入设置。' };
}

function setOperationStatus(profile, message, type = 'info') {
  operationStates.set(profile.id, { message, type });
  const card = document.getElementById(`profile-${profile.id}`);
  const status = card?.querySelector('.operation-status');
  if (status) { status.textContent = message; status.className = `operation-status ${type}`; }
  if (reviewingProfileId === profile.id && $('#devices-dialog').open) {
    const feedback = $('#devices-launch-status');
    feedback.textContent = message;
    feedback.className = `operation-status ${type}`;
    feedback.hidden = false;
  }
}

function prepareNetworkAction(profile, { browser = false } = {}) {
  if (!profile.proxy) {
    const message = '还未配置代理。请填写此账号的 HTTP / SOCKS5 出口地址并保存，再点击“登录 Google 账号”。';
    setOperationStatus(profile, message, 'warning');
    if ($('#devices-dialog').open) $('#devices-dialog').close();
    openProfileDialog(profile, { message, focusProxy: true });
    return false;
  }
  if (browser && !state.browser) {
    setOperationStatus(profile, remoteBrowserEnabled() ? '服务器浏览器暂不可用，请检查服务状态后刷新工作台。' : '未检测到 Chrome 或 Edge。请安装浏览器，重启 Start.cmd，再点击“刷新状态”。', 'error');
    return false;
  }
  if (browser && remoteBrowserEnabled()) {
    const account = profile.accountLabel?.trim().toLowerCase();
    const duplicate = account && state.profiles.find((item) => item.id !== profile.id && item.accountLabel?.trim().toLowerCase() === account
      && (item.session?.active || item.session?.starting || launchingProfiles.has(item.id)));
    if (duplicate) {
      setOperationStatus(profile, `相同账号代号的“${duplicate.label}”正在运行或启动。请先关闭该环境，避免同一账号重复运行。`, 'warning');
      return false;
    }
    const capacity = remoteCapacity();
    if (!profile.session?.active && !profile.session?.starting && capacity.active + capacity.starting >= capacity.limit) {
      setOperationStatus(profile, `已占用 ${capacity.limit} 个并发环境名额。请先关闭一个浏览器，再启动此环境；已运行的环境仍可继续使用。`, 'warning');
      return false;
    }
  }
  if (browser && profile.environment?.engine === 'managed' && state.capabilities?.managed === false) {
    setOperationStatus(profile, '受控浏览器依赖未安装。请重新运行 Start.cmd 安装依赖，或新建“原生 Chrome / Edge”环境。', 'error');
    return false;
  }
  return true;
}

function toast(message, type = '') {
  const node = element('div', `toast ${type}`, message);
  $('#toast-region').append(node);
  window.setTimeout(() => node.remove(), type === 'error' ? 9000 : 6000);
}

async function loadState({ fresh = false } = {}) {
  if (loadingState) {
    if (!fresh) return loadingState;
    await loadingState.catch(() => {});
    return loadState({ fresh: true });
  }
  const refresh = $('#refresh');
  refresh.disabled = true;
  loadingState = (async () => { try {
    const data = await api('/api/state');
    if (!Array.isArray(data.profiles) || typeof data.token !== 'string') throw new Error('本地服务返回了无法识别的状态。');
    state = data;
    $('#connection-error').hidden = true;
    render();
  } catch (error) {
    $('#connection-error').textContent = `无法读取${remoteBrowserEnabled() ? '工作台' : '本地'}服务：${error.message} 请确认服务仍在运行，然后刷新状态。`;
    $('#connection-error').hidden = false;
    if (!state.token) {
      $('#profile-grid').replaceChildren(element('div', 'empty-state loading-state', '连接恢复后，将在这里显示已保存的环境。'));
      $('#browser-name').textContent = '尚未连接';
    }
    throw error;
  } finally {
    refresh.disabled = false;
  } })();
  try { return await loadingState; }
  finally { loadingState = null; }
}

function render() {
  const profiles = state.profiles;
  renderRuntimeLocation();
  $('#stat-profiles').textContent = String(profiles.length).padStart(2, '0');
  $('#stat-configured').textContent = `${profiles.filter((p) => p.proxy).length} 个已配置代理`;
  $('#stat-healthy').textContent = String(profiles.filter(checkMatches).length).padStart(2, '0');
  $('#stat-reviews').textContent = String(profiles.filter((p) => p.cycleStartedAt && elapsedDays(p) >= 7).length).padStart(2, '0');
  $('#browser-name').textContent = state.browser?.name || '未检测到可用浏览器';
  $('#browser-hint').textContent = state.browser ? remoteBrowserEnabled() ? `独立远程画面 · 最多 ${remoteCapacity().limit} 个环境并发` : '每个环境使用独立配置目录' : remoteBrowserEnabled() ? '检查服务器浏览器服务状态' : '安装 Chrome 或 Edge 后重启服务';
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
  card.id = `profile-${profile.id}`;
  const check = last(profile.checks);
  const observation = last(profile.observations);
  const deviceReview = last(profile.deviceReviews);
  const environment = profile.environment || {};
  const busy = pending.has(profile.id) || Boolean(profile.session?.starting);
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
    if (check?.targetReachable === false) { status = 'Google 页面不可达'; statusClass = 'error'; }
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
  isolation.append(element('span', '', profile.accountLabel ? `账号代号：${profile.accountLabel}` : '账号代号：未设置'), element('span', profile.session?.active ? 'session-active' : '', remoteBrowserEnabled() ? profile.session?.active ? '服务器浏览器运行中' : profile.session?.starting || launchingProfiles.has(profile.id) ? '服务器浏览器启动中' : '服务器浏览器已关闭' : environment.engine !== 'managed' ? '原生会话状态需手动确认' : profile.session?.active ? '受控浏览器运行中' : '受控浏览器已关闭'));
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
  const launch = actionButton('登录 Google 账号 ↗', 'button button-primary signin-button', (button) => launchTarget(profile, 'signin', button), busy, `在${profile.label}环境登录Google账号`);
  actions.append(launch, actionButton('＋ 记录地区', 'button button-outline', () => openObservationDialog(profile), busy));
  const quick = element('div', 'quick-links');
  quick.append(
    actionButton('Gmail ↗', 'quick-link', (button) => launchTarget(profile, 'gmail', button), busy, `在${profile.label}环境打开Gmail`),
    actionButton('YouTube ↗', 'quick-link', (button) => launchTarget(profile, 'youtube', button), busy, `在${profile.label}环境打开YouTube`),
    actionButton('条款页 / 查看地区 ↗', 'quick-link', (button) => launchTarget(profile, 'terms', button), busy, `在${profile.label}环境打开Google服务条款页`),
    actionButton('官方变更申请 ↗', 'quick-link', (button) => launchTarget(profile, 'appeal', button), busy, `在${profile.label}环境打开官方国家地区变更申请`)
  );
  card.append(actions, quick);
  const operation = operationStatus(profile);
  const feedback = element('p', `operation-status ${operation.type}`, operation.message);
  feedback.setAttribute('role', 'status');
  card.append(feedback);
  const management = element('div', 'management-actions');
  management.append(actionButton('检查 / 退出其他设备', 'button button-small button-outline', () => openDevicesDialog(profile), busy), actionButton('环境诊断 ↗', 'button button-small button-quiet', (button) => launchTarget(profile, 'diagnostics', button), busy));
  if (profileLocked(profile)) management.append(actionButton('复制为新环境', 'button button-small button-quiet', () => openProfileDialog(null, { template: profile }), busy));
  if (remoteBrowserEnabled() && profile.session?.active) {
    management.append(actionButton('打开远程浏览器', 'button button-small button-primary', () => openRemoteDesktop(profile.id), false, `打开${profile.label}的远程浏览器`));
    const path = remoteDesktopPath(profile);
    if (path) {
      const link = element('a', 'button button-small button-outline', '独立窗口 ↗');
      link.href = path; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', `在独立窗口打开${profile.label}`);
      management.append(link);
    }
  }
  if ((environment.engine === 'managed' || remoteBrowserEnabled() && profile.session?.managed) && profile.session?.active) management.append(actionButton(remoteBrowserEnabled() ? '关闭浏览器' : '关闭受控环境', 'button button-small button-quiet', (button) => profileAction(profile, button, 'close', {}, () => setOperationStatus(profile, remoteBrowserEnabled() ? '此环境的服务器浏览器已关闭，登录会话保留在独立配置中。其他环境继续运行。' : '受控浏览器已关闭，登录会话仍保留在独立配置中。', 'success')), busy, `关闭${profile.label}的浏览器`));
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

async function profileAction(profile, button, path, body, onSuccess, progress = '正在处理，请稍候…') {
  if (pending.has(profile.id)) return;
  pending.add(profile.id);
  button.disabled = true;
  const original = button.textContent;
  button.textContent = '处理中…';
  setOperationStatus(profile, progress, 'pending');
  render();
  try {
    const result = await api(`/api/profiles/${encodeURIComponent(profile.id)}/${path}`, { method: 'POST', body: JSON.stringify(body) });
    pending.delete(profile.id);
    await loadState({ fresh: true }).catch(() => {});
    onSuccess?.(result);
  } catch (error) {
    pending.delete(profile.id);
    await loadState({ fresh: true }).catch(() => {});
    setOperationStatus(profile, error.message, 'error');
  } finally {
    pending.delete(profile.id);
    button.disabled = false;
    button.textContent = original;
    render();
  }
}

function checkNetwork(profile, button) {
  if (!prepareNetworkAction(profile)) return;
  return profileAction(profile, button, 'check', {}, (check) => {
    const current = { ...(state.profiles.find((item) => item.id === profile.id) || profile), checks: [check] };
    if (check?.ok && current && checkMatches(current)) setOperationStatus(profile, `出口国家与 Google 登录页连通检查通过：${countryName(check.country)}。下一步点击“登录 Google 账号”。这不代表已登录或线路持续可用。`, 'success');
    else if (check?.ip && current?.strictIp && current.expectedIp && check.ip !== current.expectedIp) setOperationStatus(profile, `出口 IP 已变为 ${check.ip}，与绑定的 ${current.expectedIp} 不一致，启动将被拦截。`, 'warning');
    else if (check?.country && check.country === current?.country && !check.ok) setOperationStatus(profile, check.error || '网络检查未通过。请编辑代理配置后重试。', 'error');
    else if (check?.country) setOperationStatus(profile, `实际出口为${countryName(check.country)}，与目标${countryName(profile.country)}不一致。请检查代理线路后重试。`, 'warning');
    else setOperationStatus(profile, check?.error || '网络检查未通过，请编辑代理配置后重试。', 'error');
  }, '正在检查代理出口、国家与 Google 登录页 HTTPS 连通性…');
}

async function launchTarget(profile, target, button) {
  if (!prepareNetworkAction(profile, { browser: true })) return;
  const remote = remoteBrowserEnabled();
  const names = { signin: 'Google 登录页', gmail: 'Gmail', youtube: 'YouTube', terms: 'Google 服务条款页', appeal: '官方国家/地区变更申请', devices: 'Google 官方设备管理页', diagnostics: `${remote ? '服务器' : '本机'}环境诊断页（未执行出口国家检查）` };
  if (pending.has(profile.id)) return;
  launchingProfiles.add(profile.id);
  try { return await profileAction(profile, button, 'launch', { target }, (result) => {
    setOperationStatus(profile, remote
      ? `已向服务器浏览器发送打开${names[target]}的请求。点击“打开远程浏览器”查看画面并完成操作；尚未确认 Google 登录状态。`
      : result.message || `已发送打开${names[target]}的请求；尚未确认页面加载或登录状态。`, 'success');
    if (remote) {
      if (result.profile?.id === profile.id) {
        state.profiles = state.profiles.map((item) => item.id === profile.id ? result.profile : item);
      }
      if ($('#devices-dialog').open) $('#devices-dialog').close();
      openRemoteDesktop(profile.id);
    }
  }, target === 'diagnostics' ? `正在启动${remote ? '服务器上的' : '本机'}独立浏览器并打开诊断页，最多等待 2 分钟…` : `正在检查代理出口及${names[target]} HTTPS 连通性，通过后${remote ? '在服务器上打开浏览器' : '发送打开请求'}。线路较慢时最多等待 2 分钟…`);
  } finally { launchingProfiles.delete(profile.id); render(); }
}

function startCycle(profile, button) {
  return profileAction(profile, button, 'cycle', {}, () => setOperationStatus(profile, '新的七天观察周期已开始；既有观察记录仍保留。', 'success'));
}

function openProfileDialog(profile = null, defaults = {}) {
  editingProfileId = profile?.id || null;
  const values = profile || defaults.template || {};
  editedEnvironmentFields.clear();
  $('#profile-form').reset();
  $('#profile-proxy').setCustomValidity('');
  $('#proxy-import-status').hidden = true;
  $('#profile-dialog-title').textContent = profile ? '编辑环境' : defaults.template ? '复制为新环境' : '新建环境';
  $('#profile-submit').textContent = profile ? '保存环境' : '创建环境';
  $('#profile-label').value = defaults.template ? `${values.label} · 副本`.slice(0, 80) : values.label || defaults.label || '';
  $('#profile-account').value = values.accountLabel || '';
  $('#profile-account').disabled = Boolean(profile?.session?.active);
  $('#profile-country').value = values.country || defaults.country || 'US';
  $('#profile-proxy').value = values.proxy || defaults.proxy || '';
  $('#profile-proxy').placeholder = defaults.fanout ? 'socks5://127.0.0.1:1080' : 'socks5://用户名:密码@主机:端口';
  $('#proxy-username').value = values.proxyUsername || '';
  $('#proxy-password').value = '';
  $('#proxy-password').placeholder = profile?.proxyAuthConfigured ? '已保存；留空保留原密码' : '代理服务提供的密码';
  $('#clear-proxy-auth-label').hidden = !profile?.proxyAuthConfigured;
  $('#clear-proxy-auth').checked = false;
  $('#proxy-auth-help').textContent = defaults.template && values.proxyAuthConfigured
    ? '代理用户名已复制；请重新填写密码。原环境的密码不会复制到此表单。'
    : profile?.proxyAuthConfigured ? `${remoteBrowserEnabled() ? '凭据保存在服务器上。' : '由当前 Windows 用户加密保存。'}用户名与地址不变时，密码留空保留原密码；不会放入浏览器命令行或导出记录。`
      : `填写代理商提供的凭据，不是 Google 密码。${remoteBrowserEnabled() ? '凭据保存在服务器上，' : '由当前 Windows 用户加密保存，'}不会放入浏览器命令行或导出记录。`;
  resetProxyDiagnosis();
  $('#profile-strict-ip').checked = values.strictIp !== false;
  const environment = values.environment || {};
  const localeDefaults = environmentDefaults[$('#profile-country').value] || { locale: 'en-US', timezoneId: 'UTC' };
  $('#environment-engine').value = remoteBrowserEnabled() ? 'native' : environment.engine || 'native';
  $('#environment-locale').value = environment.locale || localeDefaults.locale;
  $('#environment-timezone').value = environment.timezoneId || localeDefaults.timezoneId;
  $('#environment-width').value = environment.viewport?.width || 1365;
  $('#environment-height').value = environment.viewport?.height || 900;
  $('#environment-color').value = environment.colorScheme || 'system';
  $('#environment-details').open = false;
  const isBound = profileLocked(profile);
  ['profile-country', 'profile-proxy', 'proxy-username', 'proxy-password', 'clear-proxy-auth', 'profile-strict-ip', 'environment-engine', 'environment-locale', 'environment-timezone', 'environment-width', 'environment-height', 'environment-color'].forEach((id) => { document.getElementById(id).disabled = isBound; });
  if (remoteBrowserEnabled()) $('#environment-engine').disabled = true;
  $('#profile-binding-note').textContent = isBound
    ? `这个环境已启动过浏览器，国家、代理、IP 绑定选项和浏览器设置已固定。${profile?.session?.active ? '关闭浏览器后可修改账号代号。' : '仍可修改名称与账号代号。'}需要更换设置时请新建环境。`
    : '首次打开浏览器（包括环境诊断）后，国家、代理与浏览器设置固定。严格 IP 绑定会在首次出口检查通过并启动浏览器后记录出口。';
  updateEngineHelp();
  $('#profile-form-error').hidden = true;
  $('#profile-next-step').textContent = defaults.message || (defaults.template
    ? '已复制配置供你修改。创建后使用全新的浏览器目录；原环境的登录会话、观察记录和已绑定 IP 不会复制。'
    : remoteBrowserEnabled() ? '保存后回到环境卡片，点击“登录 Google 账号”。程序会检查代理出口并启动服务器浏览器，在远程画面中由你完成登录。' : '保存后回到环境卡片，点击“登录 Google 账号”。程序会检查代理出口并打开独立浏览器，由你完成登录。');
  $('#profile-dialog').showModal();
  (defaults.focusProxy ? $('#profile-proxy') : $('#profile-label')).focus();
}

function updateEngineHelp() {
  $('#environment-engine-help').textContent = $('#environment-engine').value === 'managed'
    ? '受控模式应用语言、时区、视口和外观，可由工作台关闭。使用 Playwright 启动，Google 可能限制此类浏览器登录；请先评估兼容性。'
    : remoteBrowserEnabled() ? '浏览器在服务器上运行，通过远程画面操作，并可由工作台关闭。每个环境保留独立的登录目录；实际语言、时区和窗口效果以环境诊断页为准。' : '兼容模式请求浏览器语言和窗口大小；实际效果以诊断页为准。时区仅用于对照，需在操作系统或当地远程电脑配置；外观跟随原生浏览器行为。';
}

function openDevicesDialog(profile) {
  reviewingProfileId = profile.id;
  $('#devices-form').reset();
  $('#devices-context').textContent = `当前环境：${profile.label}${profile.accountLabel ? ` · 账号代号：${profile.accountLabel}` : ''}。以下确认由你填写，工具不会自动读取设备列表。`;
  $('#open-devices').disabled = pending.has(profile.id);
  $('#open-devices').textContent = profile.proxy ? '在此环境打开官方设备页 ↗' : '先配置代理，再打开设备页 ↗';
  $('#devices-launch-status').hidden = true;
  $('#devices-form-error').hidden = true;
  $('#devices-dialog').showModal();
}

function profileFormBody() {
  const body = { label: $('#profile-label').value.trim(), accountLabel: $('#profile-account').value.trim() };
  const profile = state.profiles.find((item) => item.id === editingProfileId);
  if (!profileLocked(profile)) Object.assign(body, {
    country: $('#profile-country').value.trim().toUpperCase(),
    proxy: $('#profile-proxy').value.trim(),
    proxyUsername: $('#proxy-username').value,
    proxyPassword: $('#proxy-password').value,
    clearProxyAuth: $('#clear-proxy-auth').checked,
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

function resetProxyDiagnosis() {
  diagnosisSequence += 1;
  $('#proxy-diagnosis').hidden = true;
  $('#proxy-diagnosis').replaceChildren();
  $('#diagnose-proxy').disabled = false;
  $('#diagnose-proxy').textContent = '诊断代理';
}

function importProxyCredentials(value) {
  const field = $('#profile-proxy');
  const status = $('#proxy-import-status');
  if (field.disabled || field.readOnly) return;
  field.setCustomValidity('');
  try {
    const result = applyProxyInput({ proxy: field, username: $('#proxy-username'), password: $('#proxy-password'), clearAuth: $('#clear-proxy-auth') }, value);
    if (!result.applied || !result.hasCredentials) return;
    status.className = 'field-help';
    status.textContent = '已自动填入代理地址、用户名和密码。密码已从地址栏移除；可直接诊断或保存。';
    status.hidden = false;
  } catch (error) {
    field.setCustomValidity(error.message);
    status.className = 'form-error';
    status.textContent = error.message;
    status.hidden = false;
  }
  resetProxyDiagnosis();
}

function renderProxyDiagnosis(result, input) {
  const panel = $('#proxy-diagnosis');
  panel.hidden = false;
  panel.replaceChildren();
  const error = typeof result.error === 'object' ? result.error : { message: result.error };
  const stageNames = { setup: '配置', proxy_dns: '代理地址解析', proxy_connect: '连接代理端口', connection: '连接代理端口', proxy_protocol: '代理协议握手', protocol: '代理协议握手', proxy_auth: '代理认证', authentication: '代理认证', target_dns: '目标域名解析', target_connect: '代理连接目标', tls: 'HTTPS 证书握手', probe_service: '出口查询', timeout: '请求超时' };
  const passed = result.ok === true && result.googleReachable === true && result.targetCountryMatches !== false;
  const title = passed ? '代理诊断通过' : result.ok ? '代理已连通，仍需处理以下检查' : `诊断停在：${stageNames[error?.stage] || '连接代理'}`;
  panel.append(element('strong', passed ? 'diagnosis-success' : 'diagnosis-warning', title));
  const steps = element('ul', 'diagnosis-steps');
  const add = (label, status, detail) => {
    const row = element('li', `diagnosis-${status}`);
    row.append(element('span', 'diagnosis-label', label), element('span', '', detail));
    steps.append(row);
  };
  add('代理协议 / 认证', result.ok ? 'success' : 'error', result.ok
    ? `${String(result.configuredProtocol || '').toUpperCase()} 连接通过`
    : error?.message || '代理连接未通过，后续检查未执行。');
  const probe = result.probe;
  add('实际出口', probe?.ip ? 'success' : 'pending', probe?.ip ? `${probe.ip} · ${countryLabel(probe.country)}` : '尚未取得出口信息');
  add('目标国家', result.targetCountryMatches === true ? 'success' : result.targetCountryMatches === false ? 'error' : 'pending', result.targetCountryMatches === true
    ? `与${countryName(input.country)}一致` : result.targetCountryMatches === false ? `与目标${countryName(input.country)}不一致` : '等待出口检查');
  add('Google 登录页', result.googleReachable === true ? 'success' : result.googleReachable === false ? 'error' : 'pending', result.googleReachable === true
    ? 'HTTPS 请求通过；登录由你在独立浏览器中完成' : result.googleReachable === false ? result.googleError || 'Google 登录页未连通' : '尚未检查');
  panel.append(steps);
  if (error?.code === 'proxy_auth_required') {
    panel.append(element('p', 'diagnosis-warning', '请在上方填写代理商提供的用户名和密码，再点“重新诊断”。如果服务商使用 IP 白名单，请先完成该授权。'));
    if (!$('#proxy-username').disabled) panel.append(actionButton('填写代理认证', 'button button-small button-outline', () => $('#proxy-username').focus()));
  }
  if (result.alternateProtocol?.ok === true && ['http', 'socks5'].includes(result.suggestedProtocol)
    && result.alternateProtocol.protocol === result.suggestedProtocol && !$('#profile-proxy').disabled) {
    const suggestion = element('p', '', `同一端口使用 ${result.suggestedProtocol.toUpperCase()} 已成功取得出口，原填写协议可能不匹配。`);
    panel.append(suggestion, actionButton(`改用 ${result.suggestedProtocol.toUpperCase()} 并重新诊断`, 'button button-small button-outline', () => {
      try {
        const url = new URL(input.proxy);
        $('#profile-proxy').value = `${result.suggestedProtocol}://${url.host}`;
        resetProxyDiagnosis();
        diagnoseProxy();
      } catch { toast('无法调整此地址，请在代理栏手动修改协议。', 'error'); }
    }));
  }
  panel.append(element('p', 'field-help', passed ? '可以保存环境，再点击卡片中的“登录 Google 账号”。启动前还会复查出口。' : '本次仅诊断网络，未保存配置或启动浏览器。'));
}

async function diagnoseProxy() {
  if (!$('#profile-proxy').reportValidity()) return;
  const proxy = $('#profile-proxy').value.trim();
  if (!proxy) { $('#profile-proxy').focus(); toast('先填写代理地址，再诊断连接。', 'error'); return; }
  const profile = state.profiles.find((item) => item.id === editingProfileId);
  const input = { proxy, country: $('#profile-country').value.trim().toUpperCase(),
    proxyUsername: $('#proxy-username').value, proxyPassword: $('#proxy-password').value,
    clearProxyAuth: $('#clear-proxy-auth').checked };
  if (profile && profile.proxy === proxy) input.profileId = profile.id;
  const sequence = ++diagnosisSequence;
  const button = $('#diagnose-proxy');
  button.disabled = true;
  button.textContent = '正在诊断…';
  const panel = $('#proxy-diagnosis');
  panel.hidden = false;
  panel.replaceChildren(element('p', '', '正在检查代理协议、认证、出口国家和 Google 登录页。必要时会验证另一种协议；最多等待 100 秒。'));
  try {
    const result = await api('/api/proxy/diagnose', { method: 'POST', body: JSON.stringify(input) });
    if (sequence === diagnosisSequence) renderProxyDiagnosis(result, input);
  } catch (error) {
    if (sequence === diagnosisSequence) panel.replaceChildren(element('p', 'diagnosis-error', error.message));
  } finally {
    if (sequence === diagnosisSequence) { button.disabled = false; button.textContent = '重新诊断'; }
  }
}

function renderCatalog(data) {
  catalogData = data;
  const direct = data.sourceKind === 'free';
  const results = $('#catalog-results');
  const allNodes = Array.isArray(data.nodes) ? [...data.nodes] : [];
  if (direct) {
    const merged = new Map(allNodes.map((node) => [proxyCheckKey(node), node]));
    for (const node of [...(scanState.results || []), ...(scanState.verifiedNodes || [])]) {
      if (data.country === 'ALL' || data.country === node.country) merged.set(proxyCheckKey(node), node);
    }
    allNodes.splice(0, allNodes.length, ...merged.values());
    for (const node of allNodes) rememberProxyVerification(node);
  }
  const verified = allNodes.filter((node) => usableProxyResult(proxyChecks.get(proxyCheckKey(node))));
  const nodes = direct && !$('#show-candidates').checked ? verified : allNodes;
  const total = Number.isFinite(data.total) ? data.total : allNodes.length;
  const isAll = data.country === 'ALL';
  const scope = isAll ? direct ? '全部支持国家（美日韩）' : '全部国家' : countryName(data.country);
  $('#catalog-status').textContent = direct
    ? `${scope} · 当前有效 ${verified.length} 个 · 展示 ${nodes.length} 个${$('#show-candidates').checked ? '候选' : '已通过节点'} · 目录共 ${total} 个候选`
    : `${scope}展示 ${nodes.length} 个节点 · 来源共 ${total} 个 · ${data.cached ? '缓存' : '已获取'} ${timeLabel(data.fetchedAt)} · 来源 ${data.source || 'VPN Gate'}`;
  const failedSources = (Array.isArray(data.sources) ? data.sources : []).filter((source) => source.ok === false || source.status === 'failed');
  $('#catalog-source-status').hidden = !failedSources.length;
  $('#catalog-source-status').textContent = failedSources.length ? `部分来源读取失败：${failedSources.map((source) => source.name || '未命名来源').join('、')}。当前展示其余来源的结果，数量可能不完整。` : '';
  proxyRows.clear();
  const counts = data.countryCounts && typeof data.countryCounts === 'object' ? data.countryCounts : {};
  const countries = direct ? directProxyCountries : [...new Set(['US', 'JP', 'KR', 'IN', 'NG', ...Object.keys(counts).sort((a, b) => Number(counts[b]) - Number(counts[a]))])];
  const summary = element('div', 'catalog-country-counts');
  summary.append(element('span', '', '国家供给：'));
  for (const code of countries.slice(0, 12)) {
    const count = Number(counts[code]) || 0;
    summary.append(actionButton(`${countryName(code)} ${count}${direct ? ' 候选' : ''}`, `catalog-count ${data.country === code ? 'selected' : ''}`, () => selectCatalogCountry(code)));
  }
  $('#catalog-summary').replaceChildren(summary);
  if (!nodes.length) {
    const empty = element('div', 'catalog-empty');
    const allSourcesFailed = data.sources?.length > 0 && failedSources.length === data.sources.length;
    if (allSourcesFailed) {
      empty.append(element('strong', '', '来源读取失败，无法判断节点供给'), element('p', '', '请重试目录请求。读取失败不代表这个国家没有节点。'));
    } else if (direct && !$('#show-candidates').checked) {
      empty.append(element('strong', '', scanState.running ? '正在筛选，尚无近期通过的节点' : '当前没有近期检测通过的节点'));
      empty.append(element('p', '', allNodes.length ? `已加载 ${allNodes.length} 个候选。未检测、失败及超过 2 分钟的结果不会显示为可用；点击“自动筛选可用节点”继续检查下一批。` : '当前范围没有候选可检。可以切换国家、刷新目录，或配置你已有的代理。'));
      if (allNodes.length) empty.append(actionButton('查看候选与失败原因', 'button button-outline', () => { $('#show-candidates').checked = true; renderCatalog(catalogData); }));
    } else {
      empty.append(element('strong', '', isAll ? '当前目录没有可展示的节点' : `${countryName(data.country)}当前没有节点`));
      empty.append(element('p', '', isAll ? `当前${direct ? '美日韩范围' : '来源目录'}返回了 0 个节点。请稍后重试，或更换目录来源。` : `已读取来源目录 ${total} 个节点，但没有符合此国家的节点。可查看全部国家。`));
    }
    if (!isAll) empty.append(actionButton('查看全部支持国家', 'button button-outline', () => selectCatalogCountry('ALL')));
    results.replaceChildren(empty);
    updateScanControls();
    return;
  }
  const table = element('table', 'catalog-table');
  const head = element('thead');
  const header = element('tr');
  const columns = direct ? ['代理地址', '目录国家', '协议 / 网络信息', '检测与创建环境'] : ['节点 / IP', '国家', '延迟 / 速度', '在线 / 会话', '协议 / 住宅属性', '连接配置'];
  for (const label of columns) header.append(element('th', '', label));
  head.append(header);
  const body = element('tbody');
  for (const node of nodes) {
    if (direct) { body.append(renderProxyRow(node)); continue; }
    const row = element('tr');
    const address = element('td');
    address.append(element('strong', '', node.hostname || node.id || '未命名节点'), element('span', 'catalog-detail', node.ip || 'IP 未提供'));
    const metric = (value, unit) => Number.isFinite(value) ? `${value} ${unit}` : '未提供';
    row.append(address, element('td', '', countryLabel(node.country)), element('td', '', `${metric(node.latencyMs, 'ms')} / ${metric(node.speedMbps, 'Mbps')}`), element('td', '', `${metric(node.uptimeHours, '小时')} / ${metric(node.sessions, '会话')}`), element('td', '', `${Array.isArray(node.transport) ? node.transport.join(', ') : node.transport || 'VPN / OpenVPN'} · 住宅未验证`));
    const connection = element('td', 'catalog-node-actions');
    const specificUrl = safeCatalogLink(node.configUrl) || safeCatalogLink(node.connectionUrl);
    const connectionUrl = specificUrl || safeCatalogLink(node.connectionGuideUrl);
    if (connectionUrl) {
      const link = element('a', 'text-link', specificUrl ? '官方连接配置 ↗' : '官方连接教程 ↗');
      link.href = connectionUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      connection.append(link);
    } else connection.append(element('span', 'catalog-detail', '此节点尚无配置入口'));
    connection.append(actionButton('配置此国家环境', 'catalog-configure-button', () => openProfileDialog(null, { country: node.country,
      message: `正在为${countryName(node.country)}节点新建环境。请先用 VPN 客户端连接，再将本地 HTTP / SOCKS5 转发地址填入代理栏；节点 IP 本身不能直接当作代理地址。`, focusProxy: true })));
    row.append(connection);
    body.append(row);
  }
  table.append(head, body);
  const scroll = element('div', 'table-scroll');
  scroll.append(table);
  results.replaceChildren(scroll);
  updateScanControls();
}

function proxyCheckKey(node) { return `${node.id}:${node.country}`; }

function rememberProxyVerification(node) {
  const key = proxyCheckKey(node);
  if (node.verification && typeof node.verification === 'object' && !pendingProxyChecks.has(key)) {
    const previous = proxyChecks.get(key);
    if (!previous || !Number.isFinite(new Date(previous.checkedAt).getTime()) || new Date(node.verification.checkedAt).getTime() > new Date(previous.checkedAt).getTime()) {
      proxyChecks.set(key, { ...node.verification, fromCatalog: true });
    }
  }
}

function renderProxyRow(node) {
  const key = proxyCheckKey(node);
  rememberProxyVerification(node);
  const row = element('tr');
  const address = element('td');
  address.append(element('strong', 'proxy-address', node.proxy || node.hostname || node.ip || '地址未提供'));
  const network = element('td');
  network.append(element('strong', '', node.transport || '未知协议'), element('span', 'catalog-detail', node.asn ? `ASN：${node.asn}` : 'ASN 未提供'), element('span', 'catalog-detail', '住宅属性未验证'));
  const controls = element('td', 'proxy-controls');
  const checkButton = actionButton('检测可用性', 'button button-small button-outline', () => checkPublicProxy(node));
  const createButton = actionButton('用此代理创建环境', 'button button-small button-primary', () => importPublicProxy(node));
  const status = element('p', 'proxy-check-status');
  status.setAttribute('role', 'status');
  controls.append(checkButton, createButton, status);
  row.append(address, element('td', '', countryLabel(node.country)), network, controls);
  proxyRows.set(key, { node, checkButton, createButton, status });
  updateProxyRow(node);
  return row;
}

function usableProxyResult(result) {
  const age = Date.now() - new Date(result?.checkedAt).getTime();
  return Number.isFinite(age) && age >= -5000 && age < proxyCheckMaxAge
    && result?.ok === true && result.googleReachable === true && typeof result.proxy === 'string' && /^[A-Z]{2}$/.test(result.country || '');
}

function updateProxyRow(node) {
  const key = proxyCheckKey(node);
  const refs = proxyRows.get(key);
  if (!refs) return;
  const checking = pendingProxyChecks.has(key);
  const result = proxyChecks.get(key);
  refs.checkButton.disabled = checking;
  refs.checkButton.textContent = checking ? '正在检测…' : result ? '重新检测' : '检测可用性';
  refs.createButton.hidden = checking || !usableProxyResult(result);
  let type = '';
  let message = '先检测代理连通性、实际出口和 Google 登录页；检测通过后可创建环境。';
  if (checking) { type = 'pending'; message = '正在通过此代理检查出口及 Google 登录页；首次更新目录时最多约 50 秒。'; }
  else if (usableProxyResult(result)) {
    type = 'success';
    message = `${result.fromCatalog ? '已保存检测通过' : '检测通过'} · 实际出口 ${countryLabel(result.country)} · Google 可访问${Number.isFinite(result.latencyMs) ? ` · ${result.latencyMs} ms` : ''} · 检测于 ${timeLabel(result.checkedAt)}。结果有效期 2 分钟，启动时仍会复查出口。`;
  } else if (result?.ok === true) {
    type = 'warning';
    message = `上次检测通过时间：${timeLabel(result.checkedAt)}。结果已过期或时间无效，请点击“重新检测”后再创建环境。`;
  } else if (result) {
    type = 'error';
    message = `${result.fromCatalog ? `已保存的检测结果（${timeLabel(result.checkedAt)}）：` : ''}${result.error || (result.googleReachable === false ? '代理未能访问 Google 登录页，不能用于此流程。请检测其他节点。' : '此节点检测未通过，请检测其他节点。')}`;
  }
  refs.status.className = `proxy-check-status ${type}`;
  refs.status.textContent = message;
}

async function checkPublicProxy(node) {
  const key = proxyCheckKey(node);
  if (pendingProxyChecks.has(key)) return;
  if (pendingProxyChecks.size >= 3) {
    const refs = proxyRows.get(key);
    if (refs) { refs.status.className = 'proxy-check-status warning'; refs.status.textContent = '已有 3 个节点正在检测。请等待其中一个完成后再试。'; }
    return;
  }
  pendingProxyChecks.add(key);
  updateProxyRow(node);
  try {
    const result = await api('/api/proxies/check', { method: 'POST', body: JSON.stringify({ id: node.id, country: node.country }) });
    proxyChecks.set(key, result);
  } catch (error) {
    proxyChecks.set(key, { ok: false, error: error.message });
  } finally {
    pendingProxyChecks.delete(key);
    if (catalogData) renderCatalog(catalogData);
    else updateProxyRow(node);
  }
}

function importPublicProxy(node) {
  const result = proxyChecks.get(proxyCheckKey(node));
  if (!usableProxyResult(result)) { updateProxyRow(node); return; }
  openProfileDialog(null, { country: result.country, proxy: result.proxy, label: `${countryName(result.country)} · 公共代理`,
    message: `已填入检测通过的代理；实际出口${countryName(result.country)}，Google 登录页可访问。确认配置并保存后，点击环境卡片的“登录 Google 账号”。公开代理的住宅属性未验证，启动时会再次检查出口。` });
}

function updateCatalogSource() {
  const direct = $('#catalog-source').value === 'free';
  $('#scan-proxies').hidden = !direct;
  $('#candidate-filter').hidden = !direct;
  const countries = $('#catalog-country');
  for (const option of countries.options) {
    option.disabled = direct && option.value !== 'ALL' && !directProxyCountries.includes(option.value);
    option.hidden = option.disabled;
    if (option.value === 'ALL') option.textContent = direct ? '全部支持国家 · 美日韩' : '全部国家';
  }
  if (direct && countries.value !== 'ALL' && !directProxyCountries.includes(countries.value)) countries.value = 'ALL';
  $('#catalog-note').textContent = direct
    ? '每次自动检查最多 30 个候选，同时检测 3 个；再次筛选会继续下一批。默认只显示最近 2 分钟内出口国家与 Google 连通性均通过的节点。公开代理没有可用率保证，住宅属性未验证。'
    : '此目录列出 VPN / OpenVPN 服务。需要通过 VPN 客户端或 fanout 转为本地 HTTP / SOCKS5 后才能配置环境；节点 IP 不能直接用作代理地址。住宅属性未验证。';
  const links = direct ? [
    ['monosans / proxy-list · 来源 ↗', 'https://github.com/monosans/proxy-list'],
    ['Proxifly / free-proxy-list · 来源 ↗', 'https://github.com/proxifly/free-proxy-list']
  ] : [
    ['VPN Gate 官方目录 ↗', 'https://www.vpngate.net/'],
    ['了解 fanout ↗', 'https://github.com/byJoey/fanout']
  ];
  $('#catalog-source-links').replaceChildren(...links.map(([label, url]) => {
    const link = element('a', '', label);
    link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    return link;
  }));
  updateScanControls();
}

function scanIsActive() {
  return Boolean(scanState.running || scanState.active > 0 || ['loading', 'running'].includes(scanState.state));
}

function updateScanControls() {
  const active = scanIsActive();
  $('#scan-proxies').disabled = scanRequestPending || active || loadingCatalog;
  $('#scan-proxies').textContent = active ? '正在筛选…' : '自动筛选可用节点';
  $('#catalog-country').disabled = active || loadingCatalog;
  $('#catalog-source').disabled = active || loadingCatalog;
  document.querySelectorAll('.catalog-count').forEach((button) => { button.disabled = active || loadingCatalog; });
  $('#cancel-scan').disabled = scanRequestPending || !active || scanState.state === 'cancelled';
  $('#cancel-scan').hidden = !active;
}

function renderScanStatus() {
  const panel = $('#scan-progress');
  panel.hidden = scanState.state === 'idle';
  if (panel.hidden) { updateScanControls(); return; }
  const total = Number(scanState.total) || 0;
  const tested = Number(scanState.tested ?? scanState.completed) || 0;
  const active = Number(scanState.active) || 0;
  const labels = { loading: '正在读取候选目录', running: '正在筛选可用节点', completed: '本批筛选完成', cancelled: active ? '已停止排队，等待当前检测结束' : '筛选已停止', failed: '筛选未能完成' };
  $('#scan-progress-title').textContent = `${scanState.country && scanState.country !== 'ALL' ? countryName(scanState.country) : '美日韩'} · ${labels[scanState.state] || '筛选状态'}`;
  const progress = $('#scan-progress-bar');
  progress.max = Math.max(1, total);
  if (scanState.state === 'loading') progress.removeAttribute('value');
  else progress.value = tested;
  const detail = `已检测 ${tested} / ${total} · 通过 ${Number(scanState.passed) || 0} · 失败 ${Number(scanState.failed) || 0}${active ? ` · 正在检测 ${active}` : ''}`;
  const suffix = scanState.error ? `。${scanState.error}` : scanState.exhausted ? '。当前候选均已检查；请等待结果过期后再试，或切换国家。' : scanState.state === 'completed' && !scanState.passed ? '。本批没有通过的节点，可继续筛选下一批；展开全部候选可查看失败原因。' : '';
  $('#scan-progress-detail').textContent = detail + suffix;
  updateScanControls();
}

function acceptScanState(result) {
  scanState = result.scan || result;
  renderScanStatus();
  if (catalogData?.sourceKind === 'free') renderCatalog(catalogData);
  else if (!catalogData && scanState.id && !loadingCatalog && $('#catalog-source').value === 'free') loadCatalog();
  window.clearTimeout(scanPollTimer);
  if (scanIsActive()) scanPollTimer = window.setTimeout(() => pollScanStatus(), 1500);
}

async function pollScanStatus() {
  try {
    const result = await api('/api/proxies/scan');
    acceptScanState(result);
  } catch (error) {
    $('#scan-progress').hidden = false;
    $('#scan-progress-detail').textContent = `暂时无法读取筛选进度：${error.message} 进度恢复后会继续显示结果。`;
    if (scanIsActive()) scanPollTimer = window.setTimeout(() => pollScanStatus(), 4000);
  }
}

async function startProxyScan() {
  if (scanRequestPending || scanIsActive()) return;
  scanRequestPending = true;
  updateScanControls();
  $('#catalog-error').hidden = true;
  try {
    const result = await api('/api/proxies/scan', { method: 'POST', body: JSON.stringify({ country: $('#catalog-country').value, limit: 30 }) });
    acceptScanState(result);
    if (!catalogData || catalogData.sourceKind !== 'free' || catalogData.country !== $('#catalog-country').value) await loadCatalog();
  } catch (error) {
    $('#catalog-error').textContent = `无法开始筛选：${error.message}`;
    $('#catalog-error').hidden = false;
  } finally {
    scanRequestPending = false;
    updateScanControls();
  }
}

async function cancelProxyScan() {
  if (scanRequestPending || !scanIsActive()) return;
  scanRequestPending = true;
  updateScanControls();
  try {
    acceptScanState(await api('/api/proxies/scan/cancel', { method: 'POST', body: '{}' }));
  } catch (error) {
    $('#scan-progress-detail').textContent = `停止请求未完成：${error.message}`;
  } finally {
    scanRequestPending = false;
    updateScanControls();
  }
}

function safeCatalogLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
      && (url.hostname === 'vpngate.net' || url.hostname.endsWith('.vpngate.net')) ? url.href : null;
  } catch { return null; }
}

function selectCatalogCountry(country) {
  if (loadingCatalog || scanIsActive()) return;
  const select = $('#catalog-country');
  if (![...select.options].some((option) => option.value === country)) {
    const option = element('option', '', countryLabel(country));
    option.value = country;
    select.append(option);
  }
  select.value = country;
  loadCatalog();
}

async function loadCatalog() {
  if (loadingCatalog) return;
  updateCatalogSource();
  loadingCatalog = true;
  updateScanControls();
  const button = $('#load-catalog');
  const selectedCountry = $('#catalog-country').value;
  const selectedSource = $('#catalog-source').value;
  button.disabled = true;
  button.textContent = '读取目录中…';
  $('#catalog-country').disabled = true;
  $('#catalog-source').disabled = true;
  document.querySelectorAll('.catalog-count').forEach((item) => { item.disabled = true; });
  $('#catalog-error').hidden = true;
  $('#catalog-source-status').hidden = true;
  $('#catalog-status').textContent = `正在读取${selectedCountry === 'ALL' ? selectedSource === 'free' ? '美日韩' : '全球' : countryName(selectedCountry)}目录，请稍候…`;
  try {
    const data = await api(`${selectedSource === 'free' ? '/api/proxies' : '/api/catalog'}?country=${encodeURIComponent(selectedCountry)}`);
    renderCatalog({ ...data, country: data.country || selectedCountry, sourceKind: selectedSource });
  } catch (error) {
    $('#catalog-error').textContent = `目录读取失败：${error.message} 可重试或切换目录来源。`;
    $('#catalog-error').hidden = false;
    $('#catalog-status').textContent = '本次读取失败；下方已有结果如有显示，仍为上次读取的数据。';
  } finally {
    loadingCatalog = false;
    button.disabled = false;
    button.textContent = '刷新目录';
    updateScanControls();
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

async function saveForm({ event, form, button, errorElement, dialog, path, method, body, success, onSaved }) {
  event.preventDefault();
  if (button.disabled || !form.reportValidity()) return;
  const label = button.textContent;
  errorElement.hidden = true;
  button.disabled = true;
  button.textContent = '保存中…';
  try {
    const result = await api(path, { method, body: JSON.stringify(body) });
    dialog.close();
    await loadState().catch(() => {});
    onSaved?.(result);
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

$('#remote-logout').addEventListener('click', async () => {
  if (!remoteBrowserEnabled()) return;
  try {
    const response = await fetch('/logout', {method:'POST', redirect:'follow'});
    if (!response.ok) throw new Error('退出工作台失败，请稍后重试。');
    closeRemoteDesktop();
    window.location.assign('/login');
  } catch (error) { toast(error.message, 'error'); }
});
$('#new-profile').addEventListener('click', () => openProfileDialog());
$('#refresh').addEventListener('click', () => loadState().catch(() => {}));
$('#environment-engine').addEventListener('change', updateEngineHelp);
$('#open-remote-desktop').addEventListener('click', (event) => {
  event.preventDefault();
  openRemoteDesktop();
});
$('#hide-remote-desktop').addEventListener('click', () => {
  closeRemoteDesktop();
  $('#open-remote-desktop').focus();
});
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
for (const id of ['profile-proxy', 'profile-country', 'proxy-username', 'proxy-password']) document.getElementById(id).addEventListener('input', resetProxyDiagnosis);
$('#profile-proxy').addEventListener('paste', (event) => {
  const field = event.currentTarget;
  if (field.disabled || field.readOnly) return;
  const value = event.clipboardData?.getData('text/plain');
  if (value?.includes('@')) {
    event.preventDefault();
    importProxyCredentials(value);
  }
});
$('#profile-proxy').addEventListener('input', (event) => {
  const field = event.currentTarget;
  if (field.disabled || field.readOnly) return;
  field.setCustomValidity('');
  $('#proxy-import-status').hidden = true;
  if (field.value.includes('@')) importProxyCredentials(field.value);
});
$('#diagnose-proxy').addEventListener('click', diagnoseProxy);
$('#clear-proxy-auth').addEventListener('change', () => {
  const disabled = $('#clear-proxy-auth').checked || profileLocked(state.profiles.find((item) => item.id === editingProfileId));
  $('#proxy-username').disabled = disabled;
  $('#proxy-password').disabled = disabled;
  resetProxyDiagnosis();
});
for (const id of ['environment-locale', 'environment-timezone']) {
  document.getElementById(id).addEventListener('input', () => editedEnvironmentFields.add(id));
}
$('#load-catalog').addEventListener('click', loadCatalog);
$('#scan-proxies').addEventListener('click', startProxyScan);
$('#cancel-scan').addEventListener('click', cancelProxyScan);
$('#show-candidates').addEventListener('change', () => { if (catalogData) renderCatalog(catalogData); });
$('#catalog-country').addEventListener('change', loadCatalog);
$('#catalog-source').addEventListener('change', () => {
  catalogData = null;
  updateCatalogSource();
  $('#catalog-summary').replaceChildren();
  $('#catalog-results').replaceChildren(element('div', 'catalog-empty', '正在读取所选来源…'));
  loadCatalog();
});
$('#find-public-proxy').addEventListener('click', () => {
  $('#profile-dialog').close();
  $('#catalog').scrollIntoView({ block: 'start', behavior: 'smooth' });
  if (!loadingCatalog) { $('#catalog-source').value = 'free'; updateCatalogSource(); loadCatalog(); }
});
$('#configure-fanout').addEventListener('click', () => openProfileDialog(null, { country: $('#catalog-country').value === 'ALL' ? 'US' : $('#catalog-country').value, fanout: true, focusProxy: true }));
$('#open-devices').addEventListener('click', (event) => {
  const profile = state.profiles.find((item) => item.id === reviewingProfileId);
  if (profile) launchTarget(profile, 'devices', event.currentTarget);
});
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => document.getElementById(button.dataset.close).close()));

$('#profile-form').addEventListener('submit', (event) => saveForm({
  event,
  form: $('#profile-form'),
  button: $('#profile-submit'),
  errorElement: $('#profile-form-error'),
  dialog: $('#profile-dialog'),
  path: editingProfileId ? `/api/profiles/${encodeURIComponent(editingProfileId)}` : '/api/profiles',
  method: editingProfileId ? 'PATCH' : 'POST',
  body: profileFormBody(),
  success: editingProfileId ? '环境配置已保存。下一步在卡片点击“登录 Google 账号”。' : '新的独立环境已创建。下一步在卡片配置网络并登录。',
  onSaved: (profile) => {
    if (!profile?.id) return;
    setOperationStatus(profile, profile.proxy
      ? remoteBrowserEnabled() ? '配置已保存。下一步：点击“登录 Google 账号”。会先验证出口国家，再启动服务器浏览器，通过远程画面完成登录。也可先点击“检查网络”。' : '配置已保存。下一步：点击“登录 Google 账号”。会先验证出口国家，再打开本机独立浏览器。也可先点击“检查网络”。'
      : '环境已保存，尚未配置代理。点击“登录 Google 账号”填写出口地址后即可继续。', profile.proxy ? 'success' : 'warning');
    document.getElementById(`profile-${profile.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
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

updateCatalogSource();
window.setInterval(() => {
  if (catalogData?.sourceKind === 'free') renderCatalog(catalogData);
  else for (const { node } of proxyRows.values()) updateProxyRow(node);
  if (remoteBrowserEnabled() && !document.hidden && !document.querySelector('dialog[open]')) loadState().catch(() => {});
}, 15000);
loadState().then(() => pollScanStatus()).catch(() => {});
