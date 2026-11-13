// app.js —— UI 与业务编排：列表 / 编辑 / NFC / 设置 + 链接管理 + 自动重连。
// 静音红线：本文件不含任何 Audio/Notification/震动之外的提示代码；「测试铃声」只发 cmd:bell 展示回执。
// （navigator.vibrate 为无声震动，PC 上是 no-op，仅真机收到 fired 时轻震一次。）

import { cmd, DEVICE_NAME_PREFIX, MAX_REMINDERS, MAX_NAME_CHARS, parseNdefUrl } from './protocol.js';
import { SimulatedLink, BleLink, LinkError, reconnectDelayMs } from './badge-link.js';
import { renderNameBitmap, drawBitmap } from './bmp.js';
import { store } from './store.js';

// ---------- 小工具 ----------
const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, children = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children) n.append(c);
  return n;
};
const genId = () => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e) => (e instanceof LinkError ? `[${e.kind}] ${e.message}` : String(e?.message || e));
const fmt2 = (n) => String(n).padStart(2, '0');
const DAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

// ---------- 全局状态 ----------
const state = {
  settings: store.loadSettings(),
  drafts: store.loadDrafts(),
  syncedCount: store.loadSyncedCount(),
  link: null,
  hello: null,            // 最近一次 evt:hello
  view: 'list',
  editingId: null,        // 正在编辑的草稿 id；null = 新建
  syncBusy: false,
  events: [],             // 本地事件 feed（fired 等）
  reconnect: { timer: null, attempt: 0, max: 8, slowMs: 30_000 }, // 耗尽后转 slowMs 低频持续重试；探针可改 slowMs 便于演示
};
// 调试探针（模块顶部即挂，通宵联调用；控制台可读写内部状态）
window.__rmnd = state;

// ---------- Toast ----------
function toast(msg, kind = 'info', ms = 2600) {
  const box = $('#toasts');
  const t = el('div', { class: `toast ${kind}`, text: msg });
  box.append(t);
  setTimeout(() => t.remove(), ms);
}
const _lastToastAt = new Map();
function toastOnce(key, msg, kind = 'info', ms = 2600) {
  const now = Date.now();
  if (now - (_lastToastAt.get(key) ?? 0) < 60_000) return;
  _lastToastAt.set(key, now);
  toast(msg, kind, ms);
}

// ---------- 链接管理 ----------
function createLink(mode) {
  if (state.link) { try { state.link.close(); } catch { /* 忽略 */ } }
  const link = mode === 'ble' ? new BleLink() : new SimulatedLink();
  bindLink(link);
  state.link = link;
  state.hello = null;
  return link;
}

function bindLink(link) {
  link.addEventListener('status', (e) => onStatus(e.detail));
  link.addEventListener('evt', (e) => onEvt(e.detail));
  link.addEventListener('fault', (e) => onFault(e.detail));
}

async function connect({ reuse = false, fromReconnect = false } = {}) {
  // 重连循环内部的调用不清退避计数（否则每轮失败后从 0 重新数，退避永远停在 1s —— 见 N-08）
  if (!fromReconnect) cancelReconnect();
  const mode = state.settings.mode;
  if (mode === 'ble' && !BleLink.available()) {
    toast('此浏览器不支持 Web Bluetooth（需 Chrome/Edge + localhost/HTTPS）', 'err', 4000);
    return false;
  }
  try {
    // 复用同类型链路实例（settings.mode ∈ {'sim','ble'}，link.mode ∈ {'simulated','ble'} —— 口径映射见 N-04）
    const wantMode = mode === 'ble' ? 'ble' : 'simulated';
    const link = state.link && state.link.mode === wantMode ? state.link : createLink(mode);
    await link.open({ reuse });
    return true;
  } catch (e) {
    toast(`连接失败：${errMsg(e)}`, 'err', 4000);
    scheduleReconnect();
    return false;
  }
}

