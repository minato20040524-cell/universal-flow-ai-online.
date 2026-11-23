export class ApiError extends Error {}

async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || data.ok === false) throw new ApiError(data.error ?? `Permintaan gagal (${res.status})`);
  return data as T;
}

export const api = {
  get: <T,>(p: string) => call<T>('GET', p),
  post: <T = Record<string, unknown>>(p: string, b?: unknown) => call<T>('POST', p, b ?? {}),
  put: <T = Record<string, unknown>>(p: string, b?: unknown) => call<T>('PUT', p, b ?? {}),
  patch: <T = Record<string, unknown>>(p: string, b?: unknown) => call<T>('PATCH', p, b ?? {}),
  del: <T = Record<string, unknown>>(p: string) => call<T>('DELETE', p),
};

export const rawUrl = (artifactId: string): string => `/api/artifacts/${artifactId}/raw`;
export const downloadUrl = (artifactId: string): string => `/api/artifacts/${artifactId}/download`;
