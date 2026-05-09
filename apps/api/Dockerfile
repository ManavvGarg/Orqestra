FROM oven/bun:1.1-alpine AS base

RUN apk add --no-cache nodejs npm

RUN npm install -g pnpm@9

WORKDIR /repo

FROM base AS deps

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./

COPY apps/api/package.json apps/api/

COPY packages/db/package.json packages/db/
COPY packages/env/package.json packages/env/
COPY packages/trpc/package.json packages/trpc/
COPY packages/models/package.json packages/models/

RUN pnpm install --frozen-lockfile=false

FROM deps AS build

COPY tsconfig.base.json ./

COPY apps/api apps/api

COPY packages/db packages/db
COPY packages/env packages/env
COPY packages/trpc packages/trpc
COPY packages/models packages/models

FROM build AS runner

ENV NODE_ENV=production

WORKDIR /repo/apps/api

EXPOSE 4000

CMD ["bun", "run", "src/index.ts"]