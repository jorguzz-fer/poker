FROM node:24-alpine
WORKDIR /app
COPY index.html server.js ./
ENV PORT=3000 DATA_DIR=/data NODE_ENV=production
RUN mkdir -p /data && chown node:node /data /app
VOLUME ["/data"]
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server.js"]
