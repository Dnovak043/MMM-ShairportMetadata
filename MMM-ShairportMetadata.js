/* global Log, Module */

/* Magic Mirror
 * Module: MMM-ShairportMetadata
 *
 * By Prateek Sureka <surekap@gmail.com>  — MIT Licensed.
 * Progress bar forked by ChielChiel.
 * Fixes: real play/pause (paus event), correct 48k sample rate, wall-clock
 * progress interpolation, persistent client name, Apple Music-style UI,
 * build-once rendering with enter/leave animations.
 */

Module.register("MMM-ShairportMetadata", {

  defaults: {
    metadataPipe: "/tmp/shairport-sync-metadata",
    alignment: "center",
    sampleRate: 48000,    // AirPlay 2 / Shairport v5 default. 44100 for classic AirPlay 1.
    hideAfter: 120,       // seconds without any update before leaving (0 = never)
    showClient: true,
    leaveDurationMs: 470  // must be >= the anim-out CSS duration
  },

  start: function () {
    Log.info("Starting module: " + this.name);
    this.metadata = {};
    this.albumart = null;
    this.playing = false;
    this.stopped = true;
    this.baseSec = 0;
    this.anchor = this.now();
    this.songLenSec = 0;
    this.lastUpdate = this.now();
    this.glowColor = "rgba(140,80,200,0.28)";

    // Rendering state
    this.cardEl = null;
    this.artWrap = null;
    this.artImg = null;
    this.refs = {};
    this.visible = false;     // is the card currently in the DOM
    this.appearing = false;   // request entrance animation on next getDom
    this.leaving = false;     // currently animating out
    this.leaveTimer = null;

    this.sendSocketNotification("CONFIG", this.config);

    // Lightweight tick: only mutates the progress nodes, never rebuilds the DOM.
    setInterval(() => { this.tick(); }, 250);
  },

  now: function () { return new Date().getTime() / 1000; },

  elapsedNow: function () {
    var e = this.playing ? this.baseSec + (this.now() - this.anchor) : this.baseSec;
    if (e < 0) { e = 0; }
    if (this.songLenSec > 0 && e > this.songLenSec) { e = this.songLenSec; }
    return e;
  },

  secToTime: function (sec) {
    sec = Math.max(0, Math.floor(sec));
    var min = Math.floor(sec / 60);
    var remain = sec % 60;
    return min + ":" + (remain < 10 ? "0" : "") + remain;
  },

  shouldHide: function () {
    if (!this.config.hideAfter) { return false; }
    return (this.now() > this.lastUpdate + this.config.hideAfter);
  },

  getHeader: function () { return ""; },

  // ── Incoming metadata ──────────────────────────────────────────────────────
  socketNotificationReceived: function (notification, payload) {
    if (notification !== "DATA") { return; }
    this.lastUpdate = this.now();

    // Stream stopped / disconnected.
    if (Object.keys(payload).length === 0) {
      this.metadata = {};
      this.beginLeave();
      return;
    }

    // Album art on its own line.
    if (payload.hasOwnProperty("image")) {
      this.albumart = payload["image"] ? payload["image"] : null;
      if (this.albumart) { this.extractGlow(this.albumart); }
      else { this.setGlow("rgba(140,80,200,0.28)"); }
      if (this.visible && this.artImg) { this.applyArt(); }
      return;
    }

    // Live session: cancel any in-progress leave.
    if (this.leaving) { this.cancelLeave(); }
    this.stopped = false;

    var wasPlaying = this.playing;
    var nowPlaying = payload.hasOwnProperty("pause") ? !payload["pause"] : true;
    if (wasPlaying && !nowPlaying) {
      this.baseSec = this.elapsedNow();   // freeze where we are
      this.anchor = this.now();
    } else if (!wasPlaying && nowPlaying) {
      this.anchor = this.now();           // resume the clock
    }
    this.playing = nowPlaying;

    this.metadata = Object.assign(this.metadata || {}, payload);

    if (payload.hasOwnProperty("prgr") && payload["prgr"] && payload["prgr"] !== "undefined") {
      var p = String(payload["prgr"]).split("/");
      if (p.length === 3) {
        var start = parseInt(p[0], 10);
        var current = parseInt(p[1], 10);
        var end = parseInt(p[2], 10);
        var rate = this.config.sampleRate || 48000;
        this.baseSec = (current - start) / rate;
        this.songLenSec = (end - start) / rate;
        this.anchor = this.now();
      }
    }

    if (!this.visible) {
      // Build the card and play the entrance animation.
      this.appearing = true;
      this.updateDom(0);
    } else {
      // Card already on screen: mutate in place, no rebuild, no re-animation.
      this.updateCardContent();
    }
  },

  // ── Leave / enter handling ─────────────────────────────────────────────────
  beginLeave: function () {
    if (!this.visible || !this.cardEl) {
      this.stopped = true;
      this.playing = false;
      this.updateDom(0);
      return;
    }
    if (this.leaving) { return; }
    this.leaving = true;
    this.cardEl.classList.remove("anim-in");
    this.cardEl.classList.add("anim-out");
    var self = this;
    this.leaveTimer = setTimeout(function () {
      self.leaving = false;
      self.leaveTimer = null;
      self.stopped = true;
      self.playing = false;
      self.updateDom(0);   // getDom now returns the hidden placeholder
    }, this.config.leaveDurationMs);
  },

  cancelLeave: function () {
    this.leaving = false;
    if (this.leaveTimer) { clearTimeout(this.leaveTimer); this.leaveTimer = null; }
    if (this.cardEl) { this.cardEl.classList.remove("anim-out"); }
  },

  // ── Per-tick: progress + time labels only ──────────────────────────────────
  tick: function () {
    if (this.visible && !this.leaving && this.shouldHide()) {
      this.metadata = {};
      this.beginLeave();
      return;
    }
    if (!this.visible || !this.cardEl || this.leaving || this.stopped) { return; }
    this.updateProgress();
  },

  updateProgress: function () {
    if (!this.refs.progressEl) { return; }
    var elapsed = this.elapsedNow();
    var total = this.songLenSec;
    this.refs.progressEl.value = elapsed;
    this.refs.progressEl.max = total > 0 ? total : 1;
    this.refs.elapsedSpan.textContent = this.secToTime(elapsed);
    if (!this.playing) {
      this.refs.rightSpan.className = "paused-badge";
      this.refs.rightSpan.textContent = "paused";
    } else {
      this.refs.rightSpan.className = "";
      this.refs.rightSpan.textContent = "-" + this.secToTime(Math.max(0, total - elapsed));
    }
  },

  applyArt: function () {
    if (this.albumart) {
      this.artImg.src = this.albumart;
      this.artImg.style.display = "";
      this.artWrap.classList.remove("no-art");
    } else {
      this.artImg.removeAttribute("src");
      this.artImg.style.display = "none";
      this.artWrap.classList.add("no-art");
    }
  },

  // ── In-place content update (no rebuild) ───────────────────────────────────
  updateCardContent: function () {
    if (!this.cardEl) { return; }
    this.refs.titleEl.textContent = this.metadata["Title"] || "";
    this.refs.artistEl.textContent = this.metadata["Artist"] || "";
    var album = this.metadata["Album Name"] || "";
    this.refs.albumEl.textContent = album;
    this.refs.albumEl.style.display = album ? "" : "none";
    this.applyArt();
    this.setGlow(this.glowColor);
    if (this.config.showClient && this.metadata["client"]) {
      this.refs.clientEl.textContent = this.metadata["client"];
      this.refs.clientEl.style.display = "";
    } else {
      this.refs.clientEl.style.display = "none";
    }
    this.updateProgress();
  },

  setGlow: function (c) {
    this.glowColor = c;
    if (this.cardEl) { this.cardEl.style.setProperty("--art-glow", c); }
  },

  extractGlow: function (dataUrl) {
    var self = this;
    var img = new Image();
    img.onload = function () {
      try {
        var canvas = document.createElement("canvas");
        canvas.width = 16; canvas.height = 16;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, 16, 16);
        var d = ctx.getImageData(0, 0, 16, 16).data;
        var r = 0, g = 0, b = 0, count = 0;
        for (var i = 0; i < d.length; i += 4) {
          var brightness = (d[i] + d[i + 1] + d[i + 2]) / 3;
          var max = Math.max(d[i], d[i + 1], d[i + 2]);
          var sat = max > 0 ? (max - Math.min(d[i], d[i + 1], d[i + 2])) / max : 0;
          if (brightness > 20 && sat > 0.15) {
            r += d[i]; g += d[i + 1]; b += d[i + 2]; count++;
          }
        }
        if (count > 0) {
          r = Math.round(r / count); g = Math.round(g / count); b = Math.round(b / count);
          self.setGlow("rgba(" + r + "," + g + "," + b + ",0.35)");
        } else {
          self.setGlow("rgba(140,80,200,0.28)");
        }
      } catch (e) { /* tainted canvas — ignore */ }
    };
    img.src = dataUrl;
  },

  // ── Build the card (called by updateDom on appear / hide) ───────────────────
  getDom: function () {
    var wrapper = document.createElement("div");
    wrapper.style.textAlign =
      this.config.alignment === "left" ? "left"
        : this.config.alignment === "right" ? "right" : "center";

    if (this.stopped && !this.leaving) {
      this.cardEl = null;
      this.artWrap = null;
      this.artImg = null;
      this.refs = {};
      this.visible = false;
      wrapper.style.display = "none";
      return wrapper;
    }

    var card = document.createElement("div");
    card.className = "airplay-card";
    card.style.display = "inline-flex";

    // Album art
    var artWrap = document.createElement("div");
    artWrap.className = "albumart-wrap";
    var img = document.createElement("img");
    artWrap.appendChild(img);
    card.appendChild(artWrap);

    // Track info
    var info = document.createElement("div");
    info.className = "track-info";
    var titleEl = document.createElement("div"); titleEl.className = "track-title";
    var artistEl = document.createElement("div"); artistEl.className = "track-artist";
    var albumEl = document.createElement("div"); albumEl.className = "track-album";
    info.appendChild(titleEl); info.appendChild(artistEl); info.appendChild(albumEl);
    card.appendChild(info);

    // Progress
    var progWrap = document.createElement("div"); progWrap.className = "progress-wrap";
    var progressEl = document.createElement("progress"); progressEl.id = "musicProgress";
    progWrap.appendChild(progressEl);
    card.appendChild(progWrap);

    var times = document.createElement("div"); times.className = "progress-times";
    var elapsedSpan = document.createElement("span");
    var rightSpan = document.createElement("span");
    times.appendChild(elapsedSpan); times.appendChild(rightSpan);
    card.appendChild(times);

    // Client
    var clientEl = document.createElement("div"); clientEl.className = "client-line";
    card.appendChild(clientEl);

    // Store refs
    this.cardEl = card;
    this.artWrap = artWrap;
    this.artImg = img;
    this.refs = { titleEl, artistEl, albumEl, progressEl, elapsedSpan, rightSpan, clientEl };

    this.updateCardContent();

    if (this.appearing) {
      card.classList.add("anim-in");
      this.appearing = false;
    }

    this.visible = true;
    wrapper.appendChild(card);
    return wrapper;
  },

  getStyles: function () {
    return ["MMM-ShairportMetadata.css"];
  }

});