function onStatus(detail) {
  (state.statusLog = state.statusLog ?? []).push({ t: Date.now(), status: detail });
  renderConn();
  if (detail.state === 'connected') {
    cancelReconnect();
    refreshHello();
    if (state.reconnect.attempt > 0) toast('✓ 已重连', 'ok');
    state.reconnect.attempt = 0;
  } else if (detail.state === 'disconnected' && detail.detail !== 'local') {
    // 契约 §4.2：断开应能直接重连。一切断连当可重试事件（另一会话可能随时重启设备）。
    toast(`连接断开（${detail.detail ?? '?'}），自动重连中…`, 'warn');
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (state.reconnect.timer) return;
  const { attempt, max, slowMs } = state.reconnect;
  if (attempt === max) {
    // 快速退避耗尽 → 转低频持续重试（契约 §4.2：一切断连皆可重试，不放弃）
    toastOnce('slow-retry', '快速重连耗尽，转 30s 低频持续重连（点状态栏可手动加速）', 'warn', 5000);
  }
  const delay = reconnectDelayMs(attempt, { fastMax: max, slowMs });
  state.reconnect.attempt = attempt + 1;
  (state.reconnect.history ??= []).push({ t: Date.now(), from: attempt, delay }); // 调试轨迹
  state.reconnect.timer = setTimeout(async () => {
    state.reconnect.timer = null;
    renderConn();
    await connect({ reuse: state.settings.mode === 'ble', fromReconnect: true });
  }, delay);
}

function cancelReconnect() {
  if (state.reconnect.timer) { clearTimeout(state.reconnect.timer); state.reconnect.timer = null; }
  state.reconnect.attempt = 0;
}

async function refreshHello() {
  if (!state.link?.connected) return;
  try {
    const evt = await state.link.request(cmd.hello());
    state.hello = { ...evt, at: Date.now() }; // at = 采样时刻：偏差显示不随后续时间增长
  } catch { /* 状态栏保持旧值 */ }
  renderConn();
}

function onEvt(evt) {
  if (evt.evt === 'fired') {
    const name = state.drafts[evt.i]?.name;
    const label = name ? name : `第 ${evt.i + 1} 条`;
    const msg = `⏰ 该吃药了：${label}（${evt.at}）`;
    toast(msg, 'alert', 8000);
    try { navigator.vibrate?.(300); } catch { /* 不支持则忽略 */ }
    state.events.unshift({ t: Date.now(), text: `fired #${evt.i} @ ${evt.at}` });
    state.events = state.events.slice(0, 20);
  } else if (evt.evt === 'err') {
    toast(`设备回执 err:${evt.why}`, 'warn');
  }
}

function onFault(f) {
  toastOnce('fault-' + f.kind, `链路帧异常：${f.kind}（已丢弃）`, 'warn');
}

// ---------- 状态栏 ----------
function renderConn() {
  const chip = $('#conn-chip');
  const txt = $('#conn-text');
  const link = state.link;
  let cls = 'chip';
  let text = '未连接 · 点按连接';
  if (link?.mode === 'simulated') {
    if (link.connected) {
      cls += ' ok';
      const h = state.hello;
      let drift = '';
      if (h?.utc > 0) {
        const d = Math.round((h.at ?? Date.now()) / 1000 - h.utc);
        drift = ` · 偏差${d >= 0 ? '+' : ''}${d}s`;
      } else if (h) drift = ' · 未校时';
      text = `模拟 ${link.deviceName} · ${h?.bat ?? '?'}%${drift} · ${h?.n ?? '?'}条`;
    } else if (state.reconnect.timer) {
      cls += ' warn'; text = reconnLabel();
    } else { cls += ' err'; text = '模拟未连接 · 点按连接'; }
  } else if (link?.mode === 'ble') {
    if (link.connected) {
      cls += ' ok';
      const h = state.hello;
      let drift = '';
      if (h?.utc > 0) {
        const d = Math.round((h.at ?? Date.now()) / 1000 - h.utc);
        drift = ` · 偏差${d >= 0 ? '+' : ''}${d}s`;
      } else if (h) drift = ' · 未校时';
      text = `${link.device?.name ?? 'RMND-????'} · ${h?.bat ?? '?'}%${drift} · ${h?.n ?? '?'}条`;
    } else if (state.reconnect.timer) { cls += ' warn'; text = `蓝牙${reconnLabel()}`; }
    else { cls += ' err'; text = '蓝牙未连接 · 点按连接'; }
  }
  chip.className = cls;
  txt.textContent = text;
  document.title = badgeIdSuffix() ? `服药提醒 · ${state.settings.badgeId}` : '服药提醒 · 徽章配置';
  $('#btn-simdrop').hidden = !(link?.mode === 'simulated' && link.connected);
  $('#btn-connect').disabled = !!link?.connected;
  state._lastRender = { at: Date.now(), conn: text, cls, linkMode: link?.mode ?? null, linkConnected: link?.connected ?? null }; // 调试轨迹
}

function badgeIdSuffix() {
  return state.settings.badgeId ? ` [${state.settings.badgeId}]` : '';
}

/** 重连状态栏文案：快速退避阶段显示 n/max，低频阶段显示「低频」 */
function reconnLabel() {
  const { attempt, max } = state.reconnect;
  return attempt > max ? `低频重连中` : `重连中(${attempt}/${max})`;
}

// ---------- 草稿 ↔ 提醒对象 ----------
function buildReminder(d) {
  const { bmp, bmp2, truncated } = renderNameBitmap(d.name);
  const r = { on: !!d.on, hh: d.hh, mm: d.mm, days: d.days, name: d.name };
  if (bmp) r.bmp = bmp;
  if (bmp2) r.bmp2 = bmp2;
  if (truncated) {
    toastOnce('trunc-' + d.name, `「${d.name}」较长：工牌屏单行放不下，已按 480B 预算截断显示`, 'warn');
  }
  return r;
}

function persist() {
  store.saveDrafts(state.drafts);
  store.saveSettings(state.settings);
}

// ---------- 列表视图 ----------
function renderList() {
  const box = $('#list-box');
  box.innerHTML = '';
  $('#list-empty').hidden = state.drafts.length > 0;
  $('#sync-hint').textContent =
    `草稿 ${state.drafts.length}/${MAX_REMINDERS} 条 · 已同步 ${state.syncedCount} 条` +
    (state.settings.badgeId ? ` · 徽章 ${state.settings.badgeId}` : '');
  state.drafts.forEach((d, idx) => {
    const { bmp } = renderNameBitmap(d.name);
    const cv = el('canvas');
    drawBitmap(cv, bmp, { scale: 1 });
    const frame = el('div', { class: 'badge-frame' }, [cv]);

    const daysMini = el('span', { class: 'days-mini', role: 'img', 'aria-label': '重复日' },
      [...DAY_LABELS].map((c, i) => el('span', { class: d.days[i] === '1' ? 'on' : '', text: c })));
    const sub = el('div', { class: 'sub' }, [
      daysMini,
      el('span', { text: d.on ? '已启用' : '已停用' }),
    ]);
    const meta = el('div', { class: 'meta' }, [
      el('div', { class: 'name', text: `${fmt2(d.hh)}:${fmt2(d.mm)}　${d.name || '（未命名）'}` }),
      sub,
    ]);

    const sw = el('button', {
      class: 'switch',
      role: 'switch',
      'aria-checked': String(!!d.on),
      'aria-label': `启用第${idx + 1}条`,
      onclick: (e) => {
        e.stopPropagation();
        d.on = !d.on;
        persist();
        renderList();
      },
    }, [el('span', { class: 'knob' })]);

    const item = el('div', { class: 'item', role: 'button', 'aria-label': `编辑 ${d.name || '未命名'}` }, [frame, meta, sw]);
    item.addEventListener('click', () => openEditor(d.id));
    box.append(item);
  });
}

// ---------- 编辑视图 ----------
let _editDays = '1111111';

function openEditor(id) {
  const d = id ? state.drafts.find((x) => x.id === id) : null;
  state.editingId = d ? d.id : null;
  $('#edit-title').textContent = d ? '编辑提醒' : '新建提醒';
  $('#btn-del').hidden = !d;
  $('#f-name').value = d?.name ?? '';
  $('#f-time').value = d ? `${fmt2(d.hh)}:${fmt2(d.mm)}` : '08:00';
  _editDays = d?.days ?? '1111111';
  renderDays();
  setOn(!!(d ? d.on : true));
  updatePreview();
  showView('edit');
  $('#f-name').focus();
}

function renderDays() {
  const box = $('#f-days');
  box.innerHTML = '';
  [...DAY_LABELS].forEach((c, i) => {
    box.append(el('button', {
      class: _editDays[i] === '1' ? 'on' : '',
      type: 'button',
      'aria-pressed': String(_editDays[i] === '1'),
      'aria-label': '周' + c,
      text: c,
      onclick: () => {
        const arr = _editDays.split('');
        arr[i] = arr[i] === '1' ? '0' : '1';
        if (!arr.includes('1')) { toast('至少选一天', 'warn'); return; }
        _editDays = arr.join('');
        renderDays();
      },
    }));
  });
}

function setOn(v) {
  const b = $('#f-on');
  b.setAttribute('aria-checked', String(v));
}

function updatePreview() {
  const name = $('#f-name').value;
  const { bmp, bmp2, truncated } = renderNameBitmap(name);
  drawBitmap($('#pv-4x'), bmp, { scale: 4 });
  drawBitmap($('#pv-1x'), bmp, { scale: 1 });
  drawBitmap($('#pv-1x-2'), bmp2, { scale: 1 });
  $('#pv-1x-2-wrap').hidden = !bmp2;
  const hint = $('#pv-hint');
  if (!bmp) hint.textContent = '空名：工牌只显示时间，不显示名字（契约 §2）';
  else if (truncated) hint.textContent = '⚠ 名字较长：480B 行预算装不下两行宽位图，工牌屏显示为上方截断位图（手机端仍存全名）';
  else hint.textContent = `工牌位图 ${bmp.w}×${bmp.h}px${bmp2 ? ` + 第二行 ${bmp2.w}px` : ''} · 上排 1:1、下排 4×`;
}

function saveEditor() {
  const name = $('#f-name').value.trim();
  if ([...name].length > MAX_NAME_CHARS) { toast(`名字超 ${MAX_NAME_CHARS} 字`, 'err'); return; }
  const [hh, mm] = $('#f-time').value.split(':').map(Number);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) { toast('时间无效', 'err'); return; }
  const on = $('#f-on').getAttribute('aria-checked') === 'true';
  const d = { id: state.editingId ?? genId(), name, hh, mm, days: _editDays, on };
  const idx = state.drafts.findIndex((x) => x.id === d.id);
  if (idx >= 0) state.drafts[idx] = d;
  else {
    if (state.drafts.length >= MAX_REMINDERS) { toast(`最多 ${MAX_REMINDERS} 条（契约槽位 0..7）`, 'err'); return; }
    state.drafts.push(d);
  }
  persist();
  toast('已保存草稿（点「同步到徽章」下发设备）', 'ok');
  showView('list');
}

