import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { readRTCStatsDump } from '@rtcstats/rtcstats-shared';
import { evalInApp, openPage, startRun, stubSteps } from './helpers';

// figuresFrom() on fixed samples, run in the page (the module is the page's).
const figures = (page: import('@playwright/test').Page, samples: unknown[], kind: 'audio' | 'video', warmupMs = 0) =>
  evalInApp<Record<string, unknown>>(
    page,
    `const { figuresFrom, figuresLine } = await import('/src/services/networkTest.ts');
     const result = figuresFrom(${JSON.stringify(samples)}, '${kind}', ${warmupMs});
     return { ...result, line: figuresLine(result, null) };`,
  );

const stats = (over: Record<string, unknown>) => ({
  candidatePair: { localType: 'srflx', remoteType: 'host', protocol: 'udp', relayProtocol: null, currentRoundTripTimeMs: 40 },
  audioOutboundCodec: null, audioInboundCodec: null, videoOutboundCodec: null, videoInboundCodec: null,
  audioBytesSent: 0, audioBytesReceived: 0, videoBytesSent: 0, videoBytesReceived: 0,
  audioPacketsReceived: 0, audioPacketsLost: 0, videoPacketsReceived: 0, videoPacketsLost: 0,
  ...over,
});

const metrics = (jitter: number) => ({
  timestamp: 0, audio: { packetsReceived: 0, packetsLost: 0, jitter }, video: { packetsReceived: 0, packetsLost: 0 },
  roundTripTime: 99, availableOutgoingBitrate: 512_000,
});

test('per-second loss: a burst shows as the worst second, not only in the average', async ({ page }) => {
  await openPage(page);
  // Three one-second intervals of 50 packets each; the second loses 10.
  const samples = [
    { at: 0, stats: stats({ audioBytesSent: 0, audioBytesReceived: 0, audioPacketsReceived: 0, audioPacketsLost: 0 }), metrics: metrics(2) },
    { at: 1000, stats: stats({ audioBytesSent: 8000, audioBytesReceived: 8000, audioPacketsReceived: 50, audioPacketsLost: 0 }), metrics: metrics(4) },
    { at: 2000, stats: stats({ audioBytesSent: 16000, audioBytesReceived: 13000, audioPacketsReceived: 90, audioPacketsLost: 10 }), metrics: metrics(6) },
    { at: 3000, stats: stats({ audioBytesSent: 24000, audioBytesReceived: 21000, audioPacketsReceived: 140, audioPacketsLost: 10 }), metrics: metrics(2) },
  ];
  const result = await figures(page, samples, 'audio');
  expect(result.seconds).toBe(3);
  expect(result.uploadKbps).toBe(64);
  expect(result.downloadKbps).toBe(56);
  expect(result.lossPct).toBe(6.7);
  expect(result.worstSecondLossPct).toBe(20);
  expect(result.audioLossPct).toBe(6.7);
  expect(result.jitterAvgMs).toBe(3.5);
  expect(result.jitterMaxMs).toBe(6);
  expect(result.series).toEqual([
    { tMs: 1000, warmup: false, upKbps: 64, downKbps: 64, lossPct: 0, rttMs: 40, jitterMs: 4 },
    { tMs: 2000, warmup: false, upKbps: 64, downKbps: 40, lossPct: 20, rttMs: 40, jitterMs: 6 },
    { tMs: 3000, warmup: false, upKbps: 64, downKbps: 64, lossPct: 0, rttMs: 40, jitterMs: 2 },
  ]);
  expect(result.line).toContain('loss 6.7% (worst second 20%)');
});

test('loss that steps back counts as none lost; even loss shows no worst second', async ({ page }) => {
  await openPage(page);
  const samples = [
    { at: 0, stats: stats({ audioPacketsReceived: 0, audioPacketsLost: 0 }), metrics: null },
    { at: 1000, stats: stats({ audioPacketsReceived: 45, audioPacketsLost: 5 }), metrics: null },
    // A late packet: lost drops by one, received rises.
    { at: 2000, stats: stats({ audioPacketsReceived: 96, audioPacketsLost: 4 }), metrics: null },
  ];
  const result = await figures(page, samples, 'audio');
  expect((result.series as Array<{ lossPct: number }>).map((point) => point.lossPct)).toEqual([10, 0]);
  expect(result.lossPct).toBe(4);
  expect(result.worstSecondLossPct).toBe(10);

  const even = await figures(
    page,
    [
      { at: 0, stats: stats({}), metrics: null },
      { at: 1000, stats: stats({ audioPacketsReceived: 99, audioPacketsLost: 1 }), metrics: null },
      { at: 2000, stats: stats({ audioPacketsReceived: 198, audioPacketsLost: 2 }), metrics: null },
    ],
    'audio',
  );
  expect(even.line).toContain('loss 1% ·');
  expect(even.line).not.toContain('worst second');
});

