/*
 * SpotLoop
 * A-B repeat and saved song sections for Spotify Desktop via Spicetify.
 *
 * Copyright (c) 2026 Jackson Maynard
 * Released under the MIT License.
 */

(function spotLoopExtension() {
  "use strict";

  const STORAGE_KEY = "spotloop:state:v1";
  const MIN_LOOP_MS = 1000;
  const SEEK_GUARD_MS = 350;
  const LOOP_POLL_MS = 100;
  const PROGRESS_SYNC_THRESHOLD_MS = 25;

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(Number(value) || 0, minimum), maximum);
  }

  function formatTime(milliseconds) {
    const totalSeconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;
  }

  function validBounds(start, end, duration = Number.POSITIVE_INFINITY) {
    return (
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start >= 0 &&
      end <= duration &&
      end - start >= MIN_LOOP_MS
    );
  }

  function makeLastWindow(position, windowMs = 15000) {
    const end = Math.max(0, Number(position) || 0);
    return { start: Math.max(0, end - windowMs), end };
  }

  function emptyState() {
    return { version: 1, sectionsByTrack: {} };
  }

  function safeParseState(value) {
    if (!value) return emptyState();
    try {
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      if (!parsed || typeof parsed !== "object") return emptyState();
      return {
        version: 1,
        sectionsByTrack:
          parsed.sectionsByTrack && typeof parsed.sectionsByTrack === "object"
            ? parsed.sectionsByTrack
            : {},
      };
    } catch {
      return emptyState();
    }
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { clamp, formatTime, validBounds, makeLastWindow, safeParseState };
  }

  if (typeof Spicetify === "undefined") return;

  function waitForSpicetify() {
    if (
      !Spicetify.Player ||
      !Spicetify.Playbar ||
      !Spicetify.PopupModal ||
      !Spicetify.Keyboard ||
      !Spicetify.LocalStorage
    ) {
      setTimeout(waitForSpicetify, 250);
      return;
    }

    initialize();
  }

  function initialize() {
    let markerA = null;
    let markerB = null;
    let loopEnabled = false;
    let loopTrackUri = null;
    let lastSeekAt = 0;
    let estimatedProgress = null;
    let lastObservedProgress = null;
    let lastProgressCheckAt = Date.now();
    let state = loadState();
    let playbarButton = null;

    injectStyles();

    function loadState() {
      return safeParseState(Spicetify.LocalStorage.get(STORAGE_KEY));
    }

    function saveState() {
      Spicetify.LocalStorage.set(STORAGE_KEY, JSON.stringify(state));
    }

    function trackInfo() {
      const item = Spicetify.Player.data?.item;
      const metadata = item?.metadata || {};
      return {
        uri: item?.uri || null,
        title: item?.name || metadata.title || metadata.name || "Current track",
        artist:
          metadata.artist_name ||
          metadata.artist ||
          metadata.artists ||
          "Unknown artist",
        duration: Math.max(0, Number(Spicetify.Player.getDuration()) || 0),
      };
    }

    function notify(message, error = false) {
      Spicetify.showNotification(message, error, 2500);
    }

    function hasUsableTrack() {
      const track = trackInfo();
      if (!track.uri || track.duration <= 0) {
        notify("Play a seekable track before setting a loop.", true);
        return false;
      }
      return true;
    }

    function stopLoop(silent = false) {
      loopEnabled = false;
      loopTrackUri = null;
      estimatedProgress = null;
      lastObservedProgress = null;
      syncPlaybarButton();
      if (!silent) notify("SpotLoop paused");
    }

    function resetProgressClock(position) {
      estimatedProgress = Math.max(0, Number(position) || 0);
      lastObservedProgress = estimatedProgress;
      lastProgressCheckAt = Date.now();
    }

    function getLiveProgress() {
      const now = Date.now();
      const elapsed = Math.max(0, now - lastProgressCheckAt);
      const observed = Number(Spicetify.Player.getProgress());
      const observedMoved =
        Number.isFinite(observed) &&
        lastObservedProgress !== null &&
        Math.abs(observed - lastObservedProgress) >= PROGRESS_SYNC_THRESHOLD_MS;

      if (estimatedProgress === null) {
        estimatedProgress = Number.isFinite(observed) ? observed : 0;
      } else if (observedMoved && now - lastSeekAt >= SEEK_GUARD_MS) {
        estimatedProgress = observed;
      } else if (Spicetify.Player.isPlaying()) {
        const speed = Math.max(0.1, Number(Spicetify.Player.data?.playback_speed) || 1);
        estimatedProgress += elapsed * speed;
      }

      if (Number.isFinite(observed)) lastObservedProgress = observed;
      lastProgressCheckAt = now;
      return estimatedProgress;
    }

    function activateLoop({ seekToStart = true } = {}) {
      if (!hasUsableTrack()) return false;
      const track = trackInfo();
      if (!validBounds(markerA, markerB, track.duration)) {
        notify("Set A and B at least one second apart.", true);
        return false;
      }

      loopEnabled = true;
      loopTrackUri = track.uri;
      if (seekToStart) {
        lastSeekAt = Date.now();
        Spicetify.Player.seek(markerA);
        resetProgressClock(markerA);
      } else {
        resetProgressClock(Spicetify.Player.getProgress());
      }
      if (!Spicetify.Player.isPlaying()) Spicetify.Player.play();
      syncPlaybarButton();
      notify(`Looping ${formatTime(markerA)} to ${formatTime(markerB)}`);
      return true;
    }

    function toggleLoop() {
      if (loopEnabled) stopLoop();
      else activateLoop();
      refreshOpenModal();
    }

    function setMarker(which, value = Spicetify.Player.getProgress()) {
      if (!hasUsableTrack()) return;
      const duration = trackInfo().duration;
      const position = clamp(value, 0, duration);

      if (which === "A") {
        markerA = position;
        if (markerB === null || markerB - markerA < MIN_LOOP_MS) {
          markerB = Math.min(duration, markerA + 15000);
        }
      } else {
        markerB = position;
        if (markerA === null || markerB - markerA < MIN_LOOP_MS) {
          markerA = Math.max(0, markerB - 15000);
        }
      }

      if (!validBounds(markerA, markerB, duration)) loopEnabled = false;
      syncPlaybarButton();
      notify(`${which} set at ${formatTime(position)}`);
      refreshOpenModal();
    }

    function loopLast(seconds = 15) {
      if (!hasUsableTrack()) return;
      const bounds = makeLastWindow(Spicetify.Player.getProgress(), seconds * 1000);
      if (!validBounds(bounds.start, bounds.end, trackInfo().duration)) {
        notify(`Play at least ${seconds} seconds first.`, true);
        return;
      }
      markerA = bounds.start;
      markerB = bounds.end;
      activateLoop();
      refreshOpenModal();
    }

    function clearMarkers() {
      markerA = null;
      markerB = null;
      stopLoop(true);
      notify("Loop markers cleared");
      refreshOpenModal();
    }

    function saveSection(name) {
      if (!hasUsableTrack()) return false;
      const track = trackInfo();
      if (!validBounds(markerA, markerB, track.duration)) {
        notify("Set a valid loop before saving it.", true);
        return false;
      }

      const section = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: String(name || "Favorite part").trim().slice(0, 60) || "Favorite part",
        start: Math.round(markerA),
        end: Math.round(markerB),
        trackTitle: track.title,
        artist: track.artist,
      };

      const sections = state.sectionsByTrack[track.uri] || [];
      state.sectionsByTrack[track.uri] = [...sections, section];
      saveState();
      notify(`Saved “${section.name}”`);
      return true;
    }

    function deleteSection(id) {
      const uri = trackInfo().uri;
      if (!uri) return;
      state.sectionsByTrack[uri] = (state.sectionsByTrack[uri] || []).filter(
        (section) => section.id !== id,
      );
      if (state.sectionsByTrack[uri].length === 0) delete state.sectionsByTrack[uri];
      saveState();
      refreshOpenModal();
    }

    function playSection(section) {
      markerA = section.start;
      markerB = section.end;
      activateLoop();
      refreshOpenModal();
    }

    function onProgress() {
      if (!loopEnabled) return;
      const track = trackInfo();
      if (!track.uri || track.uri !== loopTrackUri) {
        stopLoop(true);
        return;
      }

      const progress = getLiveProgress();
      const now = Date.now();
      if (progress >= markerB && now - lastSeekAt >= SEEK_GUARD_MS) {
        lastSeekAt = now;
        Spicetify.Player.seek(markerA);
        resetProgressClock(markerA);
      }
    }

    function onSongChange() {
      markerA = null;
      markerB = null;
      stopLoop(true);
      refreshOpenModal();
    }

    function syncPlaybarButton() {
      if (!playbarButton) return;
      playbarButton.active = loopEnabled;
      const a = markerA === null ? "A" : formatTime(markerA);
      const b = markerB === null ? "B" : formatTime(markerB);
      playbarButton.label = loopEnabled
        ? `SpotLoop active: ${a} to ${b}`
        : `SpotLoop: ${a} to ${b}`;
    }

    function injectStyles() {
      if (document.getElementById("spotloop-styles")) return;
      const style = document.createElement("style");
      style.id = "spotloop-styles";
      style.textContent = `
        .spotloop { color: var(--spice-text); min-width: 520px; max-width: 680px; }
        .spotloop * { box-sizing: border-box; }
        .spotloop__track { margin-bottom: 18px; }
        .spotloop__eyebrow { color: var(--spice-subtext); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
        .spotloop__title { font-size: 22px; font-weight: 700; margin-top: 4px; }
        .spotloop__artist { color: var(--spice-subtext); font-size: 13px; margin-top: 2px; }
        .spotloop__timeline { background: rgba(var(--spice-rgb-shadow), .18); border-radius: 12px; padding: 16px; }
        .spotloop__times { display: flex; justify-content: space-between; font-variant-numeric: tabular-nums; margin-bottom: 10px; }
        .spotloop__time { display: flex; flex-direction: column; gap: 2px; }
        .spotloop__time:last-child { text-align: right; }
        .spotloop__time-label { color: var(--spice-subtext); font-size: 10px; font-weight: 700; letter-spacing: .08em; }
        .spotloop__time-value { font-size: 20px; font-weight: 700; }
        .spotloop__range { accent-color: var(--spice-button-active); display: block; margin: 8px 0; width: 100%; }
        .spotloop__actions { display: grid; gap: 8px; grid-template-columns: repeat(5, 1fr); margin-top: 14px; }
        .spotloop__button { background: var(--spice-button); border: 0; border-radius: 999px; color: var(--spice-button-text); cursor: pointer; font-weight: 700; min-height: 36px; padding: 8px 12px; }
        .spotloop__button:hover { filter: brightness(1.12); transform: scale(1.02); }
        .spotloop__button--secondary { background: rgba(var(--spice-rgb-selected-row), .35); color: var(--spice-text); }
        .spotloop__button--active { background: var(--spice-button-active); color: var(--spice-button-text); }
        .spotloop__save { display: flex; gap: 8px; margin-top: 14px; }
        .spotloop__input { background: var(--spice-card); border: 1px solid rgba(var(--spice-rgb-subtext), .35); border-radius: 8px; color: var(--spice-text); flex: 1; min-width: 0; padding: 10px 12px; }
        .spotloop__section-title { font-size: 13px; font-weight: 700; margin: 22px 0 10px; }
        .spotloop__saved { display: flex; flex-direction: column; gap: 8px; }
        .spotloop__saved-row { align-items: center; background: rgba(var(--spice-rgb-selected-row), .22); border-radius: 10px; display: grid; gap: 10px; grid-template-columns: 1fr auto auto; padding: 10px 12px; }
        .spotloop__saved-name { font-size: 13px; font-weight: 700; }
        .spotloop__saved-time, .spotloop__empty, .spotloop__shortcuts { color: var(--spice-subtext); font-size: 12px; }
        .spotloop__icon-button { background: transparent; border: 0; color: var(--spice-subtext); cursor: pointer; font-size: 16px; padding: 6px; }
        .spotloop__shortcuts { border-top: 1px solid rgba(var(--spice-rgb-subtext), .2); line-height: 1.7; margin-top: 18px; padding-top: 12px; }
        .spotloop kbd { background: rgba(var(--spice-rgb-selected-row), .4); border-radius: 4px; color: var(--spice-text); font-family: inherit; padding: 2px 5px; }
        @media (max-width: 700px) {
          .spotloop { min-width: 0; }
          .spotloop__actions { grid-template-columns: 1fr 1fr; }
        }
      `;
      document.head.appendChild(style);
    }

    function renderModalContent() {
      const track = trackInfo();
      const duration = Math.max(track.duration, 1);
      const currentA = markerA === null ? 0 : markerA;
      const currentB = markerB === null ? duration : markerB;
      const sections = track.uri ? state.sectionsByTrack[track.uri] || [] : [];
      const container = document.createElement("div");
      container.className = "spotloop";
      container.dataset.spotloopModal = "true";

      container.innerHTML = `
        <div class="spotloop__track">
          <div class="spotloop__eyebrow">Now playing</div>
          <div class="spotloop__title"></div>
          <div class="spotloop__artist"></div>
        </div>
        <div class="spotloop__timeline">
          <div class="spotloop__times">
            <div class="spotloop__time"><span class="spotloop__time-label">START A</span><span class="spotloop__time-value" data-time="a">${formatTime(currentA)}</span></div>
            <div class="spotloop__time"><span class="spotloop__time-label">END B</span><span class="spotloop__time-value" data-time="b">${formatTime(currentB)}</span></div>
          </div>
          <input class="spotloop__range" data-range="a" type="range" min="0" max="${duration}" step="250" value="${currentA}">
          <input class="spotloop__range" data-range="b" type="range" min="0" max="${duration}" step="250" value="${currentB}">
          <div class="spotloop__actions">
            <button class="spotloop__button spotloop__button--secondary" data-action="set-a">Set A</button>
            <button class="spotloop__button spotloop__button--secondary" data-action="set-b">Set B</button>
            <button class="spotloop__button ${loopEnabled ? "spotloop__button--active" : ""}" data-action="toggle">${loopEnabled ? "Pause loop" : "Start loop"}</button>
            <button class="spotloop__button spotloop__button--secondary" data-action="last-15">Last 15s</button>
            <button class="spotloop__button spotloop__button--secondary" data-action="clear">Clear</button>
          </div>
        </div>
        <div class="spotloop__save">
          <input class="spotloop__input" data-section-name maxlength="60" placeholder="Name this section, e.g. Verse 2">
          <button class="spotloop__button" data-action="save">Save section</button>
        </div>
        <div class="spotloop__section-title">Saved for this track</div>
        <div class="spotloop__saved"></div>
        <div class="spotloop__shortcuts">
          <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>[</kbd> Set A &nbsp;•&nbsp;
          <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>]</kbd> Set B &nbsp;•&nbsp;
          <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>L</kbd> Toggle loop
        </div>
      `;

      container.querySelector(".spotloop__title").textContent = track.title;
      container.querySelector(".spotloop__artist").textContent = track.artist;

      const savedContainer = container.querySelector(".spotloop__saved");
      if (sections.length === 0) {
        const empty = document.createElement("div");
        empty.className = "spotloop__empty";
        empty.textContent = "No saved sections for this track yet.";
        savedContainer.appendChild(empty);
      } else {
        sections.forEach((section) => {
          const row = document.createElement("div");
          row.className = "spotloop__saved-row";

          const copy = document.createElement("div");
          const name = document.createElement("div");
          name.className = "spotloop__saved-name";
          name.textContent = section.name;
          const time = document.createElement("div");
          time.className = "spotloop__saved-time";
          time.textContent = `${formatTime(section.start)} to ${formatTime(section.end)}`;
          copy.append(name, time);

          const play = document.createElement("button");
          play.className = "spotloop__button";
          play.textContent = "Loop";
          play.addEventListener("click", () => playSection(section));

          const remove = document.createElement("button");
          remove.className = "spotloop__icon-button";
          remove.title = "Delete saved section";
          remove.setAttribute("aria-label", `Delete ${section.name}`);
          remove.textContent = "×";
          remove.addEventListener("click", () => deleteSection(section.id));

          row.append(copy, play, remove);
          savedContainer.appendChild(row);
        });
      }

      const rangeA = container.querySelector('[data-range="a"]');
      const rangeB = container.querySelector('[data-range="b"]');
      const timeA = container.querySelector('[data-time="a"]');
      const timeB = container.querySelector('[data-time="b"]');

      rangeA.addEventListener("input", () => {
        markerA = Math.min(Number(rangeA.value), Number(rangeB.value) - MIN_LOOP_MS);
        markerA = Math.max(0, markerA);
        rangeA.value = String(markerA);
        timeA.textContent = formatTime(markerA);
        if (loopEnabled && !validBounds(markerA, markerB, track.duration)) stopLoop(true);
        syncPlaybarButton();
      });

      rangeB.addEventListener("input", () => {
        markerB = Math.max(Number(rangeB.value), Number(rangeA.value) + MIN_LOOP_MS);
        markerB = Math.min(track.duration, markerB);
        rangeB.value = String(markerB);
        timeB.textContent = formatTime(markerB);
        if (loopEnabled && !validBounds(markerA, markerB, track.duration)) stopLoop(true);
        syncPlaybarButton();
      });

      container.querySelector('[data-action="set-a"]').addEventListener("click", () => setMarker("A"));
      container.querySelector('[data-action="set-b"]').addEventListener("click", () => setMarker("B"));
      container.querySelector('[data-action="toggle"]').addEventListener("click", toggleLoop);
      container.querySelector('[data-action="last-15"]').addEventListener("click", () => loopLast(15));
      container.querySelector('[data-action="clear"]').addEventListener("click", clearMarkers);
      container.querySelector('[data-action="save"]').addEventListener("click", () => {
        const input = container.querySelector("[data-section-name]");
        if (saveSection(input.value)) refreshOpenModal();
      });
      container.querySelector("[data-section-name]").addEventListener("keydown", (event) => {
        if (event.key === "Enter" && saveSection(event.currentTarget.value)) refreshOpenModal();
      });

      return container;
    }

    function openModal() {
      Spicetify.PopupModal.display({
        title: "SpotLoop",
        content: renderModalContent(),
        isLarge: true,
      });
    }

    function refreshOpenModal() {
      if (!document.querySelector('[data-spotloop-modal="true"]')) return;
      openModal();
    }

    playbarButton = new Spicetify.Playbar.Button(
      "SpotLoop",
      "repeat",
      openModal,
      false,
      false,
    );
    playbarButton.element.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      toggleLoop();
    });
    syncPlaybarButton();

    Spicetify.Keyboard.registerShortcut("ctrl+shift+[", () => setMarker("A"));
    Spicetify.Keyboard.registerShortcut("ctrl+shift+]", () => setMarker("B"));
    Spicetify.Keyboard.registerShortcut("ctrl+shift+l", toggleLoop);

    Spicetify.Player.addEventListener("onprogress", onProgress);
    Spicetify.Player.addEventListener("songchange", onSongChange);
    setInterval(onProgress, LOOP_POLL_MS);

    console.log("[SpotLoop] Loaded");
  }

  waitForSpicetify();
})();
