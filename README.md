# IoTaWatt MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server for the
[IoTaWatt](https://iotawatt.com) open-source energy monitor. It lets an MCP
client such as Claude Code or Claude Desktop read live power, query the
on-device history log, inspect the device configuration, and look at the
shape of the current on a circuit.

All tools are read-only. The server talks to the IoTaWatt's local HTTP API
and needs no cloud account.

This project is not affiliated with or endorsed by IoTaWatt, Inc.

## Requirements

- Node.js 18 or newer
- An IoTaWatt reachable over HTTP from the machine running the server

## Install

```sh
git clone https://github.com/519Green/IotaWattMCP.git
cd IotaWattMCP
npm install
```

## Configure

The device address is given with `--host` or the `IOTAWATT_HOST` environment
variable. Use an IP address or hostname, for example `192.168.1.50` or
`iotawatt.local`. A full URL such as `https://iotawatt.example.net` also
works if the device sits behind a proxy.

### Claude Code

Add to `.mcp.json` in your project, or to your user configuration:

```json
{
  "mcpServers": {
    "iotawatt": {
      "command": "node",
      "args": ["/path/to/IotaWattMCP/index.js", "--host", "192.168.1.50"]
    }
  }
}
```

### Claude Desktop

Add the same `iotawatt` block under `mcpServers` in
`claude_desktop_config.json`.

### Password-protected devices

If the IoTaWatt has passwords set, give the server one through the
environment:

```json
{
  "mcpServers": {
    "iotawatt": {
      "command": "node",
      "args": ["/path/to/IotaWattMCP/index.js", "--host", "192.168.1.50"],
      "env": { "IOTAWATT_PASSWORD": "your-admin-password" }
    }
  }
}
```

- The account defaults to `admin`. Set `IOTAWATT_USER` to `user` to use the
  device's restricted account instead. That account can do everything except
  `sample_waveform`.
- `--user` and `--password` flags also work, but command-line arguments are
  visible to other processes on the machine. Prefer the environment.
- The device uses HTTP Digest authentication, so the password is not sent in
  the clear. The data itself still travels over plain HTTP.

## Tools

| Tool | What it does |
|---|---|
| `discover` | Lists input channels (CTs and VTs) and calculated outputs with their units. Call this first. |
| `status` | Device status: firmware version, uptime, Wi-Fi, per-input readings, and data log ranges. |
| `get_config` | Returns the device's `config.txt`: input definitions, calibration, and output scripts. |
| `snapshot` | Average power over the last 5 minutes for all outputs or for named channels. |
| `query` | Time-series query against the on-device log. |
| `energy_by_interval` | Energy in Wh per interval for all outputs or for named channels. |
| `watch` | Live readings once a second for up to two minutes, for catching something as it switches. |
| `sample_waveform` | One AC cycle of raw voltage and current from a CT, with harmonics, distortion and phase lag. |

### Query notes

`query` passes its arguments to the IoTaWatt
[query API](https://docs.iotawatt.com/en/master/query.html).

- `select` is a list of series. Put `time.local.iso` first to get timestamps.
- Add a unit suffix to a channel name to change what is returned: `.watts`,
  `.wh`, `.amps`, `.va`, `.var`, `.varh` or `.pf` for power channels, `.volts`
  or `.hz` for voltage. Add `.d2` for two decimal places.
- `begin` and `end` accept relative times (`d` for today at midnight, `s` for
  now, `d-7d`, `s-3600s`) or absolute times such as `2026-02-17T06:00`. Leave
  the seconds off absolute times.
- `group` is the aggregation interval. Seconds must be a multiple of 5 (`5s`,
  `10s`, `30s`); then `1m`, `1h`, `1d` and so on, or `all` for one row.
- The device returns at most 1,000 rows unless you pass `limit`. When a result
  is cut short, the tool adds a note saying where the data stops.
- Results come back one row per line. `format: "csv"` is the more compact of
  the two.

### Waveform notes

`sample_waveform` describes the shape of the current, which says what kind of
load is running:

- A heater or kettle draws a clean sine wave in step with the voltage: low
  distortion, crest factor near 1.4, lag near zero.
- A motor or compressor lags the voltage.
- Electronics draw a narrow, peaky current: high crest factor and a large 3rd
  harmonic.

The numbers are raw ADC counts, not amps, and the capture is everything on
that CT at that instant, not a single appliance. Compare a capture with the
appliance on against one with it off.

## Example prompts

Once the server is connected, ask in plain language. The assistant picks the
tools. It helps to tell it what you already know, for example which appliances
are on which circuit.

### Getting oriented

- "What channels does my IoTaWatt have, and what does each one measure?"
- "Is the device healthy? Check the firmware version, uptime, Wi-Fi signal and
  how far back the logs go."
- "What is the house drawing right now, by circuit?"

### Energy use

- "How many kWh did each circuit use yesterday? Rank them."
- "Show hourly energy for the water heater over the last 7 days. When does it
  run most?"
- "Compare this week with last week, circuit by circuit."
- "What is my always-on load? Find the quietest hour of the past week and
  break it down by circuit."

### Finding appliances

- "Did the dryer run today? Look for a 240 V load of about 5 kW that cycles on
  and off."
- "Find the fridge's defrost cycles on the kitchen circuit over the last 3
  days. How often do they happen and how long do they last?"
- "Something drew about 1.5 kW for a few minutes around 3 pm. Which circuit
  was it on, and does the power factor look like a heater or a motor?"
- "How many times did the well pump run today, and how long was each run?"
- "Watch all circuits for the next 60 seconds. I am going to switch the space
  heater on, then off. Tell me which circuit it is on and how much it draws."
- "Sample the waveform on the office circuit. Is that load mostly electronics,
  motors or heating?"

### Checking the installation

- "Compare each subpanel's total against the mains that feed it. Do any CTs
  look reversed, mislabelled or on the wrong leg?"
- "Read my output formulas. Does anything get counted twice or left out?"

### Tips

- For short events, ask for fine resolution over a short window, such as 5
  second data for one hour. The device keeps 5 second data for about a year
  and 1 minute data for longer.
- A 240 V appliance shows up on two CTs at once, one per leg. A 120 V
  appliance shows up on one.
- Ask for a summary, not the raw rows. Long, fine-grained queries return a lot
  of data.

## Things to know

- **`get_config` returns the whole config file.** If you have uploaders
  configured (InfluxDB, Emoncms, PVoutput), that file can contain their URLs
  and credentials, and they will be passed to the MCP client.
- **Queries pause sampling.** The IoTaWatt documentation notes that the device
  does not sample power while it is answering a query. Prefer a few
  well-scoped queries over many large ones. `watch` is light by comparison:
  one small request a second.
- **Channel names are cached.** Call `discover` after changing inputs or
  outputs on the device.
- **Password support is tested against a mock,** built from the IoTaWatt
  firmware source, not against a real password-protected unit. Please open an
  issue if it fails on yours.

## Development

```sh
npm test
```

The tests start the server over stdio against a small mock IoTaWatt in
`test/mock-iotawatt.js`, so they need no device.

## License

ISC. See [LICENSE](LICENSE).
