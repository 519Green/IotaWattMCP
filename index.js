#!/usr/bin/env node
/**
 * IoTaWatt MCP Server
 * Channel discovery uses /config.txt (input names) + /status?outputs (output names/units).
 * Usage: node index.js --host <ip-or-hostname>   (or set IOTAWATT_HOST)
 * Optional: IOTAWATT_PASSWORD (and IOTAWATT_USER, default "admin") for password-protected devices.
 */

import { createHash, randomBytes } from "node:crypto";
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
const BASE = /^https?:\/\//i.test(HOST) ? HOST.replace(/\/+$/, "") : `http://${HOST}`;
const PASSWORD = getArg("--password", process.env.IOTAWATT_PASSWORD);
const USER = getArg("--user", process.env.IOTAWATT_USER) || "admin";

// ─── Digest authentication ────────────────────────────────────────────────────
// IoTaWatt uses HTTP Digest (MD5, qop=auth) with the device name as the realm.
// The challenge is cached and reused until the device asks for a new one.

const md5 = (s) => createHash("md5").update(s).digest("hex");
let digest = null; // { realm, nonce, nc }

function setChallenge(header) {
  if (!/^\s*Digest/i.test(header || "")) return false;
  const get = (key) => (header.match(new RegExp(`${key}="?([^",]+)"?`, "i")) || [])[1];
  const realm = get("realm");
  const nonce = get("nonce");
  if (!realm || !nonce) return false;
  digest = { realm, nonce, nc: 0 };
  return true;
}