test('the warm-up is shown in the series but left out of the bitrates and RTT, not the loss', async ({ page }) => {
  await openPage(page);
  const pair = (rtt: number) => ({ localType: 'srflx', remoteType: 'host', protocol: 'udp', relayProtocol: null, currentRoundTripTimeMs: rtt });
  // A video call: nothing inbound and a slow upload in the first two seconds, a 240 ms RTT in second one.
  const samples = [
    { at: 0, stats: stats({ candidatePair: pair(100) }), metrics: null },
    { at: 1000, stats: stats({ candidatePair: pair(240), videoBytesSent: 12_500, videoPacketsReceived: 0, videoPacketsLost: 2 }), metrics: null },
    { at: 2000, stats: stats({ candidatePair: pair(36), videoBytesSent: 125_000, videoBytesReceived: 50_000, videoPacketsReceived: 100, videoPacketsLost: 2 }), metrics: null },
    { at: 3000, stats: stats({ candidatePair: pair(34), videoBytesSent: 312_500, videoBytesReceived: 225_000, videoPacketsReceived: 250, videoPacketsLost: 2 }), metrics: null },
    { at: 4000, stats: stats({ candidatePair: pair(38), videoBytesSent: 500_000, videoBytesReceived: 400_000, videoPacketsReceived: 400, videoPacketsLost: 2 }), metrics: null },
  ];
  const result = await figures(page, samples, 'video', 2000);
  expect(result.warmupMs).toBe(2000);
  expect(result.seconds).toBe(2);
  expect(result.uploadKbps).toBe(1500);
  expect(result.downloadKbps).toBe(1400);
  expect(result.rttAvgMs).toBe(36);
  expect(result.rttMaxMs).toBe(38);
  // Loss keeps the warm-up: the two packets lost in second one count.
  expect(result.lossPct).toBe(0.5);
  expect((result.series as Array<{ tMs: number; warmup: boolean }>).map((point) => [point.tMs, point.warmup])).toEqual([
    [1000, true], [2000, true], [3000, false], [4000, false],
  ]);

  // A window too short for anything after the warm-up uses all of it.
  const short = await figures(page, samples.slice(0, 3), 'video', 2000);
  expect(short.warmupMs).toBe(0);
  expect(short.seconds).toBe(2);
  expect(short.rttMaxMs).toBe(240);
});

test('RTT and the path come from the transport carrying audio', async ({ page }) => {
  await openPage(page);
  // Separate audio and video transports (bundlePolicy max-compat), the video one listed last.
  const snapshot = await evalInApp<{ candidatePair: { localType: string; currentRoundTripTimeMs: number } }>(
    page,
    `const reports = [
       { id: 'T-audio', type: 'transport', selectedCandidatePairId: 'CP-audio' },
       { id: 'T-video', type: 'transport', selectedCandidatePairId: 'CP-video' },
       { id: 'CP-audio', type: 'candidate-pair', localCandidateId: 'L-a', remoteCandidateId: 'R-a', currentRoundTripTime: 0.035, nominated: true, state: 'succeeded' },
       { id: 'CP-video', type: 'candidate-pair', localCandidateId: 'L-v', remoteCandidateId: 'R-v', currentRoundTripTime: 0.241, nominated: true, state: 'succeeded' },
       { id: 'L-a', type: 'local-candidate', candidateType: 'srflx', protocol: 'udp' },
       { id: 'R-a', type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' },
       { id: 'L-v', type: 'local-candidate', candidateType: 'relay', protocol: 'udp', relayProtocol: 'tcp' },
       { id: 'R-v', type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' },
       { id: 'O-a', type: 'outbound-rtp', kind: 'audio', transportId: 'T-audio', bytesSent: 100 },
       { id: 'O-v', type: 'outbound-rtp', kind: 'video', transportId: 'T-video', bytesSent: 900 },
     ];
     const report = new Map(reports.map((r) => [r.id, r]));
     return s.getConnectionStats({ rtcPeerConnection: { getStats: async () => report } });`,
  );
  expect(snapshot.candidatePair.localType).toBe('srflx');
  expect(snapshot.candidatePair.currentRoundTripTimeMs).toBe(35);
});

test('video steps report video loss and video bitrates, with audio loss alongside', async ({ page }) => {
  await openPage(page);
  const samples = [
    { at: 0, stats: stats({}), metrics: metrics(1) },
    {
      at: 1000,
      stats: stats({
        videoBytesSent: 125_000, videoBytesReceived: 100_000, videoPacketsReceived: 95, videoPacketsLost: 5,
        audioBytesSent: 8000, audioBytesReceived: 8000, audioPacketsReceived: 50, audioPacketsLost: 0,
      }),
      metrics: metrics(1),
    },
  ];
  const result = await figures(page, samples, 'video');
  expect(result.uploadKbps).toBe(1000);
  expect(result.downloadKbps).toBe(800);
  expect(result.lossPct).toBe(5);
  expect(result.audioLossPct).toBe(0);
});

