#!/bin/bash
# Azure App Service startup script

# Install dependencies
pip install -r requirements.txt

# Start the application with gunicorn
gunicorn main:app --workers 2 --worker-class uvicorn.workers.UvicornWorker --bind 0.0.0.0:8000
