#!/bin/bash
# ダブルクリックで AR Marker Studio のローカル版を立ち上げる。
# Finder からこのファイルを開くと、ターミナルが1枚開いてサーバが動く。
# 終わるときはそのウインドウを閉じる（または Ctrl+C）。

cd "$(dirname "$0")" || exit 1

clear
echo "AR Marker Studio ローカル版"
echo "------------------------------------------"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node が見つかりません。"
  echo "  https://nodejs.org からインストールしてください（v20 以上）。"
  echo
  echo "  Enter キーで閉じます。"
  read -r
  exit 1
fi

PORT="${PORT:-8790}"

# 既に動いていれば、立ち上げ直さずにブラウザだけ開く
if curl -s "http://localhost:$PORT/local/ping" >/dev/null 2>&1; then
  echo
  echo "  すでに起動しています。ブラウザを開きます。"
  echo "  → http://localhost:$PORT/"
  open "http://localhost:$PORT/"
  echo
  echo "  Enter キーでこのウインドウを閉じます。"
  read -r
  exit 0
fi

# サーバを起こしてから、応答を確認してブラウザを開く
node local/server.js &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT

for _ in $(seq 1 30); do
  if curl -s "http://localhost:$PORT/local/ping" >/dev/null 2>&1; then
    open "http://localhost:$PORT/"
    break
  fi
  sleep 0.5
done

wait $SERVER_PID
