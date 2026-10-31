import type { Sandbox } from '@agent/core';

/**
 * Probe that needs a real service reply, not just a TCP connect: OrbStack can proxy-accept a connect
 * on the host side, so a bare `/dev/tcp` open proves nothing. Each target gets a protocol-appropriate
 * payload, and only a non-empty answer counts as "reply".
 */

export const INFRA_PORTS = { postgres: 55432, valkey: 56379, garage: 53900 } as const;

/** Every name OrbStack / Docker Desktop hand containers for the host. The provider pins them all to 127.0.0.1. */
export const EXPECTED_HOST_ALIASES = [
  'host.docker.internal',
  'host.orb.internal',
  'host.internal',
  'gateway.docker.internal',
  'docker.for.mac.localhost',
  'docker.for.mac.host.internal',
] as const;

/** OrbStack's host IP as containers see it. */
export const ORBSTACK_HOST_IP = '0.250.250.254';

const encodeHex = (s: string) => Buffer.from(s, 'latin1').toString('hex');

/** Payloads that make each service answer: Valkey → "+PONG", Postgres SSLRequest → "S"/"N", Garage → HTTP status line. */
export const PAYLOAD_BY_PORT: Record<number, string> = {
  [INFRA_PORTS.valkey]: encodeHex('PING\r\n'),
  [INFRA_PORTS.postgres]: '0000000804d2162f',
  [INFRA_PORTS.garage]: encodeHex('GET / HTTP/1.0\r\nHost: probe\r\n\r\n'),
};
export const HTTP_PAYLOAD = encodeHex('GET / HTTP/1.0\r\nHost: probe\r\n\r\n');

export type ReplyVerdict = 'reply' | 'connect_only' | 'refused' | 'unreachable' | 'timeout' | 'unresolved' | 'error';

export interface ProbeTarget {
  host: string;
  port: number;
  /** Hex payload sent after connecting; defaults to the infra payload for the port, else an HTTP GET. */
  payload?: string;
}

export interface ProbeResult {
  host: string;
  port: number;
  verdict: ReplyVerdict;
  /** First bytes of the reply (latin1) or the error text. */
  detail: string;
}

const PROBE_PY = String.raw`
import json, socket, sys
from concurrent.futures import ThreadPoolExecutor

def probe(t):
    host, port, payload = t["host"], t["port"], bytes.fromhex(t["payload"])
    out = {"host": host, "port": port}
    try:
        s = socket.create_connection((host, port), timeout=3)
    except socket.gaierror as e:
        return {**out, "verdict": "unresolved", "detail": str(e)}
    except socket.timeout:
        return {**out, "verdict": "timeout", "detail": "connect timed out"}
    except ConnectionRefusedError as e:
        return {**out, "verdict": "refused", "detail": str(e)}
    except OSError as e:
        return {**out, "verdict": "unreachable", "detail": str(e)}
    try:
        s.settimeout(3)
        s.sendall(payload)
        data = s.recv(64)
        if data:
            return {**out, "verdict": "reply", "detail": data.decode("latin1")}
        return {**out, "verdict": "connect_only", "detail": "closed without a reply"}
    except socket.timeout:
        return {**out, "verdict": "connect_only", "detail": "connected, no reply within 3s"}
    except OSError as e:
        return {**out, "verdict": "connect_only", "detail": "connected, then " + str(e)}
    finally:
        s.close()

targets = json.loads(sys.argv[1])
with ThreadPoolExecutor(max_workers=16) as pool:
    print(json.dumps(list(pool.map(probe, targets))))
`;

/** The probe itself did not run (e.g. exit 127: no python3) — nothing can be concluded about reachability. */
export class ProbeUnavailableError extends Error {
  constructor(
    readonly exitCode: number,
    detail: string,
  ) {
    super(`reply probe could not run (exit ${exitCode}): ${detail}`);
    this.name = 'ProbeUnavailableError';
  }
}

/** Runs every probe concurrently inside the sandbox in one exec. */
export async function probeReplies(sandbox: Sandbox, targets: ProbeTarget[]): Promise<ProbeResult[]> {
  const resolved = targets.map(t => ({ ...t, payload: t.payload ?? PAYLOAD_BY_PORT[t.port] ?? HTTP_PAYLOAD }));
  const arg = JSON.stringify(resolved).replaceAll("'", '');
  const r = await sandbox.exec(`python3 - '${arg}'`, { timeoutMs: 30_000, stdin: PROBE_PY });
  if (r.exitCode !== 0) throw new ProbeUnavailableError(r.exitCode, r.stderr.trim() || r.stdout.trim());
  return JSON.parse(r.stdout) as ProbeResult[];
}
