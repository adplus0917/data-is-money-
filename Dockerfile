# One image for every service. Which program runs is chosen by the command.
#   website      : node server/index.js            (cloud)
#   ingest       : node vault/ingest-worker.js     (vault rack)
#   builder      : node vault/viewing-builder.js   (vault rack)
#   data room    : node vault/dataroom/server.js   (vault rack, DMZ network)
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
USER node
ENV NODE_ENV=production
CMD ["node", "server/index.js"]
