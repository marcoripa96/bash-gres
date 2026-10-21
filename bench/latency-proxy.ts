/**
 * TCP proxy that delays every chunk by a fixed one-way time in each
 * direction, to measure round-trip counts the way a remote database feels.
 * On loopback a round-trip costs ~0.08 ms, which hides them.
 *
 *   node dist-bench/bench/latency-proxy.js <listenPort> <targetHost> <targetPort> <oneWayMs>
 *
 * Timer granularity rounds small delays up: 0.5 ms one-way measures ~2.5 ms
 * per round-trip on Linux. agent-session.ts forks this in its own process so
 * the delays don't share the measured client's event loop.
 */
import net from "node:net";

const [listenArg, targetHost, targetPortArg, delayArg] = process.argv.slice(2);
const listenPort = Number(listenArg);
const targetPort = Number(targetPortArg);
const delayMs = Number(delayArg);
if (!targetHost || !listenPort || !targetPort || !(delayMs >= 0)) {
  console.error(
    "usage: latency-proxy <listenPort> <targetHost> <targetPort> <oneWayMs>",
  );
  process.exit(2);
}

net
  .createServer((client) => {
    client.setNoDelay(true);
    const upstream = net.connect(targetPort, targetHost);
    upstream.setNoDelay(true);
    const pipe = (from: net.Socket, to: net.Socket) =>
      from.on("data", (chunk) => setTimeout(() => to.write(chunk), delayMs));
    pipe(client, upstream);
    pipe(upstream, client);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    for (const s of [client, upstream]) {
      s.on("error", close);
      s.on("close", close);
    }
  })
  .listen(listenPort, "127.0.0.1", () => {
    process.send?.("ready");
  });
