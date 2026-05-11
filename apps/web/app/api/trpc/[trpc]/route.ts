async function proxy(request: Request) {
  // Server-side proxy: prefer INTERNAL_API_URL (container DNS) over NEXT_PUBLIC_API_URL,
  // which points at the host and resolves to the web container itself when used server-side.
  const upstream = (process.env.INTERNAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL)!;
  const url = new URL(request.url);
  const target = `${upstream}/trpc${url.pathname.replace(/^\/api\/trpc/, "")}${url.search}`;
  return fetch(target, {
    method: request.method,
    headers: request.headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer(),
    redirect: "manual",
  });
}

export { proxy as GET, proxy as POST };