function deleteDraft() {
  const idx = state.drafts.findIndex((x) => x.id === state.editingId);
  if (idx < 0) return;
  state.drafts.splice(idx, 1);
  persist();
  toast('已删除草稿（设备侧槽位在下次同步时清理）', 'ok');
  showView('list');
}

// ---------- 同步 / 拉取 ----------
async function syncAll() {
  if (state.syncBusy) return;
  const link = state.link;
  if (!link?.connected) { toast('未连接：先在状态栏或设置页连接', 'err'); return; }
  if (state.drafts.length > MAX_REMINDERS) { toast(`超过 ${MAX_REMINDERS} 条上限`, 'err'); return; }
  state.syncBusy = true;
  renderBusy();
  const total = state.drafts.length;
  try {
    for (let i = 0; i < total; i++) {
      const d = state.drafts[i];
      toast(`同步 ${i + 1}/${total}：${d.name || '（未命名）'}`, 'info', 1500);
      await link.request(cmd.set(i, buildReminder(d))); // 契约 §2：逐条 set，内部自带 3s×3 重试
    }
    for (let i = total; i < state.syncedCount; i++) {
      await link.request(cmd.del(i)); // 清掉上次同步多余槽位
    }
    state.syncedCount = total;
    store.saveSyncedCount(total);
    await refreshHello();
    renderList(); // 刷新「已同步 N 条」hint（此前停在旧值）
    toast(`✓ 全部同步成功（${total} 条）`, 'ok');
  } catch (e) {
    toast(`同步失败：${errMsg(e)}`, 'err', 5000);
  } finally {
    state.syncBusy = false;
    renderBusy();
  }
}

