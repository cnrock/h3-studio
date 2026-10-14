#!/usr/bin/env bash
# 为所有「有 tag、但没有 GitHub Release」的版本补建 Release。
# 正文自动从 CHANGELOG.md 取该版本段落。不需要 GitHub Actions。
#
# 用法（token 只从环境变量读，不写进任何文件、不进聊天）：
#   export GITHUB_TOKEN=ghp_xxx        # 需要 Contents: Read and write
#   bash scripts/backfill-releases.sh            # 只补缺失的（推荐）
#   bash scripts/backfill-releases.sh v1.9.2 v1.8 # 只补指定版本
#   DRY_RUN=1 bash scripts/backfill-releases.sh  # 只看会建哪些、正文长啥样，不真建
set -euo pipefail

REPO="cnrock/h3-studio"
API="https://api.github.com/repos/$REPO"
: "${GITHUB_TOKEN:?请先 export GITHUB_TOKEN=... （需 Contents: Read and write）}"
DRY_RUN="${DRY_RUN:-0}"

command -v curl >/dev/null || { echo "需要 curl"; exit 1; }
command -v python3 >/dev/null || { echo "需要 python3（仅用于解析 JSON）"; exit 1; }

api() { curl -sS -m 30 -H "Authorization: Bearer $GITHUB_TOKEN" \
        -H "Accept: application/vnd.github+json" "$@"; }

# 取版本段落：从 "## <tag>" 到下一个 "## " 之前
notes_for() {
  awk -v tag="$1" '
    /^##[ \t]/ {
      if (grab) exit
      line=$0; sub(/^##[ \t]+/, "", line)
      n=split(line, a, /[ \t]/)
      if (n>0 && a[1]==tag) { grab=1; next }
    }
    grab { print }
  ' CHANGELOG.md
}

if [ "$#" -gt 0 ]; then
  TAGS=("$@")
else
  mapfile -t TAGS < <(git tag -l 'v*' --sort=v:refname)
fi

created=0; skipped=0; failed=0
for TAG in "${TAGS[@]}"; do
  code=$(curl -sS -m 20 -o /dev/null -w "%{http_code}" \
         -H "Authorization: Bearer $GITHUB_TOKEN" "$API/releases/tags/$TAG" || echo 000)
  if [ "$code" = "200" ]; then
    echo "跳过（已有 Release）: $TAG"; skipped=$((skipped+1)); continue
  fi

  body=$(notes_for "$TAG")
  [ -n "$body" ] || body="（CHANGELOG.md 未找到 $TAG 段落，正文留空）"

  if [ "$DRY_RUN" = "1" ]; then
    echo "== [DRY] 将创建 $TAG =="; printf '%s\n' "$body" | head -4; echo "..."
    created=$((created+1)); continue
  fi

  payload=$(BODY="$body" TAG="$TAG" python3 -c 'import json,os;print(json.dumps({"tag_name":os.environ["TAG"],"name":os.environ["TAG"]+" 更新","body":os.environ["BODY"],"draft":False,"prerelease":False}))')
  resp=$(api -X POST "$API/releases" -d "$payload")
  url=$(printf '%s' "$resp" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("html_url") or "")' 2>/dev/null || true)
  if [ -n "$url" ]; then
    echo "已创建 $TAG -> $url"; created=$((created+1))
  else
    echo "失败 $TAG: $(printf '%s' "$resp" | head -c 300)"; failed=$((failed+1))
  fi
done

echo "----"
echo "新建 $created · 跳过 $skipped · 失败 $failed"
[ "$failed" -eq 0 ]
