import { generateKeyPairSync, randomBytes } from "node:crypto";
import forge from "node-forge";

export interface CertPair {
  certPem: string;
  keyPem: string;
}

export interface TestPki {
  ca: CertPair;
  /** CA-signed, SAN localhost + 127.0.0.1, valid for a year. */
  valid: CertPair;
  /** CA-signed, expires in 7 days (TLS_EXPIRING threshold is 14). */
  expiring: CertPair;
  /** CA-signed, expired yesterday. */
  expired: CertPair;
  /** CA-signed but issued for a different host name. */
  wrongHost: CertPair;
  /** Self-signed, not chained to the test CA. */
  selfSigned: CertPair;
}

const DAY = 24 * 60 * 60 * 1000;

function rsaKeys(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

interface IssueOptions {
  commonName: string;
  altNames: { type: 2 | 7; value?: string; ip?: string }[];
  notBefore: Date;
  notAfter: Date;
  isCa: boolean;
  issuer?: { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey };
}

function issue(opts: IssueOptions): {
  pair: CertPair;
  cert: forge.pki.Certificate;
  key: forge.pki.rsa.PrivateKey;
} {
  const keys = rsaKeys();
  const key = forge.pki.privateKeyFromPem(keys.privateKeyPem) as forge.pki.rsa.PrivateKey;
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(keys.publicKeyPem);
  // Positive serial: leading byte < 0x80.
  cert.serialNumber = `01${randomBytes(15).toString("hex")}`;
  cert.validity.notBefore = opts.notBefore;
  cert.validity.notAfter = opts.notAfter;
  const subject = [
    { name: "commonName", value: opts.commonName },
    { name: "organizationName", value: "CodeSentra Fixture Harness" },
  ];
  cert.setSubject(subject);
  cert.setIssuer(opts.issuer ? opts.issuer.cert.subject.attributes : subject);
  const extensions: object[] = [
    { name: "basicConstraints", cA: opts.isCa, critical: true },
    opts.isCa
      ? { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true }
      : { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
  ];
  if (!opts.isCa) {
    extensions.push({ name: "extKeyUsage", serverAuth: true });
    extensions.push({ name: "subjectAltName", altNames: opts.altNames });
  }
  extensions.push({ name: "subjectKeyIdentifier" });
  cert.setExtensions(extensions);
  cert.sign(opts.issuer?.key ?? key, forge.md.sha256.create());
  return {
    pair: { certPem: forge.pki.certificateToPem(cert), keyPem: keys.privateKeyPem },
    cert,
    key,
  };
}

const LOCAL_NAMES: IssueOptions["altNames"] = [
  { type: 2, value: "localhost" },
  { type: 7, ip: "127.0.0.1" },
];

/** Generates a fresh throwaway PKI. Nothing is written to disk. */
export function createTestPki(now: Date = new Date()): TestPki {
  const t = now.getTime();
  const ca = issue({
    commonName: "CodeSentra Fixture Test CA",
    altNames: [],
    notBefore: new Date(t - DAY),
    notAfter: new Date(t + 365 * DAY),
    isCa: true,
  });
  const issuer = { cert: ca.cert, key: ca.key };
  const leaf = (notBefore: number, notAfter: number, altNames = LOCAL_NAMES, cn = "localhost") =>
    issue({
      commonName: cn,
      altNames,
      notBefore: new Date(notBefore),
      notAfter: new Date(notAfter),
      isCa: false,
      issuer,
    }).pair;

  return {
    ca: ca.pair,
    valid: leaf(t - DAY, t + 365 * DAY),
    expiring: leaf(t - 30 * DAY, t + 7 * DAY),
    expired: leaf(t - 60 * DAY, t - DAY),
    wrongHost: leaf(
      t - DAY,
      t + 365 * DAY,
      [{ type: 2, value: "not-this-host.example" }],
      "not-this-host.example",
    ),
    selfSigned: issue({
      commonName: "localhost",
      altNames: LOCAL_NAMES,
      notBefore: new Date(t - DAY),
      notAfter: new Date(t + 365 * DAY),
      isCa: false,
    }).pair,
  };
}
