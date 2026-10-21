import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export interface ObjectStoreConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO and most self-hosted S3 need path-style addressing. Default true. */
  forcePathStyle?: boolean;
  region?: string;
}

export interface ObjectStore {
  bucket: string;
  put(key: string, body: Uint8Array | string, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  /** Throws if the bucket is missing or credentials are wrong. */
  check(): Promise<void>;
}

const SAFE_KEY = /^(?!\/)(?!.*\.\.)[A-Za-z0-9!_.*'()/-]{1,1024}$/;

function assertKey(key: string): void {
  if (!SAFE_KEY.test(key)) throw new TypeError(`unsafe object key: ${JSON.stringify(key)}`);
}

export function createObjectStore(cfg: ObjectStoreConfig, timeoutMs = 15_000): ObjectStore {
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region ?? "us-east-1",
    forcePathStyle: cfg.forcePathStyle ?? true,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    requestHandler: { requestTimeout: timeoutMs, connectionTimeout: timeoutMs },
    maxAttempts: 2,
  });
  const signal = () => AbortSignal.timeout(timeoutMs);
  return {
    bucket: cfg.bucket,
    async put(key, body, contentType) {
      assertKey(key);
      await client.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
        { abortSignal: signal() },
      );
    },
    async get(key) {
      assertKey(key);
      const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), {
        abortSignal: signal(),
      });
      if (!res.Body) throw new Error(`object ${key} has no body`);
      return res.Body.transformToByteArray();
    },
    async delete(key) {
      assertKey(key);
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }), {
        abortSignal: signal(),
      });
    },
    async check() {
      await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }), { abortSignal: signal() });
    },
  };
}

/** Builds a store from validated config, or null when the s3 integration is not configured. */
export function objectStoreFromEnv(env: {
  integrations: { s3: boolean };
  S3_ENDPOINT?: string;
  S3_BUCKET?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
}): ObjectStore | null {
  if (!env.integrations.s3) return null;
  if (!env.S3_ENDPOINT || !env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
    throw new Error("s3 integration is marked configured but a variable is missing");
  }
  return createObjectStore({
    endpoint: env.S3_ENDPOINT,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  });
}
