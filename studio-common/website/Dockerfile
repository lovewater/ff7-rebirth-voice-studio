FROM node:22-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build -- --webpack
EXPOSE 8765
CMD ["npm", "run", "start"]
