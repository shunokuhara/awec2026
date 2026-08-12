FROM node:24-alpine
WORKDIR /app
COPY . .
ENV PORT=8787 DB_PATH=/data/videoeval.db
VOLUME ["/data"]
EXPOSE 8787
CMD ["node","server.mjs"]
