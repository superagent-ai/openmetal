FROM node:22-bookworm-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV SERVICE="api"

RUN corepack enable && corepack prepare pnpm@11.13.1 --activate

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile \
  && pnpm --filter @openmetal/api... --filter @openmetal/worker... build

ENV NODE_ENV="production"

CMD ["sh", "-c", "exec pnpm --filter @openmetal/$SERVICE start"]
