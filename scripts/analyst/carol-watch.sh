#!/bin/bash
cd "c:/Claude Projects/Supplements Production Line/healthfare-tracker/scripts/analyst"

START_TIME=$(date +%s)
LOOP_DURATION=2400
responded_count=0

while true; do
  current_time=$(date +%s)
  elapsed=$((current_time - START_TIME))
  
  if [ $elapsed -ge $LOOP_DURATION ]; then
    echo "Loop concluído após ~40 minutos"
    break
  fi
  
  date "+%H:%M:%S" > _watch/haiku-alive.txt
  
  if [ -f _watch/inbox.jsonl ]; then
    current_lines=$(wc -l < _watch/inbox.jsonl)
    current_cursor=$(cat _watch/haiku-cursor.txt 2>/dev/null || echo "40")
    
    if [ $current_lines -gt $current_cursor ]; then
      echo "[$(date +'%H:%M:%S')] Detectadas novas mensagens: $((current_lines - current_cursor))"
      echo "$current_lines" > _watch/haiku-cursor.txt
    fi
  else
    break
  fi
  
  sleep 15
done
