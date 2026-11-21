FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json prisma.config.ts ./
COPY src ./src
COPY prisma ./prisma
COPY prompts ./prompts
RUN pnpm exec prisma generate
RUN pnpm build
RUN pnpm prune --prod

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/prompts ./prompts
EXPOSE 8080
CMD ["node", "dist/src/index.js"]
