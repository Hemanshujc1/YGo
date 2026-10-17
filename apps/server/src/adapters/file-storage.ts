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

/**
 * Files under a local directory, addressed by plain `file:` URLs with no
 * signature. The content type is ignored: nothing here enforces it.
 */
export function createLocalFileStorage(root: string): FileStorage {
  const base = path.resolve(root);
  const url = async (key: string) => {
    const file = path.resolve(base, key);
    if (!file.startsWith(base + path.sep)) throw new Error(`key escapes the storage root: ${key}`);
    return pathToFileURL(file).href;
  };
  return { uploadUrl: url, downloadUrl: url };
}
