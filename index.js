#!/usr/bin/env node
/**
 * IoTaWatt MCP Server
 * Channel discovery uses /config.txt (input names) + /status?outputs (output names/units).
 * Usage: node index.js --host <ip-or-hostname>   (or set IOTAWATT_HOST)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ─── Config ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const HOST = getArg("--host", process.env.IOTAWATT_HOST);
if (!HOST) {
  process.stderr.write("[iotawatt-mcp] ERROR: No host specified.\n");
  process.stderr.write("[iotawatt-mcp] Usage: node index.js --host <ip-or-hostname>\n");
  process.stderr.write("[iotawatt-mcp]    or: IOTAWATT_HOST=<ip-or-hostname> node index.js\n");
  process.exit(1);
}
const BASE = `http://${HOST}`;

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
async function iotaFetch(path) {
  const url = `${BASE}${path}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    const ct = res.headers.get("content-type") || "";
    return ct.includes("json") ? res.json() : res.text();
  } catch (err) {
    throw new Error(`IoTaWatt unreachable at ${HOST}: ${err.message}`);
  }
}

function buildQueryUrl({ select, begin = "d", end = "s", group = "1h", format = "json", header = "yes", missing = "null" }) {
  const qs = new URLSearchParams({
    select: "[" + select.join(",") + "]",
    begin, end, group, format, header, missing,
  });
  return `/query?${qs}`;
}

// ─── Channel discovery ────────────────────────────────────────────────────────
// /config.txt has input channel definitions (name, type, model)
// /status?outputs has calculated output names and current units
// These are fetched in parallel and merged.

let channelCache = null;

async function getChannels() {
  if (channelCache) return channelCache;

  const [configRaw, statusData] = await Promise.allSettled([
    iotaFetch("/config.txt"),
    iotaFetch("/status?outputs"),
  ]);

  // Parse inputs from config.txt
  let inputs = [];
  if (configRaw.status === "fulfilled") {
    try {
      const cfg = typeof configRaw.value === "string"
        ? JSON.parse(configRaw.value)
        : configRaw.value;
      inputs = (cfg.inputs || [])
        .filter(i => i !== null && i.name)
        .map(i => ({ name: i.name, unit: i.type === "VT" ? "Volts" : "Watts", type: "input" }));
    } catch { /* config parse failed */ }
  }

  // Parse outputs from /status?outputs
  let outputs = [];
  if (statusData.status === "fulfilled") {
    outputs = (statusData.value?.outputs || [])
      .map(o => ({ name: o.name, unit: o.units, type: "output" }));
  }

  channelCache = {
    inputs,
    outputs,
    all: [...inputs, ...outputs],
    inputNames:  inputs.map(i => i.name),
    outputNames: outputs.map(o => o.name),
  };

  process.stderr.write(
    `[iotawatt-mcp] Discovered ${inputs.length} inputs, ${outputs.length} outputs from ${HOST}\n`
  );

  return channelCache;
}

// ─── MCP Server ───────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "iotawatt",
  version: "1.2.0",
  description: `IoTaWatt energy monitor MCP server (device: ${HOST})`,
});

// ── discover ──────────────────────────────────────────────────────────────────
server.tool(
  "discover",
  "List all IoTaWatt inputs (physical CTs/VTs) and calculated outputs with their units. Always call this first to learn what channels are available before querying.",
  {},
  async () => {
    channelCache = null; // force fresh fetch
    const ch = await getChannels();
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ host: HOST, inputs: ch.inputs, outputs: ch.outputs }, null, 2),
      }],
    };
  }
);

// ── status ────────────────────────────────────────────────────────────────────
server.tool(
  "status",
  "IoTaWatt device status: firmware version, uptime, WiFi SSID/RSSI/IP, heap memory, AC frequency, and data log ranges.",
  {},
  async () => {
    const data = await iotaFetch("/status?state&inputs&outputs&stats&wifi&datalogs");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── get_config ────────────────────────────────────────────────────────────────
server.tool(
  "get_config",
  "Get the full IoTaWatt device configuration from /config.txt: input channel definitions (names, CT models, calibration factors) and output scripts showing how calculated values are derived.",
  {},
  async () => {
    const data = await iotaFetch("/config.txt");
    return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
  }
);

// ── snapshot ──────────────────────────────────────────────────────────────────
server.tool(
  "snapshot",
  "Latest instantaneous power: a single averaged value over the last 5 minutes. Defaults to all discovered output channels. Optionally restrict to specific channels.",
  {
    channels: z.array(z.string()).optional()
      .describe("Specific channel names to include. If omitted, all calculated outputs are returned."),
  },
  async ({ channels }) => {
    const ch = await getChannels();
    const names = channels ?? ch.outputNames;
    if (names.length === 0) throw new Error("No channels discovered. Call discover() first, or pass explicit channel names.");
    const data = await iotaFetch(buildQueryUrl({
      select: ["time.local.iso", ...names],
      begin: "s-300s", end: "s", group: "all",
    }));
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── query ─────────────────────────────────────────────────────────────────────
server.tool(
  "query",
  "Flexible IoTaWatt time-series query. Use discover first to know valid channel names.",
  {
    select: z.array(z.string())
      .describe('Channels to query. Always include "time.local.iso" as first item. Append .wh for energy (Wh), .d2 for 2 decimal places.'),
    begin: z.string().default("d")
      .describe("Start time: d=today midnight, d-7d=7 days ago, s-3600s=1hr ago, 2026-02-17T06:00 (no seconds: firmware bug)"),
    end: z.string().default("s")
      .describe("End time: s=now, d+1d=end of today"),
    group: z.string().default("1h")
      .describe("Aggregation interval: 5m, 15m, 30m, 1h, 1d, 1w, all"),
    format: z.enum(["json", "csv"]).default("json"),
    missing: z.enum(["null", "zero", "skip"]).default("null"),
  },
  async ({ select, begin, end, group, format, missing }) => {
    const data = await iotaFetch(buildQueryUrl({ select, begin, end, group, format, missing }));
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── energy_by_interval ────────────────────────────────────────────────────────
server.tool(
  "energy_by_interval",
  "Energy consumption (Wh) broken down by interval for all or selected output channels. Use for today's hourly breakdown, daily totals, etc.",
  {
    channels: z.array(z.string()).optional()
      .describe("Channels to include (without .wh, which is appended automatically). Defaults to all discovered outputs."),
    begin: z.string().default("d")
      .describe("Start time: d=today, d-30d=30 days ago, d-7d=last week"),
    end: z.string().default("s"),
    group: z.string().default("1h")
      .describe("Interval: 15m, 30m, 1h, 1d, 1w"),
  },
  async ({ channels, begin, end, group }) => {
    const ch = await getChannels();
    const names = channels ?? ch.outputNames;
    if (names.length === 0) throw new Error("No channels discovered. Call discover() first, or pass explicit channel names.");
    const data = await iotaFetch(buildQueryUrl({
      select: ["time.local.iso", ...names.map(n => `${n}.wh`)],
      begin, end, group,
    }));
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ─── Startup: pre-warm channel cache ─────────────────────────────────────────
try {
  await getChannels();
} catch {
  process.stderr.write(`[iotawatt-mcp] WARNING: Could not pre-warm channel cache. Tools will retry on first use.\n`);
}

const transport = new StdioServerTransport();
await server.connect(transport);