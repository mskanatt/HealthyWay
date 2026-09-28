(function () {
  "use strict";

  const HISTORY_KEY = "healthyway_history_v1";
  const MAX_ENTRIES = 200; // keep localStorage from growing without bound
  const THUMB_MAX_DIM = 160; // px, keeps each saved image small
  const LOCALE = "ru-RU";

  /** Russian plural forms: plural(1, "блюдо", "блюда", "блюд") -> "блюдо" */
  function plural(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  const mealsWord = (n) => plural(n, "блюдо", "блюда", "блюд");

  // ---------------- tab switching ----------------

  const tabPanels = document.querySelectorAll("[data-tab-panel]");
  const navButtons = document.querySelectorAll(".bottom-nav-btn");
  const gotoButtons = document.querySelectorAll("[data-goto]");

  function showTab(tabName) {
    tabPanels.forEach((panel) => {
      panel.hidden = panel.dataset.tabPanel !== tabName;
    });
    navButtons.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tabName);
    });
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });

    if (tabName === "profile") renderProfileTab();
    if (tabName === "home") renderHomeToday();
  }

  navButtons.forEach((btn) => {
    btn.addEventListener("click", () => showTab(btn.dataset.tab));
  });
  gotoButtons.forEach((btn) => {
    btn.addEventListener("click", () => showTab(btn.dataset.goto));
  });

  showTab("home"); // default tab on load

  // ---------------- storage helpers ----------------

  function getHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return []; // corrupted or blocked storage — fail quietly, don't crash the page
    }
  }

  function saveHistory(entries) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
      return true;
    } catch {
      // Most likely quota exceeded. Drop the oldest half and try once more.
      try {
        const trimmed = entries.slice(0, Math.floor(entries.length / 2));
        localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
        return true;
      } catch {
        return false;
      }
    }
  }

  /** Shrinks an image file down to a small square-ish JPEG for storage. */
  function makeThumbnail(file) {
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const scale = THUMB_MAX_DIM / Math.max(img.width, img.height);
        const w = Math.round(img.width * Math.min(1, scale));
        const h = Math.round(img.height * Math.min(1, scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", 0.6));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null); // no thumbnail — history entry still saves, just without a photo
      };
      img.src = url;
    });
  }

  /**
   * Adds one scan to history. Called by app.js right after a successful result.
   * type: "food" | "body"
   * data: the parsed backend response (same shape shown in the result card)
   * file: the original File object, used only to build a small thumbnail
   */
  async function addEntry(type, data, file) {
    const thumbnail = file ? await makeThumbnail(file) : null;
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      timestamp: Date.now(),
      thumbnail,
      data,
    };
    const entries = getHistory();
    entries.unshift(entry); // newest first
    saveHistory(entries.slice(0, MAX_ENTRIES));
    renderHomeToday();
    return entry;
  }

  function deleteEntry(id) {
    const entries = getHistory().filter((e) => e.id !== id);
    saveHistory(entries);
    renderProfileTab();
    renderHomeToday();
  }

  function clearAll() {
    saveHistory([]);
    renderProfileTab();
    renderHomeToday();
  }

  // ---------------- rendering ----------------

  function isSameDay(ts, ref) {
    const a = new Date(ts);
    const b = new Date(ref);
    return a.toDateString() === b.toDateString();
  }

  function dayLabel(ts) {
    const now = new Date();
    const d = new Date(ts);
    if (isSameDay(ts, now)) return "Сегодня";
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (isSameDay(ts, yesterday)) return "Вчера";
    return d.toLocaleDateString(LOCALE, { month: "short", day: "numeric" });
  }

  function timeLabel(ts) {
    return new Date(ts).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
  }

  function todaysFoodTotals() {
    const now = Date.now();
    const totals = { calories: 0, protein: 0, fat: 0, carbs: 0, count: 0 };
    for (const e of getHistory()) {
      if (e.type !== "food") continue;
      if (!isSameDay(e.timestamp, now)) continue;
      totals.calories += Number(e.data.calories) || 0;
      totals.protein += Number(e.data.proteinGrams) || 0;
      totals.fat += Number(e.data.fatGrams) || 0;
      totals.carbs += Number(e.data.carbsGrams) || 0;
      totals.count += 1;
    }
    return totals;
  }

  function renderHomeToday() {
    const el = document.getElementById("home-today");
    if (!el) return;
    const t = todaysFoodTotals();
    if (t.count === 0) {
      el.innerHTML = `<p class="home-today-empty">Сегодня пока ничего не записано — отсканируйте блюдо, чтобы начать учёт.</p>`;
      return;
    }
    el.innerHTML = `
      <h3 class="home-today-title">Сегодня на данный момент</h3>
      <div class="macro-grid">
        <div class="macro-cell macro-cal"><span class="macro-value">${Math.round(t.calories)}</span><span class="macro-label">ккал</span></div>
        <div class="macro-cell"><span class="macro-value">${Math.round(t.protein)} г</span><span class="macro-label">белки</span></div>
        <div class="macro-cell"><span class="macro-value">${Math.round(t.fat)} г</span><span class="macro-label">жиры</span></div>
        <div class="macro-cell"><span class="macro-value">${Math.round(t.carbs)} г</span><span class="macro-label">углеводы</span></div>
      </div>
      <p class="home-today-sub">Отсканировано сегодня: ${t.count} ${mealsWord(t.count)}</p>
    `;
  }

  function entryLine(entry) {
    const thumb = entry.thumbnail
      ? `<img class="profile-thumb" src="${entry.thumbnail}" alt="" />`
      : `<div class="profile-thumb profile-thumb-empty"></div>`;

    let title, detail;
    if (entry.type === "food") {
      title = entry.data.foodName || "Блюдо не распознано";
      // Б / Ж / У = белки / жиры / углеводы
      detail = `${Math.round(entry.data.calories ?? 0)} ккал · Б${Math.round(entry.data.proteinGrams ?? 0)} Ж${Math.round(entry.data.fatGrams ?? 0)} У${Math.round(entry.data.carbsGrams ?? 0)}`;
    } else {
      title = "Оценка состава тела";
      detail = `${entry.data.rangeLow ?? "--"}–${entry.data.rangeHigh ?? "--"}% · ${entry.data.category || ""}`;
    }

    return `
      <div class="profile-entry" data-id="${entry.id}">
        ${thumb}
        <div class="profile-entry-info">
          <p class="profile-entry-title">${title}</p>
          <p class="profile-entry-detail">${detail}</p>
        </div>
        <span class="profile-entry-time">${timeLabel(entry.timestamp)}</span>
        <button class="profile-entry-delete" data-delete-id="${entry.id}" aria-label="Удалить">✕</button>
      </div>
    `;
  }

  function renderProfileTab() {
    const listEl = document.getElementById("profile-list");
    const emptyEl = document.getElementById("profile-empty");
    const summaryEl = document.getElementById("profile-summary");
    if (!listEl) return;

    const entries = getHistory();

    if (entries.length === 0) {
      listEl.innerHTML = "";
      emptyEl.hidden = false;
      summaryEl.innerHTML = "";
      return;
    }
    emptyEl.hidden = true;

    const t = todaysFoodTotals();
    summaryEl.innerHTML = t.count
      ? `<p class="profile-summary-text">Сегодня записано <strong>${Math.round(t.calories)} ккал</strong> (${t.count} ${mealsWord(t.count)})</p>`
      : "";

    // group by day label, preserving newest-first order
    const groups = [];
    let currentLabel = null;
    for (const entry of entries) {
      const label = dayLabel(entry.timestamp);
      if (label !== currentLabel) {
        groups.push({ label, items: [] });
        currentLabel = label;
      }
      groups[groups.length - 1].items.push(entry);
    }

    listEl.innerHTML = groups
      .map(
        (g) => `
        <div class="profile-day-group">
          <h4 class="profile-day-label">${g.label}</h4>
          ${g.items.map(entryLine).join("")}
        </div>
      `
      )
      .join("");

    listEl.querySelectorAll("[data-delete-id]").forEach((btn) => {
      btn.addEventListener("click", () => deleteEntry(btn.dataset.deleteId));
    });
  }

  const clearBtn = document.getElementById("profile-clear-btn");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (confirm("Удалить все сохранённые сканы на этом устройстве? Это действие нельзя отменить.")) {
        clearAll();
      }
    });
  }

  renderHomeToday();

  // Exposed so app.js can add an entry right after a successful analyze call.
  window.HealthyWayHistory = { addEntry };
})();
