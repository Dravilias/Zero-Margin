FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs ./
USER node
ENV PORT=7700
EXPOSE 7700
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:7700/health >/dev/null || exit 1
CMD ["node", "server.mjs"]
