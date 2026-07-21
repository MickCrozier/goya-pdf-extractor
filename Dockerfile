FROM node:20-alpine
RUN apk add --no-cache poppler-utils
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY server.js .
EXPOSE 3000
CMD ["node", "server.js"]
