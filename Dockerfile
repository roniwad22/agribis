FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /data uploads

ENV PORT=3000
ENV DB_PATH=/data/agribis.db

EXPOSE 3000

CMD ["node", "src/app.js"]
