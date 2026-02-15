FROM node:25-alpine

WORKDIR /app

RUN corepack enable

COPY package.json ./
COPY collector/package.json ./collector/package.json
COPY tools/package.json ./tools/package.json

RUN yarn install

COPY collector ./collector
COPY tools ./tools
COPY schema ./schema
COPY tsconfig.base.json ./tsconfig.base.json

ENV NODE_ENV=production
