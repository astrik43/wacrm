// ============================================================
// PDF link check for send_document_to_staff. Meta fetches the file
// itself; we only verify it first so a bad link fails with a clear
// error instead of a failed delivery: https only, a public host, a
// `application/pdf` content type and a size under the cap.
// ============================================================

import { isDeliverableUrl } from '@/lib/webhooks/ssrf';

import { McpToolError } from '@/lib/mcp/errors';

export const MAX_PDF_BYTES = 10 * 1024 * 1024;

export async function checkPdfUrl(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ sizeBytes: number }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new McpToolError('invalid_input', 'url is not a valid URL.', 'url');
  }
  if (url.protocol !== 'https:') {
    throw new McpToolError('invalid_input', 'url must use https.', 'url');
  }
  if (url.username || url.password) {
    throw new McpToolError('invalid_input', 'url must not contain credentials.', 'url');
  }
  if (!(await isDeliverableUrl(rawUrl))) {
    throw new McpToolError('invalid_input', 'url must point to a public host.', 'url');
  }

  let res: Response;
  try {
    res = await fetchImpl(rawUrl, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new McpToolError(
      'upstream_error',
      'Could not reach the PDF url to check it. Make sure it is publicly reachable and try again.',
      'url'
    );
  }
  if (res.status >= 300 && res.status < 400) {
    throw new McpToolError(
      'invalid_input',
      'The PDF url redirects. Pass the final https url instead.',
      'url'
    );
  }
  if (!res.ok) {
    throw new McpToolError(
      'invalid_input',
      `The PDF url answered ${res.status}. Pass a link that can be fetched without signing in.`,
      'url'
    );
  }
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/pdf') {
    throw new McpToolError(
      'invalid_input',
      `The url is "${type || 'unknown'}", not application/pdf.`,
      'url'
    );
  }
  const size = Number(res.headers.get('content-length'));
  if (!Number.isFinite(size) || size <= 0) {
    throw new McpToolError(
      'invalid_input',
      'The url does not report a size (Content-Length). Host the PDF where it does.',
      'url'
    );
  }
  if (size > MAX_PDF_BYTES) {
    throw new McpToolError(
      'invalid_input',
      `The PDF is ${Math.round(size / 1024 / 1024)} MB; the limit is ${MAX_PDF_BYTES / 1024 / 1024} MB.`,
      'url'
    );
  }
  return { sizeBytes: size };
}
