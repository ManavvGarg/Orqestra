FROM oven/bun:1.1-alpine AS base
RUN apk add --no-cache npm
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-workspace.yaml ./
COPY apps/ws/package.json apps/ws/
COPY packages/db/package.json packages/db/
COPY packages/env/package.json packages/env/
RUN npm install -g pnpm@9 && pnpm install --frozen-lockfile=false

FROM deps AS runner
COPY tsconfig.base.json ./
COPY apps/ws apps/ws
COPY packages/db packages/db
COPY packages/env packages/env
ENV NODE_ENV=production
WORKDIR /repo/apps/ws
EXPOSE 4001
CMD ["bun", "run", "src/index.ts"]
