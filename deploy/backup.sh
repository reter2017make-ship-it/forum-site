#!/bin/sh
# Ночная копия базы и загруженных файлов, хранится 14 дней.
set -e
D=/var/backups/forum
mkdir -p "$D"
DAY=$(date +%F)
sqlite3 /opt/forum/data/forum.db ".backup '$D/forum-$DAY.db'"
tar -C /opt/forum/data -czf "$D/uploads-$DAY.tar.gz" uploads 2>/dev/null || true
find "$D" -type f -mtime +14 -delete
