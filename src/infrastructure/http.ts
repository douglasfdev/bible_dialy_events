import axios from 'axios';
// No automatic retries for financial POSTs: a timeout may have created a charge.
export const externalHttp = axios.create({ timeout: 12000, maxContentLength: 2_000_000, maxBodyLength: 2_000_000 });
export class ServiceError extends Error {
  constructor(message: string, readonly status = 503, readonly code = 'SERVICE_UNAVAILABLE') { super(message); }
}
export function safeFailure(error: unknown): Record<string, unknown> {
  if(axios.isAxiosError(error)) return { type: 'upstream', status: error.response?.status, code: error.code };
  return { type: error instanceof Error ? error.name : 'unknown' };
}
