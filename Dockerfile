FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# index.ts serves ../public relative to dist/, so it must sit next to it
COPY public ./public
EXPOSE 3000
# No --env-file: settings come from the container's environment
CMD ["node", "dist/index.js"]
