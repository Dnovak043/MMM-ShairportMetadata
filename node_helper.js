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
	},

	socketNotificationReceived: function(notification, payload) {
		if (notification !== "CONFIG") { return; }
		if (!this.client) { this.connect(payload); }
		// A (re)loaded browser needs the full state, artwork included.
		this.lastArtworkId = null;
		this.send();
	},

	connect: function(config) {
		const self = this;
		const prefix = config.mqttTopic.replace(/\/+$/, "");

		this.client = mqtt.connect(config.mqttUrl, { reconnectPeriod: 5000 });

		this.client.on("connect", function() {
			console.log(self.name + ": connected to " + config.mqttUrl);
			self.client.subscribe([prefix + "/ssnc/#", prefix + "/core/#"]);
		});

		this.client.on("error", function(err) {
			console.log(self.name + ": MQTT error: " + err.message);
		});

		this.client.on("message", function(topic, payload) {
			const code = topic.slice(prefix.length + 1);
			if (self.state.handle(code, payload, Date.now())) { self.send(); }
		});
	},

	// Artwork goes after the state: the front end clears the art when the
	// track changes.
	send: function() {
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
