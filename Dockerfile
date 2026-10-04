# Use Node.js LTS image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Expose port
EXPOSE 3000

# Set environment variables (with defaults)
ENV NODE_ENV=production
ENV PORT=3000

# Start the application
CMD ["npm", "start"]