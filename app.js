const App = (() => {
  const state = {
    words: [],
    deck: [],
    currentIndex: 0,
    seen: new Set(),
    filter: "all",
    frontLang: "en",
    blindMode: false,

    // Search (all languages). Search activates at 3+ characters.
    searchQuery: "",
    searchOpen: false,
    fuse: null
  };

  const dom = {};

  function cacheDom() {
    [
      "card", "cardWrap", "typeBadge", "frontWord",
      "backEcho", "backContent",
      "cardNum", "totalCards", "seenCount", "progressFill",
      "btnNext", "btnPrev", "btnSearch", "btnShuffle",
      "searchOverlay", "searchPanel", "searchInput", "searchClear", "searchSuggestions"
    ].forEach(id => dom[id] = document.getElementById(id));

    dom.filterButtons = document.querySelectorAll(".filter-btn");
    dom.langButtons = document.querySelectorAll(".lang-btn");
    dom.btnBlind = document.getElementById("btnBlind");
    dom.blindSpeakBtn = document.getElementById("blindSpeakBtn");
    dom.frontHint = document.getElementById("frontHint");
  }

  function norm(s) {
    return (s ?? "")
      .toString()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }


  function isSearchActive() {
    // Treat search as active if the input is focused OR suggestions are visible OR searchOpen flag is true.
    const ae = document.activeElement;
    if (state.searchOpen) return true;
    if (dom.searchInput && ae === dom.searchInput) return true;
    if (dom.searchSuggestions && !dom.searchSuggestions.hidden) return true;
    return false;
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
      const res = await fetch("words.json?v=2");
      const raw = await res.json();

      state.words = raw.map((w, i) => ({
        ...w,
        __i: i,
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
      return state.fuse.search(queryNorm)
        .map(r => (Number.isInteger(r.refIndex) ? r.refIndex : r.item?.__i))
        .filter(i => Number.isInteger(i));
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
    // Deck is independent of search; search is suggestions-only until a selection is made.
    let indices = state.words.map((_, i) => i);
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


  function escapeHtml(s) {
    return (s ?? "").toString()
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderSuggestions(indices) {
    if (!dom.searchSuggestions) return;
    if (!state.searchOpen) {
      dom.searchSuggestions.hidden = true;
      dom.searchSuggestions.innerHTML = "";
      return;
    }

    const q = norm(state.searchQuery);

    if (q.length < 3) {
      dom.searchSuggestions.hidden = true;
      dom.searchSuggestions.innerHTML = "";
      return;
    }

    const max = 8;
    const items = indices.slice(0, max).map(i => state.words[i]).filter(Boolean);

    if (!items.length) {
      dom.searchSuggestions.hidden = true;
      dom.searchSuggestions.innerHTML = "";
      return;
    }

    const panel = items.map(w => {
      const title = w.type === "noun"
        ? (w.en || "").replace(/^the\s+/i, "")
        : (w.en || "");
      const sub = [w.fr, w.es, w.it].filter(Boolean).join(" · ");
      const dataIdx = w.__i;
      return `
        <button type="button" class="suggestion-item" data-idx="${dataIdx}">
          <span class="s-type">${escapeHtml(w.type || "")}</span>
          <span class="s-main">${escapeHtml(title)}</span>
          <span class="s-sub">${escapeHtml(sub)}</span>
        </button>
      `;
    }).join("");

    dom.searchSuggestions.innerHTML = `<div class="suggestions-panel">${panel}</div>`;
    dom.searchSuggestions.hidden = false;
  }

  function updateSuggestions() {
    const q = norm(state.searchQuery);
    // Only suggest when search is open; otherwise keep hidden.
    if (!state.searchOpen) {
      if (dom.searchSuggestions) {
        dom.searchSuggestions.hidden = true;
        dom.searchSuggestions.innerHTML = "";
      }
      return;
    }
    let indices = searchIndices(q);
    // Respect current type filter for suggestions (keeps results sane).
    indices = applyTypeFilter(indices);
    renderSuggestions(indices);
  }

  function openSearch() {
    state.searchOpen = true;
    if (dom.searchOverlay) {
      dom.searchOverlay.hidden = false;
      dom.searchOverlay.setAttribute("aria-hidden", "false");
    }
    // Do NOT rebuild the deck; search is non-destructive until a selection is made.
    updateSuggestions();
    dom.searchInput?.focus();
  }

  function closeSearch() {
    state.searchOpen = false;
    if (dom.searchOverlay) {
      dom.searchOverlay.hidden = true;
      dom.searchOverlay.setAttribute("aria-hidden", "true");
    }
    if (dom.searchSuggestions) {
      dom.searchSuggestions.hidden = true;
      dom.searchSuggestions.innerHTML = "";
    }
    dom.searchInput?.blur();
  }

  function toggleSearch() {
    state.searchOpen ? closeSearch() : openSearch();
  }

  function render() {
    const word = state.words[state.deck[state.currentIndex]];
    if (!word) return;

    dom.card.classList.remove("flipped");

    renderFront(word);
    renderBack(word);

    if (state.blindMode) speakFront();

    dom.cardNum.textContent = state.currentIndex + 1;

    state.seen.add(state.deck[state.currentIndex]);
    dom.seenCount.textContent = state.seen.size;
    dom.progressFill.style.width =
      (state.seen.size / state.words.length) * 100 + "%";
  }

  // Returns the display text for a word in a given language for the card front.
  function getFrontText(word, lang) {
    if (lang === "en") {
      return word.type === "noun"
        ? (word.en || "").replace(/^the\s+/i, "")
        : (word.en || "");
    }
    if (word.type === "adj") {
      const m = word[`${lang}_adj_m`] ?? "";
      const f = word[`${lang}_adj_f`] ?? "";
      if (m && f && m !== f) return `${m} / ${f}`;
      return m || f || word[lang] || "";
    }
    if (word.type === "noun") {
      const art = word[`${lang}_art`] ?? "";
      const w   = word[lang] ?? "";
      return art ? `${art} ${w}` : w;
    }
    return word[lang] ?? "";
  }

  // Returns the echo label shown faintly at the top of the back face.
  function getEchoText(word, lang) {
    return getFrontText(word, lang);
  }

  function renderFront(word) {
    dom.typeBadge.textContent = word.type;
    dom.typeBadge.className = `type-badge ${word.type}`;
    dom.frontWord.textContent = getFrontText(word, state.frontLang);
  }

  function renderBack(word) {
    dom.backEcho.textContent = getEchoText(word, state.frontLang);
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

  // Language config: all non-Latin languages available on the back.
  const LANGS = [
    { key: "en",  label: "English", cls: "en",  speakLang: "en-GB",
      noun:   w => ({ html: w.en ?? "", speak: w.en ?? "" }),
      adjMF:  w => [w.en_m ?? "", w.en_f ?? ""],
      phrase: w => ({ html: w.en ?? "", speak: w.en ?? "" }) },
    { key: "fr",  label: "French",  cls: "fr",  speakLang: "fr-FR",
      noun:   w => ({ html: `<span class="art">${w.fr_art ?? ""}</span> ${w.fr ?? ""}`, speak: `${w.fr_art ?? ""} ${w.fr ?? ""}`.trim() }),
      adjMF:  w => [w.fr_m ?? "", w.fr_f ?? ""],
      phrase: w => ({ html: w.fr ?? "", speak: w.fr ?? "" }) },
    { key: "es",  label: "Spanish", cls: "es",  speakLang: "es-ES",
      noun:   w => ({ html: `<span class="art">${w.es_art ?? ""}</span> ${w.es ?? ""}`, speak: `${w.es_art ?? ""} ${w.es ?? ""}`.trim() }),
      adjMF:  w => [w.es_m ?? "", w.es_f ?? ""],
      phrase: w => ({ html: w.es ?? "", speak: w.es ?? "" }) },
    { key: "it",  label: "Italian", cls: "it",  speakLang: "it-IT",
      noun:   w => ({ html: `<span class="art">${w.it_art ?? ""}</span> ${w.it ?? ""}`, speak: `${w.it_art ?? ""} ${w.it ?? ""}`.trim() }),
      adjMF:  w => [w.it_m ?? "", w.it_f ?? ""],
      phrase: w => ({ html: w.it ?? "", speak: w.it ?? "" }) },
  ];

  function buildNoun(w) {
    return LANGS
      .filter(l => l.key !== state.frontLang)
      .map(l => {
        const { html, speak } = l.noun(w);
        return translationRow(l.label, l.cls, html, speak, l.speakLang);
      })
      .concat(translationRow("Latin", "lat", w.lat ?? "", "", ""))
      .join("");
  }

  function buildAdjective(w) {
    return LANGS
      .filter(l => l.key !== state.frontLang)
      .map(l => {
        const [masc, fem] = l.adjMF(w);
        return adjRow(l.label, l.cls, masc, fem, l.speakLang);
      })
      .concat(translationRow("Root", "lat", w.lat ?? ""))
      .join("");
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
    return LANGS
      .filter(l => l.key !== state.frontLang)
      .map(l => {
        const { html, speak } = l.phrase(w);
        return translationRow(l.label, l.cls, html, speak, l.speakLang);
      })
      .concat(translationRow("Latin", "lat", w.lat ?? "", "", ""))
      .join("");
  }

  let cachedVoices = [];
  function loadVoices() {
    cachedVoices = speechSynthesis.getVoices();
  }
  speechSynthesis.addEventListener("voiceschanged", loadVoices);
  loadVoices();

  // Returns the {text, lang} needed to speak the front of the current card.
  function getFrontSpeakData(word) {
    const lang = state.frontLang;
    const SPEAK_LANG = { en: "en-GB", fr: "fr-FR", es: "es-ES", it: "it-IT" };
    const speakLang = SPEAK_LANG[lang] ?? "en-GB";
    let text = "";
    if (lang === "en") {
      text = word.en ?? "";
    } else if (word.type === "noun") {
      text = (`${word[`${lang}_art`] ?? ""} ${word[lang] ?? ""}`).trim();
    } else if (word.type === "adj") {
      // Speak the masculine form for brevity
      text = word[`${lang}_adj_m`] ?? word[lang] ?? "";
    } else {
      text = word[lang] ?? "";
    }
    return { text, lang: speakLang };
  }

  function toggleBlindMode() {
    state.blindMode = !state.blindMode;
    document.body.classList.toggle("blind-mode", state.blindMode);
    dom.btnBlind.classList.toggle("active", state.blindMode);
    dom.blindSpeakBtn.hidden = !state.blindMode;
    // Auto-speak when entering blind mode
    if (state.blindMode) speakFront();
  }

  function speakFront() {
    const word = state.words[state.deck[state.currentIndex]];
    if (!word) return;
    const { text, lang } = getFrontSpeakData(word);
    if (text) speak(text, lang);
  }

  function speak(text, lang) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = 0.85;
    const voices = cachedVoices.length ? cachedVoices : speechSynthesis.getVoices();
    const base = lang.split("-")[0];
    const voice =
      voices.find(v => v.lang === lang && v.default) ||
      voices.find(v => v.lang === lang) ||
      voices.find(v => v.lang.startsWith(base) && v.default) ||
      voices.find(v => v.lang.startsWith(base));
    if (voice) u.voice = voice;
    speechSynthesis.speak(u);
  }

  function bindEvents() {
    dom.cardWrap.addEventListener("click", () => {
      if (isSearchActive()) return;
      dom.card.classList.toggle("flipped");
    });

    dom.btnNext.addEventListener("click", (e) => { e.stopPropagation(); next(); });
    dom.btnPrev.addEventListener("click", (e) => { e.stopPropagation(); prev(); });
    dom.btnShuffle.addEventListener("click", (e) => { e.stopPropagation(); reshuffle(); });
    dom.btnBlind?.addEventListener("click", (e) => { e.stopPropagation(); toggleBlindMode(); });
    dom.blindSpeakBtn?.addEventListener("click", (e) => { e.stopPropagation(); speakFront(); });

    dom.btnSearch?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSearch();
    });

    // Close search when clicking outside the panel
    dom.searchOverlay?.addEventListener("click", (e) => {
      // Only close if the backdrop itself was clicked
      if (e.target === dom.searchOverlay) closeSearch();
    });

    dom.searchPanel?.addEventListener("click", (e) => e.stopPropagation());

    dom.langButtons.forEach(btn => {
      btn.addEventListener("click", () => {
        dom.langButtons.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        state.frontLang = btn.dataset.lang;
        render();
      });
    });

    dom.filterButtons.forEach(btn => {
      btn.addEventListener("click", () => {
        dom.filterButtons.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        state.filter = btn.dataset.type;
        // Rebuild deck, but try to keep the current word visible if it still exists in the filtered deck.
        const currentWordIdx = state.deck[state.currentIndex];
        const indices = state.words.map((_, i) => i).filter(i => state.filter === "all" || state.words[i]?.type === state.filter);
        state.deck = shuffle(indices);
        const newPos = state.deck.indexOf(currentWordIdx);
        state.currentIndex = newPos >= 0 ? newPos : 0;
        dom.totalCards.textContent = state.deck.length;
        state.deck.length ? render() : renderEmpty();
      });
    });

    dom.searchInput?.addEventListener("input", () => {
      state.searchQuery = dom.searchInput.value;
      updateSuggestions();
    });

    dom.searchInput?.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        closeSearch();
      }
    });

    dom.searchClear?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!dom.searchInput) return;
      dom.searchInput.value = "";
      state.searchQuery = "";
      updateSuggestions();
      dom.searchInput.focus();
    });

    dom.searchSuggestions?.addEventListener("click", (e) => {
      const btn = e.target.closest(".suggestion-item");
      if (!btn) return;
      e.stopPropagation();

      const idx = Number(btn.dataset.idx);
      if (!Number.isInteger(idx)) return;

      // Jump within current deck if present; otherwise show the selected card alone.
      const pos = state.deck.indexOf(idx);
      if (pos >= 0) {
        state.currentIndex = pos;
      } else {
        state.deck = [idx];
        state.currentIndex = 0;
        dom.totalCards.textContent = "1";
      }

      render();
      closeSearch();
    });

    // Prevent search interactions from triggering card handlers (mobile edge cases)
    const stop = (e) => e.stopPropagation();
    dom.searchInput?.addEventListener("click", stop);
    dom.searchInput?.addEventListener("touchstart", stop, { passive: true });

    // Delegated speak buttons (prevents inline onclick)
    dom.backContent.addEventListener("click", (e) => {
      const btn = e.target.closest(".speak-btn");
      if (!btn) return;
      e.stopPropagation();
      speak(btn.dataset.text || "", btn.dataset.lang || "");
    });

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      const ae = document.activeElement;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || ae.isContentEditable)) {
        return;
      }
      if (isSearchActive()) return;
      if (e.key === " ") {
        e.preventDefault();
        dom.card.classList.toggle("flipped");
      }
      if (e.key === "ArrowRight" || e.key === "Enter") next();
      if (e.key === "ArrowLeft") prev();
      if (e.key === "s" || e.key === "S") reshuffle();
      if (e.key === "b" || e.key === "B") toggleBlindMode();
    });

    // Touch swipe navigation
    let tx = 0;
    dom.cardWrap.addEventListener("touchstart", (e) => {
      if (isSearchActive()) return;
      tx = e.changedTouches[0].screenX;
    }, { passive: true });

    dom.cardWrap.addEventListener("touchend", (e) => {
      if (isSearchActive()) return;
      const d = e.changedTouches[0].screenX - tx;
      if (Math.abs(d) > 60) {
        d < 0 ? next() : prev();
      }
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
