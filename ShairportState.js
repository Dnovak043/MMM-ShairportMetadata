/* Magic Mirror
 * Module: MMM-ShairportMetadata
 *
 * Turns shairport-sync's raw MQTT metadata (publish_raw) into one
 * "now playing" state. Free of MQTT and MagicMirror so it can be replayed
 * against a capture (see test/replay.js).
 *
 * AirPlay 2 senders such as Apple Music send MediaRemote now-playing info as a
 * binary plist on ssnc/copl. It is the only source of playback position, so
 * once it has been seen in a session it is used for everything; the classic
 * core/* tags and ssnc/PICT are only a fallback for senders that lack it.
 *
 * MIT Licensed.
 */

const bplist = require("bplist-parser");

const NPI = "kMRMediaRemoteNowPlayingInfo";
const HISTORY_LIMIT = 20;

function emptyTrack() {
  return { id: null, title: "", artist: "", album: "", duration: 0, live: false, artwork: null };
}

function text(payload) {
  return payload.toString("utf8");
}

function imageMime(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) { return "image/png"; }
  return "image/jpeg";
}

class ShairportState {

  constructor() {
    this.history = [];        // previous tracks, newest first; kept across sessions
    this.artworkVersion = 0;
    this.reset();
  }

  reset() {
    this.active = false;      // a play session is in progress
    this.coplSeen = false;    // sender provides MediaRemote now-playing info
    this.track = emptyTrack();
    // Playback position: `elapsed` seconds at time `at` (ms), advancing at `rate`.
    this.anchor = { elapsed: 0, at: 0, rate: 0 };
  }

  // Moves the current track into the history.
  pushHistory() {
    var t = this.track;
    if (!t.title) { return; }
    this.history = this.history.filter(function (h) { return h.id !== t.id; });
    this.history.unshift({ id: t.id, title: t.title, artist: t.artist });
    this.history.length = Math.min(this.history.length, HISTORY_LIMIT);
  }

  startTrack(id, ms) {
    this.pushHistory();
    this.history = this.history.filter(function (h) { return h.id !== id; });
    this.track = emptyTrack();
    this.track.id = id;
    this.anchor = { elapsed: 0, at: ms, rate: this.anchor.rate };
  }

  positionAt(ms) {
    var a = this.anchor;
    var p = a.elapsed + (ms - a.at) / 1000 * a.rate;
    return Math.min(Math.max(p, 0), this.track.duration || Infinity);
  }

  setRate(rate, ms) {
    this.anchor = { elapsed: this.positionAt(ms), at: ms, rate: rate };
  }

  setArtwork(buf) {
    var art = buf.length ? "data:" + imageMime(buf) + ";base64," + buf.toString("base64") : null;
    if (art !== this.track.artwork) {
      this.track.artwork = art;
      this.artworkVersion += 1;
    }
  }

  end() {
    var wasActive = this.active;
    this.pushHistory();
    this.reset();
    return wasActive;
  }

  /**
   * Applies one MQTT message. `code` is the topic without its prefix, e.g.
   * "ssnc/copl". Returns true if the visible state may have changed.
   */
  handle(code, payload, ms) {
    switch (code) {
      // End of the play session: arrives (with ssnc/disc) as soon as the
      // sender disconnects. A lone ssnc/disc is not an end: the phone also
      // drops a secondary connection mid-song while the music keeps playing.
      case "ssnc/pend":
      case "ssnc/aend":
        return this.end();

      case "ssnc/abeg":
      case "ssnc/pbeg":
      case "ssnc/pres":
        this.active = true;
        return true;

      // Resume / first frame. Now-playing info usually follows with the exact
      // position; until then assume playback continues from where it paused.
      case "ssnc/prsm":
      case "ssnc/pffr":
        this.active = true;
        if (this.anchor.rate === 0) { this.setRate(1, ms); }
        return true;

      // Pause arrives only as an event; no now-playing update accompanies it.
      case "ssnc/paus":
      case "ssnc/pfls":
        this.setRate(0, ms);
        return true;

      case "ssnc/copl":
        return this.handleNowPlaying(payload, ms);
    }

    if (this.coplSeen) { return false; }
    return this.handleClassic(code, payload, ms);
  }

