#!/bin/zsh
# Trigger a mindmeld sync by restarting the sync container

docker restart mindmeld-sync >/dev/null 2>&1
echo "Sync triggered"
