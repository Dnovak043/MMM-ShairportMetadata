/* global Log, Module */

/* Magic Mirror
 * Module: MMM-ShairportMetadata
 *
 * By Prateek Sureka <surekap@gmail.com>  — MIT Licensed.
 * Progress bar forked by ChielChiel.
 * Fixes: real play/pause (paus event), correct 48k sample rate, wall-clock
 * progress interpolation, persistent client name, Apple Music-style UI.
 */

Module.register("MMM-ShairportMetadata", {

  defaults: {
    metadataPipe: "/tmp/shairport-sync-metadata",
    alignment: "center",
    sampleRate: 48000,   // AirPlay 2 / Shairport v5 default. Use 44100 for classic AirPlay 1.
    hideAfter: 120,      // seconds without any update before hiding (0 = never)
    showClient: true     // show the "playing from" device line
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
    this.glowColor = "rgba(140,80,200,0.28)";  // default glow until art loads
    this.sendSocketNotification("CONFIG", this.config);
    setInterval(() => { this.updateDom(0); }, 1000);
  },

  now: function () {
    return new Date().getTime() / 1000;
  },

  elapsedNow: function () {
    var e = this.playing
      ? this.baseSec + (this.now() - this.anchor)
      : this.baseSec;
    if (e < 0) { e = 0; }
    if (this.songLenSec > 0 && e > this.songLenSec) { e = this.songLenSec; }
    return e;
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification !== "DATA") { return; }
    this.lastUpdate = this.now();

    if (Object.keys(payload).length === 0) {
      this.playing = false;
      this.stopped = true;
      this.metadata = {};
      this.albumart = null;
      this.updateDom(0);
      return;
    }

    if (payload.hasOwnProperty("image")) {
      this.albumart = payload["image"] ? payload["image"] : null;
      if (this.albumart) { this.extractGlow(this.albumart); }
      else { this.glowColor = "rgba(140,80,200,0.28)"; }
      this.updateDom(0);
      return;
    }

    this.stopped = false;

    var wasPlaying = this.playing;
    var nowPlaying = payload.hasOwnProperty("pause") ? !payload["pause"] : true;
    if (wasPlaying && !nowPlaying) {
      this.baseSec = this.elapsedNow();
      this.anchor = this.now();
    } else if (!wasPlaying && nowPlaying) {
      this.anchor = this.now();
    }
    this.playing = nowPlaying;

    this.metadata = Object.assign(this.metadata || {}, payload);

    if (payload.hasOwnProperty("prgr") && payload["prgr"] && payload["prgr"] !== "undefined") {
      var p = String(payload["prgr"]).split("/");
      if (p.length === 3) {
        var start   = parseInt(p[0], 10);
        var current = parseInt(p[1], 10);
        var end     = parseInt(p[2], 10);
        var rate    = this.config.sampleRate || 48000;
        this.baseSec    = (current - start) / rate;
        this.songLenSec = (end - start) / rate;
        this.anchor     = this.now();
      }
    }

    this.updateDom(0);
  },

  // Sample the dominant colour from the album art and store as a CSS rgba string.
  extractGlow: function (dataUrl) {
    var self = this;
    var img = new Image();
    img.onload = function () {
      try {
        var canvas = document.createElement("canvas");
        canvas.width = 16; canvas.height = 16;   // tiny sample for speed
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, 16, 16);
        var d = ctx.getImageData(0, 0, 16, 16).data;
        var r = 0, g = 0, b = 0, count = 0;
        for (var i = 0; i < d.length; i += 4) {
          // Skip very dark and very desaturated pixels — they produce muddy glows.
          var brightness = (d[i] + d[i+1] + d[i+2]) / 3;
          var max = Math.max(d[i], d[i+1], d[i+2]);
          var sat = max > 0 ? (max - Math.min(d[i], d[i+1], d[i+2])) / max : 0;
          if (brightness > 20 && sat > 0.15) {
            r += d[i]; g += d[i+1]; b += d[i+2]; count++;
          }
        }
        if (count > 0) {
          r = Math.round(r / count);
          g = Math.round(g / count);
          b = Math.round(b / count);
          self.glowColor = "rgba(" + r + "," + g + "," + b + ",0.35)";
        } else {
          self.glowColor = "rgba(140,80,200,0.28)";
        }
        // Update the card's glow variable live without a full DOM rebuild.
        var card = document.querySelector(".MMM-ShairportMetadata .airplay-card");
        if (card) { card.style.setProperty("--art-glow", self.glowColor); }
      } catch (e) { /* tainted canvas (unlikely for data URLs) — ignore */ }
    };
    img.src = dataUrl;
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

  getDom: function () {
    var wrapper = document.createElement("div");
    var alignment = this.config.alignment === "left" ? "left"
      : this.config.alignment === "right" ? "right" : "center";
    wrapper.style.textAlign = alignment;

    var hasTrack = this.metadata &&
      (this.metadata["Title"] || this.metadata["Artist"] || this.metadata["Album Name"]);

    if (this.stopped || !hasTrack || this.shouldHide()) {
      wrapper.style.display = "none";
      return wrapper;
    }

    // ── Card ─────────────────────────────────────────────────────────────────
    var card = document.createElement("div");
    card.className = "airplay-card";
    card.style.display = "inline-flex";   // shrink-wrap to content width
    card.style.setProperty("--art-glow", this.glowColor);

    // ── Album art ─────────────────────────────────────────────────────────────
    var artWrap = document.createElement("div");
    artWrap.className = this.albumart ? "albumart-wrap" : "albumart-wrap no-art";
    if (this.albumart) {
      var img = document.createElement("img");
      img.src = this.albumart;
      artWrap.appendChild(img);
    }
    card.appendChild(artWrap);

    // ── Track info ────────────────────────────────────────────────────────────
    var info = document.createElement("div");
    info.className = "track-info";

    var titleEl = document.createElement("div");
    titleEl.className = "track-title";
    titleEl.textContent = this.metadata["Title"] || "";
    info.appendChild(titleEl);

    var artistEl = document.createElement("div");
    artistEl.className = "track-artist";
    artistEl.textContent = this.metadata["Artist"] || "";
    info.appendChild(artistEl);

    if (this.metadata["Album Name"]) {
      var albumEl = document.createElement("div");
      albumEl.className = "track-album";
      albumEl.textContent = this.metadata["Album Name"];
      info.appendChild(albumEl);
    }
    card.appendChild(info);

    // ── Progress ──────────────────────────────────────────────────────────────
    var elapsed = this.elapsedNow();
    var total   = this.songLenSec;

    var progWrap = document.createElement("div");
    progWrap.className = "progress-wrap";

    var progressEl = document.createElement("progress");
    progressEl.id = "musicProgress";
    progressEl.setAttribute("value", elapsed);
    progressEl.setAttribute("max", total > 0 ? total : 1);
    progWrap.appendChild(progressEl);
    card.appendChild(progWrap);

    // Time row: elapsed left, remaining/paused right
    var times = document.createElement("div");
    times.className = "progress-times";

    var elapsedSpan = document.createElement("span");
    elapsedSpan.textContent = this.secToTime(elapsed);
    times.appendChild(elapsedSpan);

    var rightSpan = document.createElement("span");
    if (!this.playing) {
      rightSpan.className = "paused-badge";
      rightSpan.textContent = "paused";
    } else {
      // Show remaining time (negative style, like Apple Music)
      var remaining = Math.max(0, total - elapsed);
      rightSpan.textContent = "-" + this.secToTime(remaining);
    }
    times.appendChild(rightSpan);
    card.appendChild(times);

    // ── Client line ───────────────────────────────────────────────────────────
    if (this.config.showClient && this.metadata["client"]) {
      var clientEl = document.createElement("div");
      clientEl.className = "client-line";
      clientEl.textContent = this.metadata["client"];
      card.appendChild(clientEl);
    }

    wrapper.appendChild(card);
    return wrapper;
  },

  getStyles: function () {
    return ["MMM-ShairportMetadata.css"];
  }

});
