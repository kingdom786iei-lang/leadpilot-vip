FROM node:20-bookworm

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

RUN mkdir -p /app/data

ENV NODE_ENV=production

CMD ["npm", "start"]
