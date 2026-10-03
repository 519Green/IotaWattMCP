# IoTaWatt MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server for the
[IoTaWatt](https://iotawatt.com) open-source energy monitor. It lets an MCP
client such as Claude Code or Claude Desktop read live power, query the
on-device history log, and inspect the device configuration.

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
`iotawatt.local`.

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

## Tools

| Tool | What it does |
|---|---|
| `discover` | Lists input channels (CTs and VTs) and calculated outputs with their units. Call this first. |
| `status` | Device status: firmware version, uptime, Wi-Fi, per-input readings, and data log ranges. |
| `get_config` | Returns the device's `config.txt`: input definitions, calibration, and output scripts. |
| `snapshot` | Average power over the last 5 minutes for all outputs or for named channels. |
| `query` | Time-series query against the IoTaWatt query API. |
| `energy_by_interval` | Energy in Wh per interval for all outputs or for named channels. |

### Query notes

`query` passes its arguments straight to the IoTaWatt
[query API](https://docs.iotawatt.com/en/master/query.html).

- `select` is a list of series. Put `time.local.iso` first to get timestamps.
- Add a unit suffix to a channel name to change what is returned, for example
  `Mains.wh`, `Mains.va`, `Mains.var`, `Mains.pf` or `Mains.amps`. Add `.d2`
  for two decimal places.
- `begin` and `end` accept relative times (`d` for today at midnight, `s` for
  now, `d-7d`, `s-3600s`) or absolute times such as `2026-02-17T06:00`. Leave
  the seconds off absolute times.
- `group` is the aggregation interval, for example `10s`, `5m`, `1h`, `1d` or
  `all`.
- The device returns at most 1,000 rows per request by default. Split long
  ranges into several queries.

## Things to know

- **No authentication.** The server sends plain HTTP requests with no
  credentials. It will not work against an IoTaWatt that has passwords set
  unless the device allows unauthenticated local access.
- **`get_config` returns the whole config file.** If you have uploaders
  configured (InfluxDB, Emoncms, PVoutput), that file can contain their URLs
  and credentials, and they will be passed to the MCP client.
- **Queries pause sampling.** The IoTaWatt documentation notes that the device
  does not sample power while it is answering a query. Prefer a few
  well-scoped queries over many large ones.
- **Channel names are cached** at startup. Call `discover` after changing
  inputs or outputs on the device.

## License

ISC. See [LICENSE](LICENSE).
