FROM node:20-alpine
WORKDIR /app
COPY server.js .
ENV PORT=7860
EXPOSE 7860
CMD ["node", "server.js"]
