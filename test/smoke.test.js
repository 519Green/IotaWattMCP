// End-to-end tests: start the real server over stdio against a mock IoTaWatt.

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMock } from "./mock-iotawatt.js";

const INDEX = fileURLToPath(new URL("../index.js", import.meta.url));

async function connect(port, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  for (const k of ["IOTAWATT_HOST", "IOTAWATT_USER", "IOTAWATT_PASSWORD"]) {
    if (!(k in extraEnv)) delete env[k];
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [INDEX, "--host", `127.0.0.1:${port}`],
    env,
    stderr: "ignore",
  });
  const client = new Client({ name: "smoke-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
const firstText = (result) => result.content[0].text;

describe("open device", () => {
  let mock, client;
  before(async () => {
    mock = await startMock();
    client = await connect(mock.port);
  });
  after(async () => {
    await client.close();
    await mock.close();
  });

  test("lists every tool, all marked read-only", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "discover", "energy_by_interval", "get_config", "query", "sample_waveform", "snapshot", "status", "watch",
    ]);
    for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true, t.name);
  });

  test("discover returns inputs with channel numbers and outputs", async () => {
    const d = JSON.parse(firstText(await call(client, "discover")));
    assert.deepEqual(d.inputs.map((i) => [i.name, i.unit, i.channel]), [
      ["Volts", "Volts", 0], ["Mains", "Watts", 1], ["Heater", "Watts", 2],
    ]);
    assert.deepEqual(d.outputs.map((o) => o.name), ["Total"]);
  });

  test("csv query comes back as plain lines, not a JSON-encoded string", async () => {
    const r = await call(client, "query", { select: ["time.local.iso", "Mains"], format: "csv", group: "10s" });
    const lines = firstText(r).split("\n");
    assert.equal(lines[0], "Time, Mains");
    assert.equal(lines.length, 6);
    assert.ok(!firstText(r).includes("\\r"));
    assert.equal(r.content.length, 1);
  });

  test("json query is valid JSON with one row per line", async () => {
    const r = await call(client, "query", { select: ["time.local.iso", "Mains", "Heater.pf"], group: "10s" });
    const parsed = JSON.parse(firstText(r));
    assert.deepEqual(parsed.labels, ["Time", "Mains", "Heater"]);
    assert.equal(parsed.data.length, 5);
    assert.equal(firstText(r).split("\n").length, 7);
  });

  test("a result cut short at the row limit is flagged", async () => {
    for (const format of ["csv", "json"]) {
      const r = await call(client, "query", { select: ["time.local.iso", "Mains"], format, limit: 2 });
      assert.equal(r.content.length, 2, format);
      assert.match(r.content[1].text, /row limit/);
      assert.match(r.content[1].text, /2026-01-01T00:00:20/);
      assert.ok(!firstText(r).includes("Limit exceeded"));
    }
    assert.ok(mock.hits.some((h) => h.includes("limit=2")));
  });

  test("snapshot and energy_by_interval use the discovered outputs", async () => {
    await call(client, "snapshot");
    await call(client, "energy_by_interval", { group: "1h" });
    assert.ok(mock.hits.some((h) => h.includes("Total") && h.includes("group=all")));
    assert.ok(mock.hits.some((h) => h.includes("Total.wh")));
  });

  test("watch returns one row per second with named columns", async () => {
    const r = await call(client, "watch", { seconds: 2, pf: true });
    const lines = firstText(r).split("\n");
    assert.equal(lines[0], "time_utc, Volts, Mains, Mains.pf, Heater, Heater.pf");
    assert.equal(lines.length, 3);
    assert.match(lines[1], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ, 120\.5, 512, 0\.95, 1500, 1\.00$/);
  });

  test("watch rejects an unknown input by name", async () => {
    const r = await call(client, "watch", { seconds: 1, channels: ["Nope"] });
    assert.equal(r.isError, true);
    assert.match(firstText(r), /Unknown input.*Nope.*Valid inputs: Volts, Mains, Heater/);
  });

  test("sample_waveform measures the lag and third harmonic of a known wave", async () => {
    const r = await call(client, "sample_waveform", { channel: "Mains" });
    const s = JSON.parse(firstText(r));
    assert.equal(s.samples, 640);
    assert.ok(Math.abs(s.current_lag_deg - 30) < 0.5, `lag ${s.current_lag_deg}`);
    assert.ok(Math.abs(s.harmonics_pct_of_fundamental.h3 - 30) < 0.5, `h3 ${s.harmonics_pct_of_fundamental.h3}`);
    assert.ok(s.harmonics_pct_of_fundamental.h5 < 0.5);
    assert.ok(Math.abs(s.thd_pct - 30) < 0.5, `thd ${s.thd_pct}`);
    assert.equal(s.ct_reversed, false);
    assert.equal(r.content[1].text.split("\n").length, 641);
  });

  test("sample_waveform accepts a channel number and refuses a voltage input", async () => {
    const byNumber = await call(client, "sample_waveform", { channel: "2", include_samples: false });
    assert.equal(JSON.parse(firstText(byNumber)).input, "Heater");
    assert.equal(byNumber.content.length, 1);
    const vt = await call(client, "sample_waveform", { channel: "Volts" });
    assert.equal(vt.isError, true);
    assert.match(firstText(vt), /voltage input/);
  });
});

describe("password-protected device", () => {
  let mock;
  before(async () => { mock = await startMock({ password: "s3cret" }); });
  after(async () => { await mock.close(); });

  test("without a password, tools explain what to set", async () => {
    const client = await connect(mock.port);
    const r = await call(client, "status");
    assert.equal(r.isError, true);
    assert.match(firstText(r), /IOTAWATT_PASSWORD/);
    await client.close();
  });

  test("with the admin password, every endpoint works", async () => {
    const client = await connect(mock.port, { IOTAWATT_PASSWORD: "s3cret" });
    const d = JSON.parse(firstText(await call(client, "discover")));
    assert.equal(d.inputs.length, 3);
    const q = await call(client, "query", { select: ["time.local.iso", "Mains"], format: "csv" });
    assert.equal(firstText(q).split("\n")[0], "Time, Mains");
    const w = await call(client, "sample_waveform", { channel: "Mains", include_samples: false });
    assert.equal(JSON.parse(firstText(w)).samples, 640);
    await client.close();
  });

  test("a wrong password is reported as rejected credentials", async () => {
    const client = await connect(mock.port, { IOTAWATT_PASSWORD: "wrong" });
    const r = await call(client, "status");
    assert.equal(r.isError, true);
    assert.match(firstText(r), /rejected the credentials/);
    await client.close();
  });

  test("the user account can query but not sample waveforms", async () => {
    const client = await connect(mock.port, { IOTAWATT_USER: "user", IOTAWATT_PASSWORD: "s3cret" });
    const q = await call(client, "query", { select: ["time.local.iso", "Mains"], format: "csv" });
    assert.notEqual(q.isError, true);
    const w = await call(client, "sample_waveform", { channel: "Mains" });
    assert.equal(w.isError, true);
    assert.match(firstText(w), /admin user/);
    await client.close();
  });
});