async function pullAll() {
  if (state.syncBusy) return;
  const link = state.link;
  if (!link?.connected) { toast('未连接：先连接设备', 'err'); return; }
  state.syncBusy = true;
  renderBusy();
  try {
    const { items } = await link.requestStream(cmd.get()); // 契约 §3：逐条回 + done
    state.drafts = items.map(({ r }) => ({
      id: genId(),
      name: typeof r.name === 'string' ? r.name : '',
      hh: r.hh, mm: r.mm, days: r.days, on: !!r.on,
    }));
    state.syncedCount = state.drafts.length;
    store.saveDrafts(state.drafts);
    store.saveSyncedCount(state.syncedCount);
    await refreshHello(); // 拉取后刷新电量/条数显示
    renderList();
    toast(`✓ 已拉取 ${state.drafts.length} 条`, 'ok');
  } catch (e) {
    toast(`拉取失败：${errMsg(e)}`, 'err', 5000);
  } finally {
    state.syncBusy = false;
    renderBusy();
  }
}

function renderBusy() {
  for (const id of ['#btn-sync', '#btn-pull', '#btn-add']) $(id).disabled = state.syncBusy;
}

// ---------- 设置页 ----------
function renderSettings() {
  // 连接方式段
  for (const b of document.querySelectorAll('#mode-seg .seg-btn')) {
    b.setAttribute('aria-checked', String(b.dataset.mode === state.settings.mode));
  }
  // 设备信息
  const info = $('#dev-info');
  const h = state.hello;
  if (state.link?.connected && h) {
    const drift = h.utc > 0 ? `${Math.round((h.at ?? Date.now()) / 1000 - h.utc)}s` : '--（未校时）';
    info.innerHTML = '';
    const row = (k, v) => info.append(el('div', { class: 'kv-row' }, [
      el('span', { class: 'k', text: k }), el('span', { text: v }),
    ]));
    row('模式', state.link.mode === 'simulated' ? '模拟工牌' : '真实蓝牙');
    row('设备名', state.link.deviceName || state.link.device?.name || '-');
    row('固件', h.fw ?? '-');
    row('电量', (h.bat ?? '-') + '%');
    row('设备条数', String(h.n ?? '-'));
    row('时钟偏差', drift);
    row('时区', `UTC${h.tz >= 0 ? '+' : ''}${(h.tz / 60).toFixed(2)}`);
  } else {
    info.innerHTML = '';
    info.append(el('span', { class: 'hint', text: '未连接' }));
  }
  renderEvents();
  $('#build-info').textContent =
    `静态文件：index.html + style.css + js/{app,protocol,badge-link,bmp,store}.js · 无构建依赖 · 契约 protocol_v1`;
}

