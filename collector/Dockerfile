FROM node:26-alpine

WORKDIR /app

RUN corepack enable

COPY package.json ./
COPY yarn.lock ./yarn.lock
COPY collector/package.json ./collector/package.json
COPY tools/package.json ./tools/package.json
COPY ui/package.json ./ui/package.json

RUN corepack install
RUN yarn install --immutable

COPY collector ./collector
COPY tools ./tools
COPY ui ./ui
COPY schema ./schema
COPY tsconfig.base.json ./tsconfig.base.json

RUN yarn workspace @ha-ai/ui build

ENV NODE_ENV=production