function authHeaders(method, uri) {
  if (!PASSWORD || !digest) return {};
  const nc = (++digest.nc).toString(16).padStart(8, "0");
  const cnonce = randomBytes(8).toString("hex");
  const ha1 = md5(`${USER}:${digest.realm}:${PASSWORD}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = md5(`${ha1}:${digest.nonce}:${nc}:${cnonce}:auth:${ha2}`);
  // uri goes last: the firmware finds each field by substring search, and a
  // query string could otherwise shadow a later field.
  return {
    Authorization:
      `Digest username="${USER}", realm="${digest.realm}", nonce="${digest.nonce}", ` +
      `qop=auth, nc=${nc}, cnonce="${cnonce}", response="${response}", uri="${uri}"`,
  };
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
class IotaError extends Error {}

async function iotaFetch(path, { timeoutMs = 10_000 } = {}) {
  const url = `${BASE}${path}`;
  const get = () => fetch(url, { headers: authHeaders("GET", path), signal: AbortSignal.timeout(timeoutMs) });
  let res;
  let body;
  try {
    res = await get();
    if (res.status === 401) {
      const challenge = res.headers.get("www-authenticate");
      await res.arrayBuffer().catch(() => {});
      if (!PASSWORD) {
        throw new IotaError("This IoTaWatt requires a password. Set IOTAWATT_PASSWORD (and IOTAWATT_USER if not \"admin\").");
      }
      if (!setChallenge(challenge)) {
        throw new IotaError("IoTaWatt returned 401 without a Digest challenge.");
      }
      res = await get();
      if (res.status === 401) {
        throw new IotaError(`IoTaWatt rejected the credentials for user "${USER}". Some endpoints need the admin user.`);
      }
    }
    body = await res.text();
  } catch (err) {
    if (err instanceof IotaError) throw err;
    throw new Error(`IoTaWatt unreachable at ${HOST}: ${err.message}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${body.slice(0, 200)}`);
  const ct = res.headers.get("content-type") || "";
  return ct.includes("json") ? JSON.parse(body) : body;
}

function buildQueryUrl({ select, begin = "d", end = "s", group = "1h", format = "json", header = "yes", missing = "null", limit }) {
  const qs = new URLSearchParams({
    select: "[" + select.join(",") + "]",
    begin, end, group, format, header, missing,
  });
  if (limit) qs.set("limit", String(limit));
  return `/query?${qs}`;
}

// ─── Result formatting ────────────────────────────────────────────────────────
const text = (t) => ({ type: "text", text: t });
const asJson = (data) => ({ content: [text(JSON.stringify(data, null, 2))] });

// Query results are returned one row per line. JSON stays valid JSON.
// The device marks a result it cut short at the row limit; that is reported
// as a separate note so a truncated result is not mistaken for a complete one.
function formatQuery(data) {
  let body;
  let cutAt = null;
  if (typeof data === "string") {
    body = data.replace(/\r\n/g, "\n").trimEnd();
    const m = body.match(/\n?Limit exceeded at (\d+)$/);
    if (m) {
      cutAt = Number(m[1]);
      body = body.slice(0, m.index);
    }
  } else if (data && Array.isArray(data.data)) {
    const { data: rows, limit, ...meta } = data;
    if (limit) cutAt = Number(limit);
    const head = JSON.stringify(meta).slice(0, -1);
    body = `${head}${head.length > 1 ? "," : ""}"data":[\n${rows.map((r) => JSON.stringify(r)).join(",\n")}\n]}`;
  } else if (Array.isArray(data)) {
    body = `[\n${data.map((r) => JSON.stringify(r)).join(",\n")}\n]`;
  } else {
    body = JSON.stringify(data, null, 2);
  }
  const content = [text(body)];
  if (cutAt) {
    content.push(text(
      `Note: the device stopped at its row limit. Data from ${new Date(cutAt * 1000).toISOString().replace(".000Z", "Z")} (UTC) onward is missing. ` +
      "Narrow the time range, use a coarser group, or pass a higher limit."
    ));
  }
  return { content };
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
  if (configRaw.status === "rejected" && configRaw.reason instanceof IotaError) throw configRaw.reason;

  // Parse inputs from config.txt
  let inputs = [];
  if (configRaw.status === "fulfilled") {
    try {
      const cfg = typeof configRaw.value === "string"
        ? JSON.parse(configRaw.value)
        : configRaw.value;
      inputs = (cfg.inputs || [])
        .filter(i => i !== null && i.name)
        .map(i => ({ name: i.name, unit: i.type === "VT" ? "Volts" : "Watts", type: "input", channel: i.channel }));
    } catch { /* config parse failed */ }
  }

  // Parse outputs from /status?outputs
  let outputs = [];
  if (statusData.status === "fulfilled") {
    outputs = (statusData.value?.outputs || [])
      .map(o => ({ name: o.name, unit: o.units, type: "output" }));
  }

  const found = {
    inputs,
    outputs,
    all: [...inputs, ...outputs],
    inputNames:  inputs.map(i => i.name),
    outputNames: outputs.map(o => o.name),
  };

  // Only cache a complete answer, so a failed fetch is retried on the next call.
  if (configRaw.status === "fulfilled" && statusData.status === "fulfilled") channelCache = found;

  process.stderr.write(
    `[iotawatt-mcp] Discovered ${inputs.length} inputs, ${outputs.length} outputs from ${HOST}\n`
  );

  return found;
}

// ─── Waveform analysis ────────────────────────────────────────────────────────
// One AC cycle of raw voltage/current ADC counts. Returns shape metrics that
// do not depend on calibration: crest factor, harmonics, phase angle.

function analyzeWaveform(V, I) {
  const n = V.length;
  const mean = (a) => a.reduce((s, x) => s + x, 0) / n;
  const mv = mean(V), mi = mean(I);
  const v = V.map((x) => x - mv), i = I.map((x) => x - mi);
  const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / n);
  const vRms = rms(v), iRms = rms(i);
  const iPeak = i.reduce((m, x) => Math.max(m, Math.abs(x)), 0);

  // Single-bin DFT at harmonic k. Returns rms amplitude and phase (radians).
  const bin = (a, k) => {
    let re = 0, im = 0;
    for (let t = 0; t < n; t++) {
      const w = (2 * Math.PI * k * t) / n;
      re += a[t] * Math.cos(w);
      im -= a[t] * Math.sin(w);
    }
    return { rms: (Math.sqrt(re * re + im * im) / n) * Math.SQRT2, phase: Math.atan2(im, re) };
  };

  const v1 = bin(v, 1), i1 = bin(i, 1);
  let angle = ((v1.phase - i1.phase) * 180) / Math.PI;
  while (angle > 180) angle -= 360;
  while (angle <= -180) angle += 360;
  const reversed = Math.abs(angle) > 90;
  if (reversed) angle -= 180 * Math.sign(angle);

  const pct = (k) => (i1.rms > 0 ? (bin(i, k).rms / i1.rms) * 100 : 0);
  const thd = i1.rms > 0 ? (Math.sqrt(Math.max(0, iRms * iRms - i1.rms * i1.rms)) / i1.rms) * 100 : 0;
  const realPower = v.reduce((s, x, t) => s + x * i[t], 0) / n;
  const r = (x, d = 1) => Number(x.toFixed(d));

  return {
    samples: n,
    v_rms_counts: r(vRms),
    i_rms_counts: r(iRms),
    i_peak_counts: r(iPeak),
    crest_factor: iRms > 0 ? r(iPeak / iRms, 2) : null,
    power_factor: vRms > 0 && iRms > 0 ? r(Math.abs(realPower) / (vRms * iRms), 3) : null,
    current_lag_deg: r(angle),
    harmonics_pct_of_fundamental: { h3: r(pct(3)), h5: r(pct(5)), h7: r(pct(7)) },
    thd_pct: r(thd),
    ct_reversed: reversed,
    low_signal: iRms < 3,
  };
}

// ─── MCP Server ───────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "iotawatt",
  version: "1.3.0",
  description: `IoTaWatt energy monitor MCP server (device: ${HOST})`,
});

// Every tool only reads from one local device.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

const SELECT_HELP =
  'Series to return. Put "time.local.iso" first for timestamps. A bare channel name returns its default unit ' +
  "(Watts for power channels, Volts for voltage). Append a unit to change it: .watts .wh .amps .va .var .varh .pf " +
  "for power channels, .volts .hz for voltage. Append .d2 (or another digit) to set decimal places, e.g. Mains.pf.d3.";
const GROUP_HELP =
  "Aggregation interval: seconds in multiples of 5 (5s, 10s, 30s), then 1m, 5m, 15m, 1h, 1d, 1w, 1M, 1y, " +
  '"auto", or "all" for a single row. 5 second data is kept for about a year, 1 minute data for longer.';
const BEGIN_HELP =
  "Start time: d=today midnight, d-7d=7 days ago, s-3600s=1hr ago, 2026-02-17T06:00 (no seconds: firmware bug)";

// ── discover ──────────────────────────────────────────────────────────────────
server.registerTool(
  "discover",
  {
    description: "List all IoTaWatt inputs (physical CTs/VTs) and calculated outputs with their units. Always call this first to learn what channels are available before querying.",
    annotations: READ_ONLY,
  },
  async () => {
    channelCache = null; // force fresh fetch
    const ch = await getChannels();
    return asJson({ host: HOST, inputs: ch.inputs, outputs: ch.outputs });
  }
);

// ── status ────────────────────────────────────────────────────────────────────
server.registerTool(
  "status",
  {
    description: "IoTaWatt device status: firmware version, uptime, WiFi SSID/RSSI/IP, heap memory, AC frequency, and data log ranges.",
    annotations: READ_ONLY,
  },
  async () => asJson(await iotaFetch("/status?state&inputs&outputs&stats&wifi&datalogs"))
);

// ── get_config ────────────────────────────────────────────────────────────────
server.registerTool(
  "get_config",
  {
    description: "Get the full IoTaWatt device configuration from /config.txt: input channel definitions (names, CT models, calibration factors) and output scripts showing how calculated values are derived.",
    annotations: READ_ONLY,
  },
  async () => {
    const data = await iotaFetch("/config.txt");
    return { content: [text(typeof data === "string" ? data : JSON.stringify(data, null, 2))] };
  }
);

// ── snapshot ──────────────────────────────────────────────────────────────────
server.registerTool(
  "snapshot",
  {
    description: "Latest instantaneous power: a single averaged value over the last 5 minutes. Defaults to all discovered output channels. Optionally restrict to specific channels.",
    inputSchema: {
      channels: z.array(z.string()).optional()
        .describe("Specific channel names to include. If omitted, all calculated outputs are returned."),
    },
    annotations: READ_ONLY,
  },
  async ({ channels }) => {
    const ch = await getChannels();
    const names = channels ?? ch.outputNames;
    if (names.length === 0) throw new Error("No channels discovered. Call discover() first, or pass explicit channel names.");
    return formatQuery(await iotaFetch(buildQueryUrl({
      select: ["time.local.iso", ...names],
      begin: "s-300s", end: "s", group: "all",
    })));
  }
);

// ── query ─────────────────────────────────────────────────────────────────────
server.registerTool(
  "query",
  {
    description: "Flexible IoTaWatt time-series query against the on-device log. Use discover first to know valid channel names. Results come back one row per line. The device stops sampling while it answers, so prefer a few well-scoped queries.",
    inputSchema: {
      select: z.array(z.string()).describe(SELECT_HELP),
      begin: z.string().default("d").describe(BEGIN_HELP),
      end: z.string().default("s")
        .describe("End time: s=now, d+1d=end of today"),
      group: z.string().default("1h").describe(GROUP_HELP),
      format: z.enum(["json", "csv"]).default("json")
        .describe("csv is more compact for long results."),
      missing: z.enum(["null", "zero", "skip"]).default("null"),
      limit: z.number().int().min(1).max(20000).optional()
        .describe("Maximum rows. The device default is 1000. A result cut short at the limit is flagged with a note."),
    },
    annotations: READ_ONLY,
  },
  async ({ select, begin, end, group, format, missing, limit }) =>
    formatQuery(await iotaFetch(buildQueryUrl({ select, begin, end, group, format, missing, limit }), { timeoutMs: 30_000 }))
);

// ── energy_by_interval ────────────────────────────────────────────────────────
server.registerTool(
  "energy_by_interval",
  {
    description: "Energy consumption (Wh) broken down by interval for all or selected output channels. Use for today's hourly breakdown, daily totals, etc.",
    inputSchema: {
      channels: z.array(z.string()).optional()
        .describe("Channels to include (without .wh, which is appended automatically). Defaults to all discovered outputs."),
      begin: z.string().default("d")
        .describe("Start time: d=today, d-30d=30 days ago, d-7d=last week"),
      end: z.string().default("s"),
      group: z.string().default("1h")
        .describe("Interval: 15m, 30m, 1h, 1d, 1w"),
    },
    annotations: READ_ONLY,
  },
  async ({ channels, begin, end, group }) => {
    const ch = await getChannels();
    const names = channels ?? ch.outputNames;
    if (names.length === 0) throw new Error("No channels discovered. Call discover() first, or pass explicit channel names.");
    return formatQuery(await iotaFetch(buildQueryUrl({
      select: ["time.local.iso", ...names.map(n => `${n}.wh`)],
      begin, end, group,
    }), { timeoutMs: 30_000 }));
  }
);

// ── watch ─────────────────────────────────────────────────────────────────────
server.registerTool(
  "watch",
  {
    description: "Live view at 1 second resolution, finer than the stored log. Polls the device once a second for the given number of seconds and returns one CSV row per second with the watts on each input (volts for a voltage input). Use it to catch an appliance being switched on or off right now. The call takes as long as the duration asked for.",
    inputSchema: {
      seconds: z.number().int().min(1).max(120).default(30)
        .describe("How long to watch, 1 to 120 seconds."),
      channels: z.array(z.string()).optional()
        .describe("Input names to include. Defaults to all inputs."),
      pf: z.boolean().default(false)
        .describe("Also return the power factor of each power input, as <name>.pf columns."),
    },
    annotations: READ_ONLY,
  },
  async ({ seconds, channels, pf }) => {
    const ch = await getChannels();
    let inputs = ch.inputs.filter((i) => Number.isInteger(i.channel));
    if (channels) {
      const unknown = channels.filter((c) => !ch.inputNames.includes(c));
      if (unknown.length) throw new Error(`Unknown input(s): ${unknown.join(", ")}. Valid inputs: ${ch.inputNames.join(", ")}`);
      inputs = inputs.filter((i) => channels.includes(i.name));
    }
    if (inputs.length === 0) throw new Error("No inputs discovered. Call discover() first.");

    const header = ["time_utc"];
    for (const i of inputs) {
      header.push(i.name);
      if (pf && i.unit === "Watts") header.push(`${i.name}.pf`);
    }
    const rows = [header.join(", ")];
    let failed = 0;
    const start = Date.now();
    for (let n = 0; n < seconds; n++) {
      const wait = start + n * 1000 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      let s;
      try {
        s = await iotaFetch("/status?inputs&stats", { timeoutMs: 3000 });
      } catch (err) {
        if (n === 0) throw err;
        failed++;
        continue;
      }
      const byChannel = new Map((s.inputs || []).map((i) => [i.channel, i]));
      const t = s.stats?.currenttime ? new Date(s.stats.currenttime * 1000) : new Date();
      const row = [t.toISOString().replace(".000Z", "Z")];
      for (const i of inputs) {
        const r = byChannel.get(i.channel) || {};
        if (i.unit === "Volts") {
          row.push(r.Vrms != null ? Number(r.Vrms).toFixed(1) : "");
        } else {
          row.push(r.Watts != null ? String(r.Watts).trim() : "");
          if (pf) row.push(r.Pf != null ? Number(r.Pf).toFixed(2) : "");
        }
      }
      rows.push(row.join(", "));
    }
    const content = [text(rows.join("\n"))];
    if (failed) content.push(text(`Note: ${failed} of ${seconds} polls failed and are missing from the rows above.`));
    return { content };
  }
);

// ── sample_waveform ───────────────────────────────────────────────────────────
server.registerTool(
  "sample_waveform",
  {
    description: "Capture one AC cycle of raw voltage and current samples (about 640 pairs) from a single CT input and describe the shape of the current: crest factor, 3rd/5th/7th harmonics, distortion and phase lag. This shows what kind of load is on the circuit right now: a heater draws a clean sine in phase with voltage, a motor lags, electronics draw a peaky current rich in harmonics. It is a snapshot of everything on that CT, not of one appliance. Values are raw ADC counts, not amps or volts, and have no CT/VT phase correction, so angles are approximate. Needs the admin user on a password-protected device.",
    inputSchema: {
      channel: z.string()
        .describe("Input name from discover, or the input's channel number."),
      include_samples: z.boolean().default(true)
        .describe("Include the raw V,I sample pairs after the summary."),
    },
    annotations: READ_ONLY,
  },
  async ({ channel, include_samples }) => {
    const ch = await getChannels();
    const input = ch.inputs.find((i) => i.name === channel) ?? ch.inputs.find((i) => String(i.channel) === channel.trim());
    if (!input) throw new Error(`Unknown input "${channel}". Valid inputs: ${ch.inputNames.join(", ")}`);
    if (input.unit !== "Watts") throw new Error(`"${input.name}" is a voltage input. Pick a CT input.`);

    const raw = await iotaFetch(`/command?sample=${input.channel}`);
    const lines = String(raw).trim().split(/\r?\n/);
    const m = lines[0].match(/^samples (\d+)/);
    if (!m) throw new Error(`Device did not return samples: ${String(raw).slice(0, 120)}`);
    const count = Number(m[1]);
    // The device appends one extra pair, the first sample of the next cycle.
    const pairs = lines.slice(1, 1 + count).map((l) => l.split(",").map(Number));
    if (pairs.length < 16 || pairs.some((p) => p.length !== 2 || p.some(Number.isNaN))) {
      throw new Error("Device returned an incomplete or malformed sample set.");
    }
    const summary = {
      input: input.name,
      channel: input.channel,
      ...analyzeWaveform(pairs.map((p) => p[0]), pairs.map((p) => p[1])),
    };
    const content = [text(JSON.stringify(summary, null, 2))];
    if (include_samples) content.push(text("V,I\n" + pairs.map((p) => p.join(",")).join("\n")));
    return { content };
  }
);

// ─── Startup: pre-warm channel cache ─────────────────────────────────────────
try {
  await getChannels();
} catch (err) {
  process.stderr.write(`[iotawatt-mcp] WARNING: Could not pre-warm channel cache (${err.message}). Tools will retry on first use.\n`);
}

const transport = new StdioServerTransport();
await server.connect(transport);