function renderEvents() {
  const box = $('#events-box');
  box.innerHTML = '';
  if (!state.events.length) {
    box.append(el('span', { class: 'hint', text: '闹钟触发等事件会显示在这里' }));
    return;
  }
  for (const ev of state.events) {
    box.append(el('div', { class: 'log-row' }, [
      el('span', { class: 't', text: new Date(ev.t).toLocaleTimeString('zh-CN', { hour12: false }) }),
      el('span', { text: ev.text }),
    ]));
  }
}

async function timeSync() {
  const link = state.link;
  if (!link?.connected) { toast('未连接', 'err'); return; }
  try {
    await link.request(cmd.time(Math.floor(Date.now() / 1000), state.settings.tz));
    await refreshHello();
    toast('✓ 已校时（设备时钟对齐手机）', 'ok');
  } catch (e) {
    toast(`校时失败：${errMsg(e)}`, 'err');
  }
}

async function fetchLog() {
  const link = state.link;
  if (!link?.connected) { toast('未连接', 'err'); return; }
  const box = $('#log-box');
  try {
    const e = await link.request(cmd.log());
    box.innerHTML = '';
    const rows = Array.isArray(e.rows) ? e.rows : [];
    if (!rows.length) { box.append(el('span', { class: 'hint', text: '设备暂无服药记录' })); return; }
    const actLabel = { taken: '已服', snooze: '延后', miss: '未服' };
    for (const r of rows.slice().reverse()) {
      const t = r.utc > 0 ? new Date(r.utc * 1000).toLocaleString('zh-CN', { hour12: false }) : '时间未知';
      const who = state.drafts[r.i]?.name || `槽${r.i}`;
      box.append(el('div', { class: 'log-row' }, [
        el('span', { class: 't', text: t }),
        el('span', { text: who }),
        el('span', { class: `tag ${r.act}`, text: actLabel[r.act] ?? r.act }),
      ]));
    }
  } catch (err) {
    box.innerHTML = '';
    box.append(el('span', { class: 'hint', text: '读取失败：' + errMsg(err) }));
  }
}

