#!/bin/bash
# Azure App Service Deployment Script

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}=== FoodSnap Azure Deployment ===${NC}"

# Configuration
RESOURCE_GROUP="foodsnap-rg"
APP_NAME="foodsnap-api"
LOCATION="eastus2"
PYTHON_VERSION="3.11"

# Check Azure CLI
if ! command -v az &> /dev/null; then
    echo "Azure CLI not found. Installing..."
    brew install azure-cli
fi

# Login check
echo -e "${BLUE}Checking Azure login...${NC}"
az account show &> /dev/null || az login

# Create Resource Group
echo -e "${BLUE}Creating Resource Group...${NC}"
az group create --name $RESOURCE_GROUP --location $LOCATION

# Create App Service Plan (Free tier)
echo -e "${BLUE}Creating App Service Plan...${NC}"
az appservice plan create \
    --name "${APP_NAME}-plan" \
    --resource-group $RESOURCE_GROUP \
    --sku F1 \
    --is-linux

# Create Web App
echo -e "${BLUE}Creating Web App...${NC}"
az webapp create \
    --name $APP_NAME \
    --resource-group $RESOURCE_GROUP \
    --plan "${APP_NAME}-plan" \
    --runtime "PYTHON:${PYTHON_VERSION}"

# Configure startup command
echo -e "${BLUE}Configuring startup command...${NC}"
az webapp config set \
    --name $APP_NAME \
    --resource-group $RESOURCE_GROUP \
    --startup-file "gunicorn main:app --workers 2 --worker-class uvicorn.workers.UvicornWorker --bind 0.0.0.0:8000"

# Set environment variables
echo -e "${BLUE}Setting environment variables...${NC}"
az webapp config appsettings set \
    --name $APP_NAME \
    --resource-group $RESOURCE_GROUP \
    --settings \
        AZURE_OPENAI_ENDPOINT="https://your-resource.openai.azure.com" \
        AZURE_OPENAI_API_KEY="your-api-key-here" \
        AZURE_OPENAI_DEPLOYMENT="gpt-4o" \
        AZURE_OPENAI_API_VERSION="2024-02-15-preview" \
        DB_PATH="/home/site/wwwroot/data/app.db"

# Deploy code
echo -e "${BLUE}Deploying code...${NC}"
cd ..
zip -r deploy.zip . -x "*.pyc" -x "__pycache__/*" -x ".git/*" -x "azure-deploy/*" -x "cloudflare-deploy/*"

az webapp deploy \
    --name $APP_NAME \
    --resource-group $RESOURCE_GROUP \
    --src-path deploy.zip \
    --type zip

rm deploy.zip

# Get URL
URL=$(az webapp show --name $APP_NAME --resource-group $RESOURCE_GROUP --query "defaultHostName" -o tsv)

echo -e "${GREEN}=== Deployment Complete ===${NC}"
echo -e "URL: https://${URL}"
echo -e "API Docs: https://${URL}/docs"
echo ""
echo "Next steps:"
echo "1. Update AZURE_OPENAI_API_KEY in Azure Portal"
echo "2. Test the API: curl https://${URL}/api/health"
