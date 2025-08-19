#!/bin/bash

# Ahrefs MCP Server Deployment Script
# This script deploys the Ahrefs MCP server to a production environment

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🚀 Starting Ahrefs MCP Server Deployment${NC}"

# Check if running as root
if [[ $EUID -eq 0 ]]; then
   echo -e "${RED}❌ This script should not be run as root${NC}"
   exit 1
fi

# Load environment variables
if [[ ! -f .env ]]; then
    echo -e "${RED}❌ .env file not found. Please copy env.example to .env and configure it.${NC}"
    exit 1
fi

# Source environment variables
set -a  # automatically export all variables
source .env
set +a

# Validate required environment variables
required_vars=("SERVER_IP" "SERVER_USER" "DEPLOY_PATH" "SERVICE_NAME" "API_KEY")
for var in "${required_vars[@]}"; do
    if [[ -z "${!var}" ]]; then
        echo -e "${RED}❌ Required environment variable $var is not set in .env file${NC}"
        exit 1
    fi
done

# Variables
PROJECT_NAME="ahrefs-mcp-server"

echo -e "${YELLOW}📦 Building project locally...${NC}"
npm run build

echo -e "${YELLOW}🔧 Creating deployment package...${NC}"
# Create a temporary deployment directory
TEMP_DIR=$(mktemp -d)
cp -r . "$TEMP_DIR/$PROJECT_NAME"
cd "$TEMP_DIR/$PROJECT_NAME"

# Remove unnecessary files for production
rm -rf .git node_modules images src tsconfig.json
rm -f deploy.sh .gitignore setup-nginx.sh env.example

# Create tarball
cd ..
tar -czf "$PROJECT_NAME.tar.gz" "$PROJECT_NAME"

echo -e "${YELLOW}📤 Uploading to server...${NC}"
scp "$PROJECT_NAME.tar.gz" "$SERVER_USER@$SERVER_IP:/tmp/"

echo -e "${YELLOW}🖥️  Setting up on server...${NC}"
ssh "$SERVER_USER@$SERVER_IP" << EOF
    set -e
    
    echo "Installing Node.js if not present..."
    if ! command -v node &> /dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
    fi
    
    echo "Creating project directory..."
    sudo mkdir -p $DEPLOY_PATH
    sudo chown $SERVER_USER:$SERVER_USER $DEPLOY_PATH
    
    echo "Extracting project..."
    cd /tmp
    tar -xzf $PROJECT_NAME.tar.gz
    cp -r $PROJECT_NAME/* $DEPLOY_PATH/
    rm -rf $PROJECT_NAME $PROJECT_NAME.tar.gz
    
    echo "Installing dependencies..."
    cd $DEPLOY_PATH
    npm install --production
    
    echo "Setting up systemd service..."
    sudo tee /etc/systemd/system/$SERVICE_NAME.service > /dev/null << EOL
[Unit]
Description=Ahrefs MCP Server
After=network.target

[Service]
Type=simple
User=$SERVER_USER
WorkingDirectory=$DEPLOY_PATH
ExecStart=/usr/bin/node build/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=$NODE_ENV
Environment=API_BASE_URL=$API_BASE_URL
Environment=API_KEY=$API_KEY
Environment=PORT=$PORT

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE_NAME

# Security settings
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DEPLOY_PATH

[Install]
WantedBy=multi-user.target
EOL

    echo "Reloading systemd and enabling service..."
    sudo systemctl daemon-reload
    sudo systemctl enable $SERVICE_NAME
    
    echo "✅ Deployment completed!"
    echo "📝 Starting the service..."
    sudo systemctl start $SERVICE_NAME
    
    echo "🔍 Service status:"
    sudo systemctl status $SERVICE_NAME --no-pager
EOF

# Cleanup
rm -rf "$TEMP_DIR"

echo -e "${GREEN}✅ Deployment script completed!${NC}"
echo -e "${YELLOW}Service Management Commands:${NC}"
echo "1. Check service status:"
echo "   ssh $SERVER_USER@$SERVER_IP 'sudo systemctl status $SERVICE_NAME'"
echo "2. View logs:"
echo "   ssh $SERVER_USER@$SERVER_IP 'sudo journalctl -u $SERVICE_NAME -f'"
echo "3. Restart service:"
echo "   ssh $SERVER_USER@$SERVER_IP 'sudo systemctl restart $SERVICE_NAME'"
echo "4. Access application:"
echo "   http://$SERVER_IP:$PORT"
