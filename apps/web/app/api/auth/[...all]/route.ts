async function proxy(request: Request) {
  // Server-side proxy: prefer INTERNAL_API_URL (container DNS like http://api:4000)
  // because NEXT_PUBLIC_API_URL points at the host (http://localhost:4000), which
  // resolves to the web container itself when used server-side.
  const upstreamBase = process.env.INTERNAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL;
  const url = new URL(request.url);
  if (!upstreamBase) {
    return new Response('Missing INTERNAL_API_URL / NEXT_PUBLIC_API_URL environment variable', { status: 500 });
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
