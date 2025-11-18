# Deployment Guide

This guide covers deploying the Twilio + OpenAI Realtime API backend to production environments.

## Prerequisites

Before deploying to production, ensure you have:

- A production server or cloud hosting platform (AWS, Google Cloud, Azure, DigitalOcean, etc.)
- A domain name with SSL certificate (required for WebSockets)
- Production Twilio account with verified phone numbers
- Production OpenAI API key with Realtime API access
- Production n8n instance or webhook provider

## Environment Setup

### 1. Server Requirements

**Minimum Specifications:**
- CPU: 2 cores
- RAM: 2 GB
- Storage: 10 GB
- OS: Ubuntu 20.04+ or similar Linux distribution
- Node.js: v18.0.0 or higher

**Recommended Specifications:**
- CPU: 4 cores
- RAM: 4 GB
- Storage: 20 GB

### 2. Install Dependencies

```bash
# Update system packages
sudo apt update && sudo apt upgrade -y

# Install Node.js (using NodeSource)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Install pnpm
npm install -g pnpm

# Install PM2 for process management
npm install -g pm2
```

### 3. Clone and Setup Projects

```bash
# Clone your repository
git clone <your-repository-url>
cd twilio-openai-realtime

# Install dependencies
pnpm install

# Build the project
pnpm build
```

### 4. Configure Environment Variables

Create a `.env` file in the project root:

```bash
# Production Environment Variables
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_production_auth_token
TWILIO_PHONE_NUMBER=+1234567890

OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx

N8N_WEBHOOK_AUTH=your_secure_auth_token
DEFAULT_N8N_WEBHOOK_URL=https://your-n8n-instance.com/webhook/config

PORT=5050
NODE_ENV=production

DEFAULT_VOICE=alloy
DEFAULT_TEMPERATURE=0.8
DEFAULT_MODEL=gpt-realtime
```

**Security Best Practices:**
- Use strong, unique values for `N8N_WEBHOOK_AUTH`
- Never commit `.env` files to version control
- Rotate API keys regularly
- Use environment-specific credentials

## Deployment Options

### Option 1: PM2 (Recommended for VPS/Dedicated Servers)

PM2 is a production process manager for Node.js applications.

**1. Start the application:**
```bash
pm2 start dist/index.js --name twilio-openai-realtime
```

**2. Configure PM2 to start on system boot:**
```bash
pm2 startup
pm2 save
```

**3. Monitor the application:**
```bash
pm2 status
pm2 logs twilio-openai-realtime
pm2 monit
```

**4. Restart/Stop the application:**
```bash
pm2 restart twilio-openai-realtime
pm2 stop twilio-openai-realtime
```

### Option 2: Docker

**1. Create a Dockerfile:**
```dockerfile
FROM node:18-alpine

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build TypeScript
RUN pnpm build

# Expose port
EXPOSE 5050

# Start application
CMD ["node", "dist/index.js"]
```

