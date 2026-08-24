export type ScriptedResponse = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  error?: Error;
};

export function createScriptedFetch(script: ScriptedResponse[]) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const queue = [...script];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    const next = queue.shift();
    if (!next) throw new Error("unexpected scripted fetch request");
    if (next.error) throw next.error;
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: {
        "content-type": "application/json",
        ...(next.headers ?? {}),
      },
    });
  };
  return { fetchImpl, requests, remaining: () => queue.length };
}
