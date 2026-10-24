const DEFAULTS = { mode: "hybrid" };

export async function getSettings() {
  try {
    const data = await chrome.storage.local.get("settings");
    return { ...DEFAULTS, ...(data.settings || {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveSettings(partial) {
  try {
    const current = await getSettings();
    const next = { ...current, ...partial };
    await chrome.storage.local.set({ settings: next });
    return next;
  } catch {
    return { ...DEFAULTS, ...partial };
  }
}