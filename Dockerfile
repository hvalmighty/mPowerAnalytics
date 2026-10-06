FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js demo.js ./
COPY public ./public
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
