import { RedisClient, S3Client, SQL } from 'bun';

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

async function retry(name: string, fn: () => Promise<unknown>, attempts = 30): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await fn();
      console.log(`✓ ${name}`);
      return;
    } catch (err) {
      if (i === attempts) throw new Error(`${name} is not ready: ${(err as Error).message}`, { cause: err });
      await Bun.sleep(1000);
    }
  }
}

await retry('postgres', async () => {
  const sql = new SQL(env('DATABASE_URL'));
  try {
    const [row] = await sql`select 1 as ok`;
    if (row?.ok !== 1) throw new Error('unexpected result');
  } finally {
    await sql.close();
  }
});

await retry('valkey', async () => {
  const redis = new RedisClient(env('VALKEY_URL'));
  try {
    const pong = await redis.send('PING', []);
    if (pong !== 'PONG') throw new Error(`unexpected reply ${pong}`);
    const policy = (await redis.send('CONFIG', ['GET', 'maxmemory-policy'])) as Record<string, string>;
    if (policy['maxmemory-policy'] !== 'noeviction')
      throw new Error(`maxmemory-policy is ${policy['maxmemory-policy']}`);
  } finally {
    redis.close();
  }
});

await retry('garage', async () => {
  const s3 = new S3Client({
    endpoint: env('S3_ENDPOINT'),
    region: env('S3_REGION'),
    bucket: env('S3_BUCKET'),
    accessKeyId: env('S3_ACCESS_KEY_ID'),
    secretAccessKey: env('S3_SECRET_ACCESS_KEY'),
  });
  const key = `healthcheck/${crypto.randomUUID()}.txt`;
  await s3.write(key, 'ok');
  const text = await s3.file(key).text();
  await s3.file(key).delete();
  if (text !== 'ok') throw new Error('roundtrip mismatch');
});
