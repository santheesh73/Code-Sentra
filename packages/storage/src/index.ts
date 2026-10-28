import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";

export interface ObjectStoreConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO and most self-hosted S3 need path-style addressing. Default true. */
  forcePathStyle?: boolean;
  region?: string;
  /**
   * The endpoint browsers reach (presigned uploads). Defaults to `endpoint`; differs when
   * the services reach storage on a private address.
   */
  publicEndpoint?: string;
}

export interface PresignedUpload {
  /** POST a multipart form here with `fields` first and the file last (field `file`). */
  url: string;
  fields: Record<string, string>;
  expiresAt: Date;
}

export interface ObjectStore {
  bucket: string;
  put(key: string, body: Uint8Array | string, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  /** Throws if the bucket is missing or credentials are wrong. */
  check(): Promise<void>;
  /**
   * A browser upload straight to storage (presigned POST). The policy pins the key and the
   * content type and caps the size, so storage itself refuses anything else.
   */
  presignUpload(
    key: string,
    opts: { maxBytes: number; contentType: string; expiresSeconds?: number },
  ): Promise<PresignedUpload>;
  /** The object's size, or null when it does not exist. */
  stat(key: string): Promise<{ size: number } | null>;
  /** Bytes [start, end] (inclusive) of an object. */
  getRange(key: string, start: number, end: number): Promise<Uint8Array>;
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
  // Presigned URLs carry the host they were signed for: sign with the public endpoint.
  const publicClient = cfg.publicEndpoint
    ? new S3Client({
        endpoint: cfg.publicEndpoint,
        region: cfg.region ?? "us-east-1",
        forcePathStyle: cfg.forcePathStyle ?? true,
        credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      })
    : client;
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
    async presignUpload(key, opts) {
      assertKey(key);
      const expires = opts.expiresSeconds ?? 900;
      const post = await createPresignedPost(publicClient, {
        Bucket: cfg.bucket,
        Key: key,
        Conditions: [
          ["content-length-range", 1, opts.maxBytes],
          ["eq", "$Content-Type", opts.contentType],
        ],
        Fields: { "Content-Type": opts.contentType },
        Expires: expires,
      });
      return {
        url: post.url,
        fields: post.fields,
        expiresAt: new Date(Date.now() + expires * 1000),
      };
    },
    async stat(key) {
      assertKey(key);
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }), {
          abortSignal: signal(),
        });
        return { size: Number(res.ContentLength ?? 0) };
      } catch (e) {
        const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 404 || (e as Error).name === "NotFound") return null;
        throw e;
      }
    },
    async getRange(key, start, end) {
      assertKey(key);
      const res = await client.send(
        new GetObjectCommand({ Bucket: cfg.bucket, Key: key, Range: `bytes=${start}-${end}` }),
        { abortSignal: signal() },
      );
      if (!res.Body) throw new Error(`object ${key} has no body`);
      return res.Body.transformToByteArray();
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
  S3_PUBLIC_ENDPOINT?: string;
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
    ...(env.S3_PUBLIC_ENDPOINT ? { publicEndpoint: env.S3_PUBLIC_ENDPOINT } : {}),
  });
}