**2. Create a docker-compose.yml:**
```yaml
version: '3.8'

services:
  twilio-openai:
    build: .
    ports:
      - "5050:5050"
    env_file:
      - .env
    restart: unless-stopped
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

**3. Deploy:**
```bash
docker-compose up -d
```

### Option 3: Cloud Platforms

#### AWS (Elastic Beanstalk)

1. Install AWS CLI and EB CLI
2. Initialize Elastic Beanstalk:
   ```bash
   eb init
   ```
3. Create environment:
   ```bash
   eb create production
   ```
4. Set environment variables:
   ```bash
   eb setenv TWILIO_ACCOUNT_SID=ACxxx OPENAI_API_KEY=sk-xxx ...
   ```
5. Deploy:
   ```bash
   eb deploy
   ```

#### Google Cloud (Cloud Run)

1. Build container:
   ```bash
   gcloud builds submit --tag gcr.io/PROJECT_ID/twilio-openai
   ```
2. Deploy:
   ```bash
   gcloud run deploy twilio-openai \
     --image gcr.io/PROJECT_ID/twilio-openai \
     --platform managed \
     --allow-unauthenticated
   ```

#### DigitalOcean (App Platform)

1. Connect your GitHub repository
2. Configure build settings:
   - Build Command: `pnpm install && pnpm build`
   - Run Command: `node dist/index.js`
3. Add environment variables in the dashboard
4. Deploy

## SSL/TLS Configuration

WebSockets require HTTPS/WSS in production. Use a reverse proxy like Nginx.

### Nginx Configuration

**1. Install Nginx:**
```bash
sudo apt install nginx
```

**2. Create Nginx configuration:**
```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:5050;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    # WebSocket specific configuration
    location /media-stream {
        proxy_pass http://localhost:5050;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

**3. Obtain SSL certificate (Let's Encrypt):**
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

**4. Enable and restart Nginx:**
```bash
sudo systemctl enable nginx
sudo systemctl restart nginx
```

## Twilio Configuration

### 1. Configure Incoming Call Webhook

1. Log in to Twilio Console
2. Go to Phone Numbers → Manage → Active Numbers
3. Select your production phone number
4. Under "Voice & Fax", set:
   - A CALL COMES IN: `Webhook`
   - URL: `https://your-domain.com/incoming-call`
   - HTTP Method: `POST`
5. Click "Save"

### 2. Verify Outbound Calling

Ensure your Twilio account has:
- Sufficient balance
- Outbound calling enabled
- Geographic permissions configured

## Monitoring & Logging

### Application Logs

**With PM2:**
```bash
pm2 logs twilio-openai-realtime --lines 100
```

**With Docker:**
```bash
docker-compose logs -f --tail=100
```

### Log Rotation

**PM2 Log Rotation:**
```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

### Monitoring Tools

Consider integrating:
- **Datadog** - Application performance monitoring
- **Sentry** - Error tracking
- **CloudWatch** (AWS) - Cloud monitoring
- **Prometheus + Grafana** - Metrics and visualization

## Performance Optimization

### 1. Enable Compression

Add compression middleware to Express:
```typescript
import compression from 'compression';
app.use(compression());
```

### 2. Connection Pooling

The application already uses efficient WebSocket connections. Monitor concurrent connections and scale horizontally if needed.

### 3. Caching

Consider caching n8n webhook responses if configurations don't change frequently.

### 4. Load Balancing

For high traffic, deploy multiple instances behind a load balancer:
- AWS Application Load Balancer
- Google Cloud Load Balancing
- Nginx load balancer

## Security Checklist

- [ ] Use HTTPS/WSS in production
- [ ] Set strong authentication tokens
- [ ] Enable firewall (UFW, Security Groups)
- [ ] Regularly update dependencies
- [ ] Implement rate limiting
- [ ] Monitor for suspicious activity
- [ ] Use environment variables for secrets
- [ ] Enable CORS appropriately
- [ ] Validate all inputs
- [ ] Keep Node.js and system packages updated

## Backup & Disaster Recovery

### 1. Configuration Backup

Regularly backup:
- `.env` file (securely)
- Nginx configuration
- PM2 process list

### 2. Database Backup

If you add a database in the future, implement regular backups.

### 3. Disaster Recovery Plan

- Document deployment steps
- Keep infrastructure as code (Terraform, CloudFormation)
- Test recovery procedures regularly

## Scaling Considerations

### Horizontal Scaling

Deploy multiple instances and use a load balancer:

```bash
# Start multiple PM2 instances
pm2 start dist/index.js -i max --name twilio-openai-realtime
```

### Vertical Scaling

Increase server resources as needed based on:
- Concurrent call volume
- CPU usage
- Memory consumption
- Network bandwidth

## Troubleshooting Production Issues

### High CPU Usage
- Check for infinite loops in WebSocket handlers
- Monitor OpenAI API response times
- Review concurrent connection count

### Memory Leaks
- Monitor with `pm2 monit`
- Check for unclosed WebSocket connections
- Review session cleanup logic

### WebSocket Connection Failures
- Verify SSL certificate is valid
- Check Nginx WebSocket configuration
- Review firewall rules

### Twilio Webhook Failures
- Verify webhook URL is accessible
- Check SSL certificate
- Review server logs for errors

## Maintenance

### Regular Updates

```bash
# Update dependencies
pnpm update

# Rebuild
pnpm build

# Restart application
pm2 restart twilio-openai-realtime
```

### Health Checks

Set up automated health checks:
```bash
curl https://your-domain.com/
```

Expected response:
```json
{
  "status": "ok",
  "service": "Twilio + OpenAI Realtime API Server",
  "version": "1.0.0"
}
```

## Support & Resources

- [Twilio Documentation](https://www.twilio.com/docs)
- [OpenAI Realtime API Docs](https://platform.openai.com/docs/guides/realtime)
- [PM2 Documentation](https://pm2.keymetrics.io/)
- [Nginx Documentation](https://nginx.org/en/docs/)