async function testBell() {
  const link = state.link;
  const box = $('#bell-status');
  if (!link?.connected) { toast('未连接', 'err'); return; }
  try {
    await link.request(cmd.bell());
    box.textContent = `回执 evt:ok —— 设备已响铃（${new Date().toLocaleTimeString('zh-CN', { hour12: false })}）`;
    toast('设备回执 ok：已响铃', 'ok');
  } catch (e) {
    if (e.kind === 'device:audiooff') {
      box.textContent = `回执 evt:err why=audiooff —— 设备音频未启用（静音模式）。本端绝不代发声。`;
      toast('设备音频未启用（err:audiooff）', 'warn');
    } else {
      box.textContent = '失败：' + errMsg(e);
      toast(`铃声请求失败：${errMsg(e)}`, 'err');
    }
  }
}

async function switchMode(mode) {
  if (mode === state.settings.mode) return;
  state.settings.mode = mode;
  store.saveSettings(state.settings);
  cancelReconnect();
  createLink(mode);
  renderConn();
  renderSettings();
  if (mode === 'ble') {
    if (!BleLink.available()) {
      toast('此浏览器不支持 Web Bluetooth，回退模拟模式', 'err', 4000);
      return switchMode('sim');
    }
    await connect(); // 用户手势内发起 requestDevice
  } else {
    await connect();
    toast('已切换到模拟工牌', 'ok');
  }
}

async function wipe() {
  // 二次确认用两段式按钮文案，避免弹窗
  const b = $('#btn-wipe');
  if (b.dataset.armed !== '1') {
    b.dataset.armed = '1';
    b.textContent = '再点一次确认清空';
    setTimeout(() => { b.dataset.armed = ''; b.textContent = '清空本页草稿与设置'; }, 3000);
    return;
  }
  store.clearAll();
  state.drafts = [];
  state.syncedCount = 0;
  state.settings = store.loadSettings();
  state.events = [];
  cancelReconnect();
  createLink(state.settings.mode);
  renderAll();
  if (state.settings.mode === 'sim') await connect();
  toast('已清空并恢复默认', 'ok');
}

// ---------- NFC 页 ----------
function buildBadgeUrl() {
  const id = ($('#nfc-badge-id')?.value || state.settings.badgeId || 'SN01').trim() || 'SN01';
  return `${location.origin}${location.pathname}?b=${encodeURIComponent(id)}`;
}

function renderNfc() {
  const supported = typeof window !== 'undefined' && 'NDEFReader' in window;
  $('#nfc-supported').hidden = !supported;
  $('#nfc-unsupported').hidden = supported;
  $('#nfc-url').textContent = buildBadgeUrl();
  if (!supported) drawQrFallback();
  const st = $('#nfc-status');
  if (supported) st.textContent = '✓ 本环境支持 Web NFC（写入仍需 Android Chrome + 用户手势 + 前台）';
  else st.textContent = '桌面环境：仅可生成入口 URI / 二维码；真机写入流程见早晨清单';
}

