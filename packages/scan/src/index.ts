export { isLockfile, type LockedPackage, parseLockfile } from "./audit/lockfiles.js";
export { apiSource, auditPackages, type OsvSource, offlineSource } from "./audit/osv.js";
export { cloneRepo, GitError, scratchDir } from "./ingest/git.js";
export { listTree, type TreeEntry, treeHash } from "./ingest/tree.js";
export { DEFAULT_ZIP_LIMITS, extractZip, type ZipRejectCode, ZipRejected } from "./ingest/zip.js";
export { type ClassifiedFeature, classifyFeatures } from "./inventory.js";
export {
  anthropicModel,
  type BundleItem,
  ModelError,
  type ModelFeatureProposal,
  type ModelReportDraft,
  type ReportModel,
  type Usage,
} from "./model.js";
export {
  buildBundle,
  runScan,
  SCAN_STAGES,
  type ScanClaim,
  type ScanOptions,
  type ScanResult,
} from "./pipeline.js";
export type { EvidenceDraft, FindingDraft } from "./recorder.js";
