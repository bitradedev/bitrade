FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node server.mjs ./server.mjs
USER node
EXPOSE 8788
CMD ["node", "server.mjs"]
