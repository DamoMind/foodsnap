#!/bin/bash
set -e
echo "=== Starting FoodSnap deployment ==="

# Create directory for packages
mkdir -p /home/.local/lib/python3.11/site-packages

echo "Installing dependencies..."
python3 -m pip install -q -r /home/site/wwwroot/requirements.txt --target=/home/.local/lib/python3.11/site-packages 2>&1 || {
    echo "pip install failed, trying with ensurepip..."
    python3 -m ensurepip --default-pip
    python3 -m pip install -q -r /home/site/wwwroot/requirements.txt --target=/home/.local/lib/python3.11/site-packages
}

echo "Dependencies installed. Starting server..."
export PYTHONPATH="/home/.local/lib/python3.11/site-packages:$PYTHONPATH"

cd /home/site/wwwroot
exec python3 -m gunicorn main:app --workers 2 --worker-class uvicorn.workers.UvicornWorker --bind 0.0.0.0:8000
