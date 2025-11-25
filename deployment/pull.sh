#!/bin/bash

###
# Configuration
###
GITHUB_USERNAME="wenzun-99"
IMAGE_NAME="document-pre-proxy"
IMAGE_TAG="latest"
GITHUB_PAT=""


if [ -z "$GITHUB_PAT" ]; then
    echo -n "Enter your GitHub Personal Access Token (with read:packages): "
    read -s GITHUB_PAT
    echo ""
fi

echo "Logging in to ghcr.io..."
echo "$GITHUB_PAT" | docker login ghcr.io -u "$GITHUB_USERNAME" --password-stdin

if [ $? -ne 0 ]; then
    echo "❌ Login failed!"
    exit 1
fi

echo "Pulling image ghcr.io/$GITHUB_USERNAME/$IMAGE_NAME:$IMAGE_TAG ..."
docker pull ghcr.io/$GITHUB_USERNAME/$IMAGE_NAME:$IMAGE_TAG

if [ $? -ne 0 ]; then
    echo "❌ Image pull failed!"
    exit 1
fi

echo "✅ Image successfully pulled:"
echo "   ghcr.io/$GITHUB_USERNAME/$IMAGE_NAME:$IMAGE_TAG"
echo "You can now run it with:"
echo "   docker run -d --name document-pre-proxy ghcr.io/$GITHUB_USERNAME/$IMAGE_NAME:$IMAGE_TAG"

exit 0
