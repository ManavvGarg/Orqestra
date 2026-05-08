async function proxy(request: Request) {
  const upstream = process.env.NEXT_PUBLIC_API_URL!;
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