  handleNowPlaying(payload, ms) {
    var msg;
    try {
      msg = bplist.parseBuffer(payload)[0];
    } catch (e) {
      return false;
    }
    if (!msg || msg.type !== "updateMRNowPlayingInfo" || !msg.params) { return false; }
    var info = msg.params.params || {};
    if (Object.keys(info).length === 0) { return false; }
    var get = function (key) { return info[NPI + key]; };
    this.coplSeen = true;

    // A new item resets everything. "replace" messages for the same item can
    // omit the artwork, so fields are only ever overwritten, never cleared.
    var id = get("ContentItemIdentifier");
    if (id && id !== this.track.id) { this.startTrack(id, ms); }
    if (typeof get("Title") === "string") { this.track.title = get("Title"); }
    if (typeof get("Artist") === "string") { this.track.artist = get("Artist"); }
    if (typeof get("Album") === "string") { this.track.album = get("Album"); }
    if (typeof get("Duration") === "number") { this.track.duration = get("Duration"); }
    if (get("IsAlwaysLive") !== undefined) { this.track.live = !!get("IsAlwaysLive"); }
    if (Buffer.isBuffer(get("ArtworkData"))) { this.setArtwork(get("ArtworkData")); }

    // ElapsedTime is the position at Timestamp (the sender's clock, which
    // matched the Pi to within 0.3 s in testing).
    var hasTiming = ["Timestamp", "PlaybackRate", "ElapsedTime"].some(function (k) {
      return get(k) !== undefined;
    });
    if (hasTiming) {
      var at = get("Timestamp") instanceof Date ? get("Timestamp").getTime() : ms;
      var rate = typeof get("PlaybackRate") === "number" ? get("PlaybackRate") : this.anchor.rate;
      var elapsed = typeof get("ElapsedTime") === "number" ? get("ElapsedTime") : this.positionAt(at);
      this.anchor = { elapsed: elapsed, at: at, rate: rate };
      if (rate > 0) { this.active = true; }
    }
    return true;
  }

  handleClassic(code, payload, ms) {
    switch (code) {
      case "core/minm": this.track.title = text(payload); return true;
      case "core/asar": this.track.artist = text(payload); return true;
      case "core/asal": this.track.album = text(payload); return true;
      case "core/astm":
        if (payload.length >= 4) { this.track.duration = payload.readUInt32BE(0) / 1000; }
        return true;
      // The id can arrive after the other tags of its track, so a new id only
      // restarts the clock; the text and artwork are overwritten as they come.
      case "core/mper":
        var id = payload.toString("hex");
        if (id !== this.track.id) {
          this.track.id = id;
          this.anchor = { elapsed: 0, at: ms, rate: this.anchor.rate };
        }
        return true;
      case "ssnc/PICT":
        this.setArtwork(payload);
        return true;
    }
    return false;
  }

  /**
   * The state to show. `artworkId` changes whenever the artwork does; the
   * image itself is `track.artwork` (a data URL, or null).
   */
  snapshot(ms) {
    var active = this.active && !!this.track.title;
    return {
      active: active,
      playing: active && this.anchor.rate > 0,
      title: active ? this.track.title : "",
      artist: active ? this.track.artist : "",
      album: active ? this.track.album : "",
      positionMs: active ? Math.round(this.positionAt(ms) * 1000) : 0,
      durationMs: active && !this.track.live ? Math.round(this.track.duration * 1000) : 0,
      artworkId: active && this.track.artwork ? this.track.id + ":" + this.artworkVersion : "",
      history: this.history.map(function (h) { return { title: h.title, artist: h.artist }; })
    };
  }
}

module.exports = ShairportState;