async function nfcWrite() {
  const box = $('#nfc-status');
  if (!('NDEFReader' in window)) return; // 桌面降级页不会显示该按钮，防御
  const uri = buildBadgeUrl();
  try {
    box.textContent = '等待标签…请贴紧工牌标签';
    const ndef = new NDEFReader();
    await ndef.write({ records: [{ recordType: 'url', data: uri }] }); // 契约 §3 的 URL 格式
    // 写入成功 → 读回核对：开新扫描会话，等用户再碰一次（Unverified：仅真机可达）
    box.textContent = '✓ 已写入。再碰一次标签核对内容…';
    toast('已写入，再碰一次核对', 'info');
    const rd = new NDEFReader();
    await rd.scan();
    const verdict = await new Promise((resolve) => {
      const to = setTimeout(() => resolve({ ok: false, why: '15s 内未再读到标签' }), 15000);
      rd.addEventListener('reading', (e) => {
        clearTimeout(to);
        const got = parseNdefUrl(e.message.records);
        resolve(got === null
          ? { ok: false, why: '标签上没有 URI 记录' }
          : { ok: got === uri, read: got });
      }, { once: true });
    });
    if (verdict.ok) {
      box.textContent = '✓ 写入并读回核对一致：' + uri;
      toast('✓ NFC 写入核验通过', 'ok');
    } else {
      box.textContent = `⚠ 读回不一致（读到：${verdict.read ?? verdict.why}）——建议重写或检查标签锁状态`;
      toast('⚠ NFC 读回不一致', 'err', 4000);
    }
  } catch (e) {
    box.textContent = '写入失败：' + (e?.message || e);
    toast('NFC 写入失败：' + (e?.message || e), 'err', 4000);
  }
}

async function copyUrl() {
  const url = buildBadgeUrl();
  try {
    await navigator.clipboard.writeText(url);
    toast('已复制：' + url, 'ok');
  } catch {
    toast('复制失败，请手动选择文本', 'err');
  }
}

/** 降级二维码：内联实现（js/vendor/qr.js，MIT）；失败则提示手动复制 */
function drawQrFallback() {
  const cv = $('#qr-canvas');
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(buildBadgeUrl());
    qr.make();
    const n = qr.getModuleCount();
    const cell = Math.floor(Math.min(cv.width, cv.height) / (n + 8));
    const off = Math.floor((cv.width - cell * n) / 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = '#111111';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(off + c * cell, off + r * cell, cell, cell);
      }
    }
  } catch (e) {
    ctx.fillStyle = '#888';
    ctx.font = '12px sans-serif';
    ctx.fillText('二维码生成失败：' + (e?.message || e), 10, 110);
  }
}

// ---------- 视图路由 ----------
const VIEWS = ['list', 'edit', 'nfc', 'settings'];

function showView(name) {
  if (!VIEWS.includes(name)) name = 'list';
  state.view = name;
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== 'view-' + name;
  for (const t of document.querySelectorAll('.tab')) {
    t.classList.toggle('active', t.dataset.nav === name);
  }
  if (name === 'list') renderList();
  if (name === 'edit') updatePreview(); // hash 直进编辑页时初始化预览画布（否则保持 300×150 空框）
  if (name === 'nfc') renderNfc();
  if (name === 'settings') renderSettings();
  const hash = name === 'list' ? '' : '#' + name;
  if (location.hash !== hash) history.replaceState(null, '', hash || location.pathname + location.search);
  window.scrollTo(0, 0);
}

// ---------- 渲染总入口 ----------
function renderAll() {
  renderConn();
  renderList();
  renderSettings();
  showView(location.hash ? location.hash.slice(1) : 'list');
}

