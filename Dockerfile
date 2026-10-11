FROM node:22-slim

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# App source
COPY server ./server
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

# Persist SQLite DB, uploads and generated videos under /app/data
VOLUME ["/app/data"]

CMD ["node", "server/index.js"]
