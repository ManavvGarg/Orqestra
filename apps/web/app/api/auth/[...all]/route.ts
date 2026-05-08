async function proxy(request: Request) {
  const upstreamBase = process.env.NEXT_PUBLIC_API_URL;
  const url = new URL(request.url);
  if (!upstreamBase) {
    return new Response('Missing NEXT_PUBLIC_API_URL environment variable', { status: 500 });
  }
  const base = upstreamBase.endsWith('/') ? upstreamBase.slice(0, -1) : upstreamBase;
  const target = `${base}${url.pathname}${url.search}`;
  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer(),
    redirect: "manual",
  };
  return fetch(target, init);
}

export { proxy as GET, proxy as POST };
