const App = (() => {
  const state = {
    words: [],
    deck: [],
    currentIndex: 0,
    seen: new Set(),
    filter: "all",

    // Search (all languages). Search activates at 3+ characters.
    searchQuery: "",
    fuse: null
  };

  const dom = {};

  function cacheDom() {
    [
      "card", "cardWrap", "typeBadge", "frontWord",
      "backEcho", "backContent",
      "cardNum", "totalCards", "seenCount", "progressFill",
      "btnNext", "btnPrev", "btnShuffle",
      "searchInput", "searchClear"
    ].forEach(id => dom[id] = document.getElementById(id));

    dom.filterButtons = document.querySelectorAll(".filter-btn");
  }

  function norm(s) {
    return (s ?? "")
      .toString()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  function buildSearchText(w) {
    // Include everything reasonably searchable across languages.
    // Adjective gender forms and noun articles included.
    const parts = [
      w.en, w.fr, w.es, w.it, w.lat,
      w.fr_art, w.es_art, w.it_art,
      w.fr_m, w.fr_f, w.es_m, w.es_f, w.it_m, w.it_f
    ];
    return norm(parts.filter(Boolean).join(" | "));
  }

  function initFuse() {
    // Fuse.js is loaded via CDN; if unavailable (offline), we fall back.
    if (typeof window.Fuse !== "function") {
      state.fuse = null;
      return;
    }

    state.fuse = new window.Fuse(state.words, {
      includeScore: true,
      ignoreLocation: true,
      threshold: 0.35,
      minMatchCharLength: 3,
      keys: ["_search"]
    });
  }

  async function loadWords() {
    try {
      const res = await fetch("words.json");
      const raw = await res.json();

      state.words = raw.map(w => ({
        ...w,
        _search: buildSearchText(w)
      }));

      initFuse();
      initializeDeck();
    } catch {
      dom.frontWord.textContent = "Failed to load words.json";
    }
  }

  function shuffle(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function applyTypeFilter(indices) {
    return indices.filter(i =>
      state.filter === "all" || state.words[i]?.type === state.filter
    );
  }

  function searchIndices(queryNorm) {
    // Search activates at 3+ chars (per requirement).
    if (queryNorm.length < 3) {
      return state.words.map((_, i) => i);
    }

    // 1) Fuse (online / when loaded)
    if (state.fuse) {
      return state.fuse.search(queryNorm).map(r => r.refIndex);
    }

    // 2) Offline fallback: lightweight fuzzy scoring
    return offlineSearch(queryNorm);
  }

  function offlineSearch(q) {
    // Goal: good enough when offline. Not magic.
    // Strategy:
    // - Exact substring match: strong
    // - Token overlap: medium
    // - Near-match via small edit distance against tokens: weak
    const qTokens = q.split(/\s+/).filter(Boolean);
    const results = [];

    for (let i = 0; i < state.words.length; i++) {
      const hay = state.words[i]._search || "";
      if (!hay) continue;

      let score = Infinity;

      const pos = hay.indexOf(q);
      if (pos !== -1) {
        // Earlier position = better
        score = 0 + pos / 10000;
      } else {
        // Token overlap
        let hits = 0;
        for (const t of qTokens) if (t.length >= 3 && hay.includes(t)) hits++;
        if (hits > 0) {
          score = 1 - hits / Math.max(1, qTokens.length);
        } else {
          // Very small edit distance against individual tokens (bounded cost)
          const best = bestTokenDistance(q, hay);
          if (best <= 2) score = 2 + best / 10;
        }
      }

      if (score !== Infinity) results.push({ i, score });
    }

    results.sort((a, b) => a.score - b.score);
    return results.map(r => r.i);
  }

  function bestTokenDistance(q, hay) {
    // Compare q to a limited set of tokens to keep it fast.
    const tokens = hay.split(/[^a-z0-9]+/).filter(t => t.length >= 3);
    let best = 99;
    const limit = Math.min(tokens.length, 80);

    for (let k = 0; k < limit; k++) {
      const t = tokens[k];
      // Quick bound: if length diff > 2, skip (since we only care <=2)
      if (Math.abs(t.length - q.length) > 2) continue;
      const d = levenshteinBounded(q, t, 2);
      if (d < best) best = d;
      if (best === 0) return 0;
    }

    return best;
  }

  function levenshteinBounded(a, b, max) {
    // Bounded Levenshtein distance; returns max+1 if exceeds max.
    const al = a.length, bl = b.length;
    if (Math.abs(al - bl) > max) return max + 1;
    if (al === 0) return bl <= max ? bl : max + 1;
    if (bl === 0) return al <= max ? al : max + 1;

    const prev = new Array(bl + 1);
    const cur = new Array(bl + 1);

    for (let j = 0; j <= bl; j++) prev[j] = j;

    for (let i = 1; i <= al; i++) {
      cur[0] = i;
      let rowMin = cur[0];
      const ai = a.charCodeAt(i - 1);

      for (let j = 1; j <= bl; j++) {
        const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
        const val = Math.min(
          prev[j] + 1,
          cur[j - 1] + 1,
          prev[j - 1] + cost
        );
        cur[j] = val;
        if (val < rowMin) rowMin = val;
      }

      if (rowMin > max) return max + 1;

      for (let j = 0; j <= bl; j++) prev[j] = cur[j];
    }

    return prev[bl] <= max ? prev[bl] : max + 1;
  }

  function initializeDeck() {
    const q = norm(state.searchQuery);
    let indices = searchIndices(q);
    indices = applyTypeFilter(indices);

    state.deck = shuffle(indices);
    state.currentIndex = 0;

    dom.totalCards.textContent = state.deck.length;

    if (state.deck.length) {
      render();
    } else {
      renderEmpty();
    }
  }

  function renderEmpty() {
    dom.card.classList.remove("flipped");
    dom.typeBadge.textContent = "";
    dom.typeBadge.className = "type-badge";
    dom.frontWord.textContent = "No matches";
    dom.backEcho.textContent = "";
    dom.backContent.innerHTML = "";
    dom.cardNum.textContent = "0";
  }

  function render() {
    const word = state.words[state.deck[state.currentIndex]];
    if (!word) return;

    dom.card.classList.remove("flipped");

    renderFront(word);
    renderBack(word);

    dom.cardNum.textContent = state.currentIndex + 1;

    state.seen.add(state.deck[state.currentIndex]);
    dom.seenCount.textContent = state.seen.size;
    dom.progressFill.style.width =
      (state.seen.size / state.words.length) * 100 + "%";
  }

  function renderFront(word) {
    dom.typeBadge.textContent = word.type;
    dom.typeBadge.className = `type-badge ${word.type}`;

    dom.frontWord.textContent =
      word.type === "noun"
        ? (word.en || "").replace(/^the\s+/i, "")
        : (word.en || "");
  }

  function renderBack(word) {
    dom.backEcho.textContent = word.en || "";
    dom.backContent.innerHTML = buildBack(word);
  }

  function buildBack(word) {
    const builders = {
      noun: buildNoun,
      adj: buildAdjective,
      verb: buildPhrase,
      phrase: buildPhrase
    };
    return (builders[word.type] || buildPhrase)(word);
  }

  function translationRow(label, cls, html, speakText, speakLang, extraButtonsHtml = "") {
    const speakBtn = speakLang
      ? `<button class="speak-btn" data-text="${escapeAttr(speakText)}" data-lang="${escapeAttr(speakLang)}" title="Listen">🔊</button>`
      : "";

    return `
      <div class="translation-row">
        <div class="flag-label ${cls}">${label}</div>
        <div class="translation-text">${html}</div>
        ${extraButtonsHtml}${speakBtn}
      </div>
    `;
  }

  function escapeAttr(s) {
    return (s ?? "").toString()
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function buildNoun(w) {
    return [
      translationRow("French", "fr", `<span class="art">${w.fr_art ?? ""}</span> ${w.fr ?? ""}`, `${w.fr_art ?? ""} ${w.fr ?? ""}`.trim(), "fr-FR"),
      translationRow("Spanish", "es", `<span class="art">${w.es_art ?? ""}</span> ${w.es ?? ""}`, `${w.es_art ?? ""} ${w.es ?? ""}`.trim(), "es-ES"),
      translationRow("Italian", "it", `<span class="art">${w.it_art ?? ""}</span> ${w.it ?? ""}`, `${w.it_art ?? ""} ${w.it ?? ""}`.trim(), "it-IT"),
      translationRow("Latin", "lat", `${w.lat ?? ""}`, "", "")
    ].join("");
  }

  function buildAdjective(w) {
    return [
      adjRow("French", "fr", w.fr_m, w.fr_f, "fr-FR"),
      adjRow("Spanish", "es", w.es_m, w.es_f, "es-ES"),
      adjRow("Italian", "it", w.it_m, w.it_f, "it-IT"),
      translationRow("Root", "lat", w.lat)
    ].join("");
  }

  function adjRow(label, cls, masc, fem, lang) {
    return `
    <div class="translation-row">
      <div class="flag-label ${cls}">${label}</div>
      <div class="translation-text adj-forms">
        <div class="adj-line">
          <span class="gl">M</span>
          <span>${masc}</span>
          <button class="speak-btn"
                  data-text="${masc}"
                  data-lang="${lang}">🔊</button>
        </div>
        <div class="adj-line">
          <span class="gl">F</span>
          <span>${fem}</span>
          <button class="speak-btn"
                  data-text="${fem}"
                  data-lang="${lang}">🔊</button>
        </div>
      </div>
    </div>
  `;
  }
  function buildPhrase(w) {
    return [
      translationRow("French", "fr", `${w.fr ?? ""}`, `${w.fr ?? ""}`, "fr-FR"),
      translationRow("Spanish", "es", `${w.es ?? ""}`, `${w.es ?? ""}`, "es-ES"),
      translationRow("Italian", "it", `${w.it ?? ""}`, `${w.it ?? ""}`, "it-IT"),
      translationRow("Latin", "lat", `${w.lat ?? ""}`, "", "")
    ].join("");
  }

  function speak(text, lang) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = 0.85;
    speechSynthesis.speak(u);
  }

  function bindEvents() {
    dom.cardWrap.addEventListener("click", () => dom.card.classList.toggle("flipped"));

    dom.btnNext.addEventListener("click", (e) => { e.stopPropagation(); next(); });
    dom.btnPrev.addEventListener("click", (e) => { e.stopPropagation(); prev(); });
    dom.btnShuffle.addEventListener("click", (e) => { e.stopPropagation(); reshuffle(); });

    dom.filterButtons.forEach(btn => {
      btn.addEventListener("click", () => {
        dom.filterButtons.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        state.filter = btn.dataset.type;
        initializeDeck();
      });
    });

    dom.searchInput?.addEventListener("input", () => {
      state.searchQuery = dom.searchInput.value;
      initializeDeck();
    });

    dom.searchClear?.addEventListener("click", () => {
      dom.searchInput.value = "";
      state.searchQuery = "";
      initializeDeck();
    });

    // Delegated speak buttons (prevents inline onclick)
    dom.backContent.addEventListener("click", (e) => {
      const btn = e.target.closest(".speak-btn");
      if (!btn) return;
      e.stopPropagation();
      speak(btn.dataset.text || "", btn.dataset.lang || "");
    });

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if (e.key === " ") {
        e.preventDefault();
        dom.card.classList.toggle("flipped");
      }
      if (e.key === "ArrowRight" || e.key === "Enter") next();
      if (e.key === "ArrowLeft") prev();
      if (e.key === "s" || e.key === "S") reshuffle();
    });

    // Touch swipe navigation
    let tx = 0;
    dom.cardWrap.addEventListener("touchstart", (e) => {
      tx = e.changedTouches[0].screenX;
    }, { passive: true });

    dom.cardWrap.addEventListener("touchend", (e) => {
      const d = e.changedTouches[0].screenX - tx;
      if (Math.abs(d) > 60) d < 0 ? next() : prev();
    }, { passive: true });
  }

  function next() {
    if (!state.deck.length) return;
    state.currentIndex = (state.currentIndex + 1) % state.deck.length;
    render();
  }

  function prev() {
    if (!state.deck.length) return;
    state.currentIndex = (state.currentIndex - 1 + state.deck.length) % state.deck.length;
    render();
  }

  function reshuffle() {
    state.deck = shuffle(state.deck);
    state.currentIndex = 0;
    if (state.deck.length) render();
  }

  function init() {
    cacheDom();
    bindEvents();
    loadWords();
  }

  return { init };
})();

document.addEventListener("DOMContentLoaded", App.init);
