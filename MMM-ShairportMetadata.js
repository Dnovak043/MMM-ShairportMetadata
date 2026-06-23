/* global Log, Module */

/* Magic Mirror
 * Module: MMM-ShairportMetadata
 *
 * By Prateek Sureka <surekap@gmail.com>  — MIT Licensed.
 * Progress bar forked by ChielChiel.
 * Play/pause + progress fixes: real pause state, correct 48k sample rate,
 * and wall-clock interpolation so the bar advances smoothly and freezes when paused.
 */

Module.register("MMM-ShairportMetadata", {

  defaults: {
    metadataPipe: "/tmp/shairport-sync-metadata",
    alignment: "center",
    sampleRate: 48000,   // Shairport Sync v5 / AirPlay 2 default. Use 44100 for classic AirPlay 1.
    hideAfter: 120       // seconds without any update before hiding (0 = never)
  },

  start: function () {
    Log.info("Starting module: " + this.name);
    this.data.header = "Nothing playing";
    this.metadata = {};
    this.albumart = null;
    this.playing = false;      // true = playing, false = paused
    this.stopped = true;       // true after 'pend' or before anything plays
    this.baseSec = 0;          // elapsed seconds captured at the last anchor
    this.anchor = this.now();  // wall-clock seconds at the last anchor
    this.songLenSec = 0;
    this.lastUpdate = this.now();
    this.sendSocketNotification("CONFIG", this.config);
    // Re-render every second so the bar advances even between metadata updates.
    setInterval(() => { this.updateDom(0); }, 1000);
  },

  now: function () {
    return new Date().getTime() / 1000;
  },

  // Elapsed seconds to show right now: interpolated while playing, frozen while paused.
  elapsedNow: function () {
    var e = this.playing ? this.baseSec + (this.now() - this.anchor) : this.baseSec;
    if (e < 0) { e = 0; }
    if (this.songLenSec > 0 && e > this.songLenSec) { e = this.songLenSec; }
    return e;
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification !== "DATA") { return; }
    this.lastUpdate = this.now();

    // Empty object => stream stopped / disconnected.
    if (Object.keys(payload).length === 0) {
      this.playing = false;
      this.stopped = true;
      this.updateDom(0);
      return;
    }

    // Album art arrives on its own line.
    if (payload.hasOwnProperty("image")) {
      this.albumart = payload["image"] ? payload["image"] : null;
      this.updateDom(0);
      return;
    }

    // Any other non-empty payload means a live session.
    this.stopped = false;

    // Play/pause transitions.
    var wasPlaying = this.playing;
    var nowPlaying = payload.hasOwnProperty("pause") ? !payload["pause"] : true;
    if (wasPlaying && !nowPlaying) {
      // Pausing: freeze the bar exactly where it is.
      this.baseSec = this.elapsedNow();
      this.anchor = this.now();
    } else if (!wasPlaying && nowPlaying) {
      // Resuming: keep the position, restart the clock.
      this.anchor = this.now();
    }
    this.playing = nowPlaying;

    // Merge so a pause/resume-only message never wipes Title/Artist.
    this.metadata = Object.assign(this.metadata || {}, payload);

    // New progress anchor whenever prgr arrives.
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

    this.updateDom(0);
  },

  secToTime: function (sec) {
    sec = Math.max(0, Math.floor(sec));
    var min = Math.floor(sec / 60);
    var remain = sec % 60;
    remain = (remain < 10) ? "0" + remain : "" + remain;
    return min + ":" + remain;
  },

  shouldHide: function () {
    if (!this.config.hideAfter) { return false; }
    return (this.now() > this.lastUpdate + this.config.hideAfter);
  },

  getDom: function () {
    var wrapper = document.createElement("div");
    var alignment = (this.config.alignment === "left") ? "left"
      : (this.config.alignment === "right") ? "right" : "center";

    var hasTrack = this.metadata &&
      (this.metadata["Title"] || this.metadata["Artist"] || this.metadata["Album Name"]);

    if (this.stopped || !hasTrack || this.shouldHide()) {
      wrapper.style.display = "none";
      return wrapper;
    }

    wrapper.className = this.config.classes ? this.config.classes : "small";
    wrapper.style.textAlign = alignment;
    this.data.header = "Somebody is now playing";

    var metadata = document.createElement("div");

    // Album art
    var imgtag = document.createElement("img");
    if (this.albumart) {
      imgtag.setAttribute("src", this.albumart);
      imgtag.setAttribute("style", "width:100px;height:100px;");
    }
    imgtag.className = "albumart";
    metadata.appendChild(imgtag);
    metadata.appendChild(document.createElement("br"));

    // Progress bar
    var elapsed = this.elapsedNow();
    var total = this.songLenSec;
    var progressEl = document.createElement("progress");
    progressEl.id = "musicProgress";
    progressEl.setAttribute("value", elapsed);
    progressEl.setAttribute("max", total > 0 ? total : 1);
    metadata.appendChild(progressEl);
    metadata.appendChild(document.createElement("br"));

    var prgrLabel = document.createElement("label");
    prgrLabel.setAttribute("for", "musicProgress");
    prgrLabel.id = "progressLabel";
    prgrLabel.innerHTML = this.secToTime(elapsed) + " - " + this.secToTime(total) +
      (this.playing ? "" : " (paused)");
    metadata.appendChild(prgrLabel);

    // Title
    var titletag = document.createElement("div");
    if (this.metadata["Title"] && this.metadata["Title"].length > 30) {
      titletag.style.fontSize = "10px";
    }
    titletag.innerHTML = this.metadata["Title"] ? this.metadata["Title"] : "";
    titletag.className = "bright";
    metadata.appendChild(titletag);

    // Artist - Album
    var txt = "";
    if (this.metadata["Artist"] || this.metadata["Album Name"]) {
      txt = (this.metadata["Artist"] || "") + " - " + (this.metadata["Album Name"] || "");
    }
    var artisttag = document.createElement("div");
    if (txt.length > 50) { artisttag.style.fontSize = "10px"; }
    artisttag.innerHTML = txt;
    artisttag.className = "xsmall";
    metadata.appendChild(artisttag);

    wrapper.appendChild(metadata);
    return wrapper;
  },

  getStyles: function () {
    return ["MMM-ShairportMetadata.css"];
  }

});