// ---------- 事件绑定 ----------
function bindUI() {
  $('#btn-add').addEventListener('click', () => openEditor(null));
  $('#btn-back').addEventListener('click', () => showView('list'));
  $('#edit-form').addEventListener('submit', (e) => { e.preventDefault(); saveEditor(); });
  $('#btn-del').addEventListener('click', deleteDraft);
  $('#f-name').addEventListener('input', updatePreview);
  $('#f-name').addEventListener('input', () => {
    // 名字超长即时提示（契约 name ≤14）
    const n = [...$('#f-name').value].length;
    if (n > MAX_NAME_CHARS) $('#f-name').value = [...$('#f-name').value].slice(0, MAX_NAME_CHARS).join('');
  });
  $('#f-on').addEventListener('click', () => {
    const b = $('#f-on');
    setOn(b.getAttribute('aria-checked') !== 'true');
  });
  $('#btn-sync').addEventListener('click', syncAll);
  $('#btn-pull').addEventListener('click', pullAll);
  $('#conn-chip').addEventListener('click', () => {
    if (state.link?.connected) showView('settings');
    else connect({ reuse: state.settings.mode === 'ble' });
  });
  for (const t of document.querySelectorAll('.tab')) {
    t.addEventListener('click', () => showView(t.dataset.nav));
  }
  document.querySelectorAll('#mode-seg .seg-btn').forEach((b) => {
    b.addEventListener('click', () => switchMode(b.dataset.mode));
  });
  $('#btn-connect').addEventListener('click', () => connect({ reuse: state.settings.mode === 'ble' }));
  $('#btn-simdrop').addEventListener('click', () => {
    if (state.link?.mode === 'simulated' && state.link.connected) {
      state.link.dropConnection(); // onStatus → 自动重连演示
      toast('已注入断连，观察自动重连', 'info');
    }
  });
  $('#btn-time').addEventListener('click', timeSync);
  $('#btn-log').addEventListener('click', fetchLog);
  $('#btn-bell').addEventListener('click', testBell);
  $('#btn-wipe').addEventListener('click', wipe);
  $('#btn-nfc-write').addEventListener('click', nfcWrite);
  $('#btn-copy-url').addEventListener('click', copyUrl);
  $('#nfc-badge-id').addEventListener('input', () => {
    $('#nfc-url').textContent = buildBadgeUrl();
    if ('NDEFReader' in window) return;
    drawQrFallback();
  });
  window.addEventListener('hashchange', () => {
    const name = location.hash ? location.hash.slice(1) : 'list';
    if (name !== state.view) showView(name);
  });
  // 全局错误兜底：让用户看得见，而不是静默失败
  window.addEventListener('unhandledrejection', (e) => {
    toastOnce('unhandled', '未处理异常：' + errMsg(e.reason), 'err');
  });
}

// ---------- 启动 ----------
async function boot() {
  bindUI();
  // ?b=<badgeId>：碰标签进来时识别徽章（契约 PHONE_APP_DEV §1：NFC 只做入口+身份）
  const b = new URLSearchParams(location.search).get('b');
  if (b) {
    state.settings.badgeId = b.trim().slice(0, 24);
    store.saveSettings(state.settings);
  }
  $('#nfc-badge-id').value = state.settings.badgeId;
  // ?demo=1 真机调试钩子：填充 3 条经典名 + 1 条"当前时刻"提醒（等模拟 ticker 自然触发 fired）
  if (new URLSearchParams(location.search).get('demo')) {
    const now = new Date();
    const nextMin = new Date(Date.now() + 60_000); // 下一分钟触发：给"打开→同步"留出窗口
    const demoList = [
      { id: 'demo-amox', name: '阿莫西林', hh: 8, mm: 0, days: '1111100', on: true },
      { id: 'demo-ibup', name: '布洛芬缓释胶囊', hh: 12, mm: 30, days: '1111111', on: true },
      { id: 'demo-vitd', name: '维生素 D3', hh: 20, mm: 0, days: '1111111', on: true },
      { id: 'demo-now', name: '此刻测试', hh: nextMin.getHours(), mm: nextMin.getMinutes(), days: '1111111', on: true },
    ];
    for (const d of demoList) {
      const idx = state.drafts.findIndex((x) => x.id === d.id);
      if (idx >= 0) state.drafts[idx] = { ...d }; // upsert：重开时"此刻测试"刷新为当前分钟
      else state.drafts.push(d);
    }
    if (state.drafts.length > MAX_REMINDERS) state.drafts = state.drafts.slice(-MAX_REMINDERS);
    store.saveDrafts(state.drafts);
  }
  renderAll();
  // 默认连模拟（无需手势）；真实蓝牙等用户点击（requestDevice 须手势）
  if (state.settings.mode === 'sim') await connect();
  // Service Worker（可选离线缓存；http.server 下注册失败也无碍）
  if ('serviceWorker' in navigator && location.protocol === 'http:') {
    try { await navigator.serviceWorker.register('sw.js'); } catch { /* 忽略 */ }
  }
}

boot().catch((e) => {
  // boot 失败必须可见，不允许静默白板
  const box = document.getElementById('toasts');
  if (box) box.append(el('div', { class: 'toast err', text: '启动失败：' + errMsg(e) }));
});
