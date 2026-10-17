import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Photos: the phone PUTs a file straight to storage and clients GET it back,
 * both through presigned URLs (ADR-0004, ADR-0005). The real implementation
 * speaks the S3 API to a configured endpoint (ADR-0008).
 */
export interface FileStorage {
  uploadUrl(key: string, contentType: string): Promise<string>;
  downloadUrl(key: string): Promise<string>;
}

/** Files under a local directory, addressed by plain `file:` URLs with no signature. */
export function createLocalFileStorage(root: string): FileStorage {
  const url = async (key: string) => pathToFileURL(path.join(root, key)).href;
  return { uploadUrl: url, downloadUrl: url };
}
