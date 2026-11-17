/* Magic Mirror
 * Module: MMM-ShairportMetadata
 *
 * By surekap <surekap@gmail.com>
 *
 * MIT Licensed.
 */

const NodeHelper = require("node_helper");
const mqtt = require("mqtt");
const ShairportState = require("./ShairportState");

module.exports = NodeHelper.create({

	start: function() {
		console.log("Starting module: " + this.name);
		this.state = new ShairportState();
		this.client = null;
		this.lastArtworkId = null;
		this.suspended = false;   // the front end is hidden: send it nothing
	},

	// Every notification carries the module config.
	socketNotificationReceived: function(notification, payload) {
		// The front end was hidden. Stop sending; with disconnectOnSuspend also
		// drop the MQTT connection, so nothing runs here at all.
		if (notification === "SUSPEND") {
			this.suspended = true;
			if (payload.disconnectOnSuspend) { this.disconnect(); }
			return;
		}

		// CONFIG: a (re)loaded browser. RESUME: the front end is shown again.
		if (notification !== "CONFIG" && notification !== "RESUME") { return; }
		this.suspended = false;
		if (!this.client) {
			// Whatever played while disconnected was missed, so the old session
			// can't be trusted: start clean and wait for the sender's next update.
			this.state.end();
			this.connect(payload);
		}
		// The front end needs the full state, artwork included.
		this.lastArtworkId = null;
		this.send();
	},

	disconnect: function() {
		if (!this.client) { return; }
		const client = this.client;
		this.client = null;
		client.removeAllListeners("message");
		client.end(true);   // close now; also stops the reconnect timer
		console.log(this.name + ": disconnected from MQTT while hidden");
	},

	connect: function(config) {
		const self = this;
		const prefix = config.mqttTopic.replace(/\/+$/, "");

		const client = mqtt.connect(config.mqttUrl, { reconnectPeriod: 5000 });
		this.client = client;

		client.on("connect", function() {
			console.log(self.name + ": connected to " + config.mqttUrl);
			client.subscribe([prefix + "/ssnc/#", prefix + "/core/#"]);
		});

		client.on("error", function(err) {
			console.log(self.name + ": MQTT error: " + err.message);
		});

		client.on("message", function(topic, payload) {
			if (self.client !== client) { return; }   // a connection that was dropped
			const code = topic.slice(prefix.length + 1);
			if (self.state.handle(code, payload, Date.now())) { self.send(); }
		});
	},

	// Artwork goes after the state: the front end clears the art when the
	// track changes. Nothing is sent while the front end is hidden; the state
	// is still kept up to date (unless disconnected) for the next RESUME.
	send: function() {
		if (this.suspended) { return; }
		const s = this.state.snapshot(Date.now());
		this.sendSocketNotification("STATE", {
			active: s.active,
			playing: s.playing,
			title: s.title,
			artist: s.artist,
			album: s.album,
			sender: "",          // no device name over MQTT
			addedBy: "",
			airplay: s.active,
			positionMs: s.positionMs,
			durationMs: s.durationMs,
			volume: s.volume,
			artworkId: s.artworkId,
			queue: [],           // no up-next over MQTT
			history: s.history,
			queueIndex: 0,
			queueCount: 0
		});

		// Leave the art in place while the card animates out.
		if (s.active && s.artworkId !== this.lastArtworkId) {
			this.lastArtworkId = s.artworkId;
			this.sendSocketNotification("ARTWORK", {
				id: s.artworkId,
				dataUrl: s.artworkId ? this.state.track.artwork : null
			});
		}
	}

});
