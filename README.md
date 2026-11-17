# MMM-ShairportMetadata
A module to integrate AirPlay metadata coming via <a href="https://github.com/mikebrady/shairport-sync">`shairport-sync`</a> into the <a href="https://github.com/MichMich/MagicMirror">MagicMirror</a>. This plugin does not work with video streaming or screen mirroring.

The module reads shairport-sync's metadata from an MQTT broker. AirPlay 2 senders such as Apple Music provide the exact playback position, so the progress bar stays in step through pauses, seeks and track changes.

## Preview
![preview](preview.jpg)

## Installation
``` sh
cd ~/MagicMirror/modules
git clone https://github.com/surekap/MMM-ShairportMetadata.git
cd MMM-ShairportMetadata
npm install
```

You also need an MQTT broker, e.g. Mosquitto on the same machine:
``` sh
sudo apt install mosquitto
```

## Using the module
Add `MMM-ShairportMetadata` module to the `modules` array in the `config/config.js` file:
``` javascript
modules: [
  {
    module: 'MMM-ShairportMetadata',
    position: 'bottom_left',
    config: {
      mqttUrl: "mqtt://localhost:1883", // MQTT broker shairport-sync publishes to
      mqttTopic: "shairport",           // must match "topic" in shairport-sync's mqtt settings
      alignment: "center",              // Possible values [left|right|center]. Default: center
    }
  },
]
```

The card appears when playback starts and hides as soon as the playing device disconnects.

The attribution line and "Up next" list need data that shairport-sync's MQTT output doesn't carry (sender name, queue), so they stay hidden; "Recently played" lists the tracks this module has seen.

| Option | Default | Description |
|---|---|---|
| `mqttUrl` | `mqtt://localhost:1883` | MQTT broker |
| `mqttTopic` | `shairport` | shairport-sync's mqtt `topic` |
| `alignment` | `center` | card alignment in its region |
| `height` | `700` | px reserved for the card, which sits at the top of it, so it stays put while the volume bar and list grow below it (in a `bottom_*` region it would otherwise grow upward). Raise it if you raise `queueLimit`; `0` = no reserve |
| `showHistory` | `true` | "Recently played" list under the card |
| `queueLimit` | `4` | max rows in the list |
| `showVolume` | `true` | volume bar showing the sender's volume slider (`ssnc/pvol`) |
| `volumeHideAfterMs` | `3000` | the volume bar opens when the volume changes and folds away after this long; `0` keeps it shown |
| `driftResyncSec` | `2` | re-arm the progress bar only past this drift |
| `leaveDurationMs` | `470` | length of the leave animation |
| `showAttribution`, `showQueue`, `showQueuePosition` | `true` | attribution line, up-next list, queue position; no data over MQTT yet |
| `disconnectOnSuspend` | `false` | what `node_helper` does while the module is hidden, see below |

## While hidden
When another module hides this one (`module.hide()`), MagicMirror calls `suspend()` and the front end stops completely: the one-second clock, the volume and leave timers and the progress bar's animation all stop, and `node_helper` sends it nothing. `resume()` starts them again and asks `node_helper` for the current state.

- `disconnectOnSuspend: false` (default): `node_helper` keeps its MQTT connection and keeps track of what is playing, so the card is correct as soon as the module is shown again. It only does work when shairport-sync publishes something.
- `disconnectOnSuspend: true`: `node_helper` also disconnects from the broker, so nothing runs at all. shairport-sync does not repeat what was missed, so after a resume the card stays away until the sender's next now-playing update (usually the next track change, play or pause), and tracks played while hidden are missing from "Recently played".

## Integration with shairport-sync
shairport-sync must be built with MQTT support (`shairport-sync -V` lists `mqtt`). Example configuration:
```
metadata =
{
	enabled = "yes";
	include_cover_art = "yes";
};

mqtt =
{
	enabled = "yes";
	hostname = "localhost";
	port = 1883;
	topic = "shairport";
	publish_raw = "yes";     // the module only uses the raw topics
	publish_parsed = "no";
	publish_cover = "no";
};
```

## Troubleshooting
Check that shairport-sync is publishing while something plays:
``` sh
mosquitto_sub -v -t 'shairport/#' -F '%t  %l bytes'
```

To see what the module makes of a session, record one and replay it:
``` sh
mosquitto_sub -t 'shairport/#' -F '%U %t %x' > session.txt
node test/replay.js session.txt
```
