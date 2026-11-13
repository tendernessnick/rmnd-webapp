// store.js —— localStorage 持久化（草稿 / 设置 / 上次同步槽位数）。
// 全部走 try/catch：隐身模式或存储被禁时降级为内存行为，不阻塞主流程。

const PREFIX = 'rmnd.v1.';

export function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw == null) return fallback;
    const v = JSON.parse(raw);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

export function saveJSON(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeKey(key) {
  try { localStorage.removeItem(PREFIX + key); } catch { /* 忽略 */ }
}

function defaultSettings() {
  return {
    mode: 'sim',                                        // 'sim' | 'ble'
    tz: -new Date().getTimezoneOffset(),                // 东八区 = 480（契约 §2）
    badgeId: '',                                        // ?b= 参数记忆（NFC 入口联动）
  };
}

export const store = {
  /** 草稿：[{id, name, hh, mm, days:'1111100', on}]，最多 8 条（契约 §2 槽位 0..7） */
  loadDrafts() {
    const v = loadJSON('drafts', []);
    return Array.isArray(v) ? v.filter((d) => d && typeof d === 'object') : [];
  },
  saveDrafts(list) { return saveJSON('drafts', list); },

  loadSettings() {
    const s = loadJSON('settings', defaultSettings());
    return { ...defaultSettings(), ...s };
  },
  saveSettings(s) { return saveJSON('settings', s); },

  /** 上次成功同步的条数：下次同步时用来清理设备上的多余槽位 */
  loadSyncedCount() {
    const n = loadJSON('syncedCount', 0);
    return Number.isInteger(n) && n >= 0 && n <= 8 ? n : 0;
  },
  saveSyncedCount(n) { return saveJSON('syncedCount', n); },

  clearAll() {
    removeKey('drafts');
    removeKey('syncedCount');
    removeKey('settings');
  },
};
