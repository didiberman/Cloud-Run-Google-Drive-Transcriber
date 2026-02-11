FROM node:22-slim

WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
RUN npm install --omit=dev

# Copy source code
COPY index.js ./

# Start the job
CMD ["npm", "start"]
