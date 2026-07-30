FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json

RUN npm ci

COPY . .
RUN npm run build

FROM node:24-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app /app

CMD ["npm", "run", "start", "-w", "@sentinel/api"]
