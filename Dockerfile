FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=7228
ENV PACT_DB_PATH=/data/pact.sqlite
EXPOSE 7228

CMD ["node", "server.js"]
