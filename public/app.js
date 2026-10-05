'use strict';

const $ = (selector) => document.querySelector(selector);
const countryNames = { IN: '印度', NG: '尼日利亚', CN: '中国', US: '美国', GB: '英国', JP: '日本', SG: '新加坡', DE: '德国', CA: '加拿大', AU: '澳大利亚' };
const countryEnglish = { IN: 'INDIA', NG: 'NIGERIA' };
let state = { profiles: [], browser: null, token: '', links: {} };
let editingProfileId = null;
let observingProfileId = null;
let loadingState = false;
const pending = new Set();

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
  return Boolean(profile.proxy && check?.ok && String(check.country).toUpperCase() === String(profile.country).toUpperCase());
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
  const busy = pending.has(profile.id);
  const header = element('div', 'profile-card-header');
  const country = String(profile.country || '').toUpperCase();
  header.append(element('div', `country-tile country-${country.toLowerCase()}`, country));
  const identity = element('div', 'profile-identity');
  const name = element('h3', 'profile-name', profile.label);
  identity.append(name, element('p', 'profile-country', `${countryName(country)} / ${countryEnglish[country] || country} · 独立浏览器配置`));
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
  const launchDisabled = busy || !profile.proxy || !state.browser;
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
  $('.table-scroll').hidden = observations.length === 0;
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
    else if (check?.country) toast(`实际出口为${countryName(check.country)}，与目标${countryName(profile.country)}不一致。`, 'warning');
    else toast(check?.error || '网络检查未通过，请检查代理配置。', 'error');
  });
}

function launchTarget(profile, target, button) {
  const names = { gmail: 'Gmail', youtube: 'YouTube', terms: 'Google 服务条款页', appeal: '官方国家/地区变更申请' };
  return profileAction(profile, button, 'launch', { target }, () => toast(`已请求在“${profile.label}”的独立浏览器环境中打开${names[target]}。`));
}

function startCycle(profile, button) {
  return profileAction(profile, button, 'cycle', {}, () => toast('新的七天观察周期已开始；既有观察记录仍保留。'));
}

function openProfileDialog(profile = null) {
  editingProfileId = profile?.id || null;
  $('#profile-form').reset();
  $('#profile-dialog-title').textContent = profile ? '编辑环境' : '新建环境';
  $('#profile-submit').textContent = profile ? '保存环境' : '创建环境';
  $('#profile-label').value = profile?.label || '';
  $('#profile-country').value = profile?.country || '';
  $('#profile-proxy').value = profile?.proxy || '';
  const isBound = Boolean(profile?.launches?.length);
  $('#profile-country').disabled = isBound;
  $('#profile-proxy').disabled = isBound;
  $('#profile-binding-note').textContent = isBound
    ? '这个环境已启动过浏览器，国家与代理地址已固定绑定。你可以修改环境名称；需要切换线路时，请新建一个环境。'
    : '首次打开浏览器后，环境将固定绑定国家与代理地址。需要切换线路时，请新建一个环境。';
  $('#profile-form-error').hidden = true;
  $('#profile-dialog').showModal();
  $('#profile-label').focus();
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
  body: { label: $('#profile-label').value.trim(), country: $('#profile-country').value.trim().toUpperCase(), proxy: $('#profile-proxy').value.trim() },
  success: editingProfileId ? '环境配置已保存。' : '新的独立环境已创建。'
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