test('the WebRTC trace records the page\'s peer connections without TURN credentials', async ({ page }) => {
  await openPage(page);
  await stubSteps(page);
  // A step that makes a peer connection the way the TURN checks do.
  await evalInApp(
    page,
    `runner.steps['turn-udp'] = async () => {
       const pc = new RTCPeerConnection({ iceServers: [{ urls: 'turn:turn.example.invalid:3478', username: 'user-1', credential: 'secret-credential' }] });
       pc.createDataChannel('ping');
       await pc.setLocalDescription(await pc.createOffer());
       pc.close();
       return { status: 'passed', result: 'ok' };
     };`,
  );
  await startRun(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download WebRTC trace' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^signalwire-network-test-.*\.rtcstats$/);
  const text = readFileSync((await download.path())!, 'utf8');
  expect(text.startsWith('RTCStatsDump\n')).toBe(true);
  expect(text).not.toContain('secret-credential');
  expect(text).toContain('turn:turn.example.invalid:3478');

  // rtcstats' own reader accepts it and finds the connection with its calls.
  const dump = await readRTCStatsDump(new Blob([text]));
  expect(dump).toBeTruthy();
  expect(dump.clientProtocol).toBe('rtcstats#5.0');
  const connections = Object.entries(dump.peerConnections as Record<string, Array<{ type: string }>>).filter(([id]) => id !== 'null');
  expect(connections).toHaveLength(1);
  const types = connections[0][1].map((event) => event.type);
  expect(types).toEqual(expect.arrayContaining(['create', 'createDataChannel', 'createOffer', 'setLocalDescription', 'close']));
});

test('each run\'s trace holds only that run\'s connections, at their real times', async ({ page }) => {
  await openPage(page);
  // A connection from before any run: never in a run's trace.
  await page.evaluate(() => {
    const pc = new RTCPeerConnection();
    pc.createDataChannel('before');
    pc.close();
  });
  const stubWithConnection = (label: string) =>
    evalInApp(
      page,
      `runner.steps['turn-udp'] = async () => {
         window.__created = window.__created ?? [];
         window.__created.push(Date.now());
         const pc = new RTCPeerConnection();
         pc.createDataChannel(${JSON.stringify(label)});
         pc.close();
         return { status: 'passed', result: 'ok' };
       };`,
    );
  const traceOfRun = async () => {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download WebRTC trace' }).click(),
    ]);
    const dump = await readRTCStatsDump(new Blob([readFileSync((await download.path())!, 'utf8')]));
    expect(dump).toBeTruthy();
    return Object.entries(dump.peerConnections as Record<string, Array<{ type: string; value: unknown; timestamp: number }>>)
      .filter(([id]) => id !== 'null');
  };
  const labelOf = (events: Array<{ type: string; value: unknown }>) =>
    (events.find((event) => event.type === 'createDataChannel')?.value as unknown[] | undefined)?.[0];

  for (const [run, label] of [[0, 'first run'], [1, 'second run']] as const) {
    await stubSteps(page);
    await stubWithConnection(label);
    await startRun(page);
    const connections = await traceOfRun();
    expect(connections.map(([, events]) => labelOf(events))).toEqual([label]);
    // The timestamps are rebuilt from per-line gaps after other lines were left out.
    const createdAt = (await page.evaluate(() => (window as unknown as { __created: number[] }).__created))[run];
    const create = connections[0][1].find((event) => event.type === 'create')!;
    expect(Math.abs(create.timestamp - createdAt)).toBeLessThan(50);
  }
});

test('activity after a run ends stays out of that run\'s trace', async ({ page }) => {
  await openPage(page);
  await stubSteps(page);
  await startRun(page);
  const finishedAt = await evalInApp<number>(page, 'return runner.getRun().finishedAt;');
  // After the run: a device check and a new connection, before the download.
  await page.evaluate(async () => {
    await navigator.mediaDevices.enumerateDevices();
    const pc = new RTCPeerConnection();
    pc.createDataChannel('after');
    pc.close();
  });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download WebRTC trace' }).click(),
  ]);
  const text = readFileSync((await download.path())!, 'utf8');
  const metadata = JSON.parse(text.split('\n')[1]);
  expect(metadata.endTime).toBe(finishedAt);
  const dump = await readRTCStatsDump(new Blob([text]));
  expect(dump).toBeTruthy();
  expect(Object.keys(dump.peerConnections).filter((id) => id !== 'null')).toEqual([]);
  // Only the hardware entry is client-level here; no device check from after the run.
  const clientEvents = (dump.peerConnections.null ?? []) as Array<{ type: string; timestamp: number }>;
  expect(clientEvents.map((event) => event.type)).toEqual(['create']);
});
